import { Router, type RequestHandler } from 'express';
import type { Db, ObjectId } from 'mongodb';

import { may, rightsAtEntry } from '../auth/access.ts';
import { ARCHIVE_KINDS, type ArchiveKind } from '../db/archive/definitions.ts';
import { deleteEntry, findEntry, listEntries, restoreEntry } from '../db/archive/move.ts';
import { archiveOf } from '../db/client.ts';
import type { Actor } from '../model/actor.ts';
import type { Right } from '../model/right.ts';
import { asText } from '../utils/input.ts';
import { defined } from '../utils/optional.ts';
import { actorOf, fail, guard, idOf, requireId, unusableField } from './http.ts';

/** What was archived, bringing it back and deleting it; archiving sits with each kind's routes. */
export function archiveRoutes(
  db: Db,
  recheckAccess: () => Promise<void>,
  archiveDelete: boolean,
): Router {
  const archive = archiveOf(db);
  const routes = Router();

  routes.param('id', requireId('archive entry'));

  /** The rights the actor holds at an entry; none at one that is not there. */
  async function rightsAt(actor: Actor, id: ObjectId): Promise<ReadonlySet<Right>> {
    const entry = await findEntry(archive, id);
    return entry === null ? new Set() : rightsAtEntry(db, archive, actor, entry);
  }

  // Seen by whoever saw it live, so an unseen entry answers as one that is not there.
  const seeing = guard(
    async (actor, id) => (await rightsAt(actor, id)).has('see'),
    404,
    'unknown archive entry',
  );
  // Bringing it back takes what archiving took; behind seeing, so 403 after 404.
  const restoring = guard(
    async (actor, id) => (await rightsAt(actor, id)).has('manage'),
    403,
    'not allowed to restore this entry',
  );
  // Gone for good cannot be undone, so it takes manage everywhere; behind seeing as well.
  const deleting = guard(
    async (actor) => archiveDelete && (await may(db, actor, 'manage')),
    403,
    'not allowed to delete this entry',
  );

  routes.get('/archive', async (request, response) => {
    const kind = request.query['kind'];
    if (kind !== undefined && !isArchiveKind(kind)) {
      return fail(response, 400, `kind must be one of ${ARCHIVE_KINDS.join(', ')}`);
    }

    // Each entry as the actor saw it live.
    const actor = actorOf(request);
    const entries = await listEntries(archive, kind);
    const rights = await Promise.all(
      entries.map((entry) => rightsAtEntry(db, archive, actor, entry)),
    );
    response.json(entries.filter((_, index) => rights[index]?.has('see') === true));
  });

  routes.post('/archive/:id/restore', seeing, restoring, async (request, response) => {
    const restored = await restoreEntry(db, archive, idOf(request), {
      restoredBy: actorOf(request).actorId,
    });

    // Restored by someone else in the meantime.
    if (restored === null) {
      return fail(response, 404, 'unknown archive entry');
    }
    // A room or group back opens again what it opened, so connections are asked again.
    if (restored.kind !== 'workpiece') {
      await recheckAccess();
    }
    response.json({ restored: true });
  });

  // The reason in the query, as a body on DELETE may get lost on the way.
  routes.delete('/archive/:id', seeing, deleting, async (request, response) => {
    const reason = asText(request.query['reason']);
    const unusable = unusableField(request.query, { reason });
    if (unusable !== undefined) {
      return fail(response, 400, `${unusable} is unusable`);
    }

    const deleted = await deleteEntry(db, archive, idOf(request), {
      deletedBy: actorOf(request).actorId,
      ...defined({ reason }),
    });
    // Restored or deleted by someone else in the meantime.
    if (!deleted) {
      return fail(response, 404, 'unknown archive entry');
    }
    // No recheck: the grants that went opened nothing while their place was archived.
    response.json({ deleted: true });
  });

  return routes;
}

/** Whether a query value names a kind that can be archived. */
function isArchiveKind(raw: unknown): raw is ArchiveKind {
  return (ARCHIVE_KINDS as readonly unknown[]).includes(raw);
}

/** Archiving a room, group or workpiece, which sits with the routes of each kind. */
const ARCHIVING = /^\/(rooms|groups|workpieces)\/[^/]+\/archive$/;

/** Answers 403 on every route of the archive, and on archiving, when the archive is switched off. */
export const archiveOff: RequestHandler = (request, response, next) => {
  // The archive itself, or the archiving of one thing.
  const path = request.path;
  if (path === '/archive' || path.startsWith('/archive/') || ARCHIVING.test(path)) {
    return fail(response, 403, 'the archive is switched off');
  }
  next();
};
