import type { ClientSession, Db, Document, Filter, ObjectId } from 'mongodb';

import { eventStamps } from '../../auth/anonymity.ts';
import { defined } from '../../utils/optional.ts';
import {
  inTransaction,
  recordEvent,
  writeReturningEvents,
  type NewEvent,
} from '../collections/events.ts';
import type { GrantRecord } from '../collections/grants.ts';
import type { RoomRecord } from '../collections/rooms.ts';
import type { SnapshotRecord } from '../collections/snapshots.ts';
import type { WorkpieceRecord } from '../collections/workpieces.ts';
import type { ArchiveKind, EntryRecord, Placement } from './definitions.ts';

/** Events that tell of the archive itself; they stay live, so the trace outlasts the thing. */
const STAYING = ['workpiece-archived', 'workpiece-restored'];

/** The comments and tasks found under a set of things. */
interface Chain {
  readonly comments: ObjectId[];
  readonly tasks: ObjectId[];
}

/** What archiving a workpiece takes: its forks at any depth, who, and why. */
export interface WorkpieceArchiving {
  readonly forks: readonly ObjectId[];
  readonly archivedBy: string;
  readonly reason?: string;
}

/** Who brings an entry back. */
export interface Restoring {
  readonly restoredBy: string;
}

/** One entry of the archive; null once it was restored or never was. */
export async function findEntry(archive: Db, id: ObjectId): Promise<EntryRecord | null> {
  return archive.collection<EntryRecord>('entries').findOne({ _id: id });
}

/** The entries of the archive, newest first, of one kind or of all. */
export async function listEntries(archive: Db, kind?: ArchiveKind): Promise<EntryRecord[]> {
  return archive
    .collection<EntryRecord>('entries')
    .find(kind === undefined ? {} : { kind })
    .sort({ archivedAt: -1, _id: -1 })
    .toArray();
}

/** Every fork of the workpiece and of its forks, at any depth. */
export async function forksUnder(db: Db, workpieceId: ObjectId): Promise<ObjectId[]> {
  const forks: ObjectId[] = [];
  const seen = new Set([workpieceId.toHexString()]);
  let sources = [workpieceId];

  // One level per round; seen keeps a chain written by hand in a circle from running on.
  /* eslint-disable no-await-in-loop */
  while (sources.length > 0) {
    const found = await db
      .collection<WorkpieceRecord>('workpieces')
      .find({ 'forkOf.id': { $in: sources } }, { projection: { _id: 1 } })
      .toArray();
    sources = found.map((fork) => fork._id).filter((id) => !seen.has(id.toHexString()));
    for (const id of sources) {
      seen.add(id.toHexString());
    }
    forks.push(...sources);
  }
  /* eslint-enable no-await-in-loop */
  return forks;
}

/** Moves the workpiece and its forks with all that hangs on them into the archive, in one go. */
export async function archiveWorkpiece(
  db: Db,
  archive: Db,
  workpieceId: ObjectId,
  input: WorkpieceArchiving,
  now = new Date(),
): Promise<EntryRecord | undefined> {
  const ids = [workpieceId, ...input.forks];
  const event: NewEvent = {
    kind: 'workpiece-archived',
    createdBy: input.archivedBy,
    anchor: { kind: 'workpiece', id: workpieceId },
    ...defined({ reason: input.reason }),
  };
  // Drawn while the workpiece is live, so a new pseudonym moves along with the others.
  const anonymous = await eventStamps(db, event);

  let entry: EntryRecord | undefined;
  await writeReturningEvents(
    db,
    async (session) => {
      const workpiece = await db
        .collection<WorkpieceRecord>('workpieces')
        .findOne({ _id: workpieceId }, { session });
      if (workpiece === null) {
        return [];
      }

      // Where each one stood, then out of every room, so no room points at nothing.
      const rooms = await placementsOf(db, ids, session);
      await db
        .collection<RoomRecord>('rooms')
        .updateMany({ workpieces: { $in: ids } }, { $pullAll: { workpieces: ids } }, { session });

      const all = await moveWorkpieces(db, archive, ids, session);
      await keepNewestSnapshots(db, archive, ids, session);
      const grants = await move(db, archive, 'grants', { 'scope.id': { $in: all } }, session);

      entry = {
        _id: workpieceId,
        kind: 'workpiece',
        name: workpiece.name,
        archivedAt: now,
        ...defined({ reason: input.reason }),
        rooms,
        forks: [...input.forks],
        grants,
      };
      await archive.collection<EntryRecord>('entries').insertOne(entry, { session });

      return [{ ...event, detail: { name: workpiece.name, forks: [...input.forks] }, anonymous }];
    },
    now,
  );
  return entry;
}

