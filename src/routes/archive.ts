import { Router } from 'express';
import type { Db, ObjectId } from 'mongodb';

import { rightsAtEntry } from '../auth/access.ts';
import { ARCHIVE_KINDS, type ArchiveKind } from '../db/archive/definitions.ts';
import { findEntry, listEntries, restoreEntry } from '../db/archive/move.ts';
import { archiveOf } from '../db/client.ts';
import type { Actor } from '../model/actor.ts';
import type { Right } from '../model/right.ts';
import { actorOf, fail, guard, idOf, requireId } from './http.ts';

/** What was archived, and bringing it back; archiving itself sits with each kind's routes. */
export function archiveRoutes(db: Db, recheckAccess: () => Promise<void>): Router {
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

  return routes;
}

/** Whether a query value names a kind that can be archived. */
function isArchiveKind(raw: unknown): raw is ArchiveKind {
  return (ARCHIVE_KINDS as readonly unknown[]).includes(raw);
}