/** Brings an archived workpiece and its forks back under their ids; false if there is no entry. */
export async function restoreWorkpiece(
  db: Db,
  archive: Db,
  entryId: ObjectId,
  input: Restoring,
): Promise<boolean> {
  const entry = await inTransaction(db, async (session) => {
    const found = await archive
      .collection<EntryRecord>('entries')
      .findOneAndDelete({ _id: entryId, kind: 'workpiece' }, { session });
    if (found === null) {
      return null;
    }

    const ids = [found._id, ...(found.forks ?? [])];
    await moveWorkpieces(archive, db, ids, session);
    await move(archive, db, 'snapshots', { workpieceId: { $in: ids } }, session);
    await restoreGrants(db, archive, found.grants, session);

    // Back into each room that is still there; a room gone meanwhile is left out.
    for (const placement of found.rooms ?? []) {
      // eslint-disable-next-line no-await-in-loop
      await db
        .collection<RoomRecord>('rooms')
        .updateOne(
          { _id: placement.room },
          { $addToSet: { workpieces: placement.workpiece } },
          { session },
        );
    }
    return found;
  });
  if (entry === null) {
    return false;
  }

  // Only now: a pseudonym drawn inside the transaction would clash with the one coming back.
  await recordEvent(db, {
    kind: 'workpiece-restored',
    createdBy: input.restoredBy,
    anchor: { kind: 'workpiece', id: entry._id },
    detail: { name: entry.name, forks: entry.forks ?? [] },
  });
  return true;
}

/** Moves the workpieces, their changes, pseudonyms, chain and events; answers with every id moved. */
async function moveWorkpieces(
  from: Db,
  to: Db,
  ids: readonly ObjectId[],
  session: ClientSession,
): Promise<ObjectId[]> {
  const chain = await chainUnder(from, ids, session);
  const all = [...ids, ...chain.comments, ...chain.tasks];

  // One after another: a transaction runs one operation at a time.
  await move(from, to, 'workpieces', { _id: { $in: ids } }, session);
  await move(from, to, 'updates', { workpieceId: { $in: ids } }, session);
  await move(from, to, 'comments', { _id: { $in: chain.comments } }, session);
  await move(from, to, 'tasks', { _id: { $in: chain.tasks } }, session);
  await move(from, to, 'pseudonyms', { 'about.id': { $in: ids } }, session);
  await move(
    from,
    to,
    'events',
    {
      $or: [{ 'anchor.id': { $in: all } }, { 'about.id': { $in: ids } }],
      kind: { $nin: STAYING },
    },
    session,
  );
  return all;
}

/** Comments and tasks hanging on these things, downwards until none is added: aboutOf upside down. */
async function chainUnder(
  db: Db,
  roots: readonly ObjectId[],
  session: ClientSession,
): Promise<Chain> {
  const chain: Chain = { comments: [], tasks: [] };
  const seen = new Set(roots.map((id) => id.toHexString()));
  let reached = [...roots];

  // A task with an anchor belongs there; only one without hangs on its parent.
  /* eslint-disable no-await-in-loop */
  while (reached.length > 0) {
    const comments = await idsOf(db, 'comments', { 'anchor.id': { $in: reached } }, session);
    const tasks = await idsOf(
      db,
      'tasks',
      {
        $or: [
          { 'anchor.id': { $in: reached } },
          { anchor: { $exists: false }, parentId: { $in: reached } },
        ],
      },
      session,
    );

    const fresh = (found: ObjectId[]) => found.filter((id) => !seen.has(id.toHexString()));
    const newComments = fresh(comments);
    const newTasks = fresh(tasks);
    reached = [...newComments, ...newTasks];
    for (const id of reached) {
      seen.add(id.toHexString());
    }
    chain.comments.push(...newComments);
    chain.tasks.push(...newTasks);
  }
  /* eslint-enable no-await-in-loop */
  return chain;
}

/** The rooms each of these workpieces stands in. */
async function placementsOf(
  db: Db,
  ids: readonly ObjectId[],
  session: ClientSession,
): Promise<Placement[]> {
  const wanted = new Set(ids.map((id) => id.toHexString()));
  const rooms = await db
    .collection<RoomRecord>('rooms')
    .find({ workpieces: { $in: [...ids] } }, { session, projection: { workpieces: 1 } })
    .toArray();

  return rooms.flatMap((room) =>
    room.workpieces
      .filter((workpiece) => wanted.has(workpiece.toHexString()))
      .map((workpiece) => ({ workpiece, room: room._id })),
  );
}

/** Only the newest snapshot of each goes along; the older ones are shortcuts nobody needs. */
async function keepNewestSnapshots(
  db: Db,
  archive: Db,
  ids: readonly ObjectId[],
  session: ClientSession,
): Promise<void> {
  const snapshots = db.collection<SnapshotRecord>('snapshots');

  /* eslint-disable no-await-in-loop */
  for (const workpieceId of ids) {
    const newest = await snapshots.findOne(
      { workpieceId },
      { session, sort: { upToUpdateId: -1 } },
    );
    if (newest !== null) {
      await archive.collection<SnapshotRecord>('snapshots').insertOne(newest, { session });
    }
  }
  /* eslint-enable no-await-in-loop */
  await snapshots.deleteMany({ workpieceId: { $in: [...ids] } }, { session });
}

/** A grant comes back while its group is live; one whose group was deleted goes for good. */
async function restoreGrants(
  db: Db,
  archive: Db,
  grantIds: readonly ObjectId[],
  session: ClientSession,
): Promise<void> {
  const held = await archive
    .collection<GrantRecord>('grants')
    .find({ _id: { $in: [...grantIds] } }, { session, projection: { groupId: 1 } })
    .toArray();
  const live = await idsOf(
    db,
    'groups',
    { _id: { $in: held.map((grant) => grant.groupId) } },
    session,
  );
  const liveGroups = new Set(live.map((id) => id.toHexString()));

  const back = held.filter((grant) => liveGroups.has(grant.groupId.toHexString()));
  await move(archive, db, 'grants', { _id: { $in: back.map((grant) => grant._id) } }, session);
  await archive
    .collection<GrantRecord>('grants')
    .deleteMany({ _id: { $in: [...grantIds] } }, { session });
}

/** Copies what the filter finds over to the other database and deletes it where it was. */
async function move(
  from: Db,
  to: Db,
  name: string,
  filter: Filter<Document>,
  session: ClientSession,
): Promise<ObjectId[]> {
  const found = await from.collection(name).find(filter, { session }).toArray();
  if (found.length === 0) {
    return [];
  }

  const ids = found.map((document) => document._id);
  await to.collection(name).insertMany(found, { session });
  await from.collection(name).deleteMany({ _id: { $in: ids } }, { session });
  return ids;
}

/** The ids of what the filter finds. */
async function idsOf(
  db: Db,
  name: string,
  filter: Filter<Document>,
  session: ClientSession,
): Promise<ObjectId[]> {
  const found = await db
    .collection(name)
    .find(filter, { session, projection: { _id: 1 } })
    .toArray();
  return found.map((document) => document._id);
}
