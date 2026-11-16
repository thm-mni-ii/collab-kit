import type { ClientSession, Db, Document, Filter, ObjectId } from 'mongodb';

import { eventStamps } from '../../auth/anonymity.ts';
import { defined } from '../../utils/optional.ts';
import {
  inTransaction,
  recordEvent,
  writeReturningEvents,
  type NewEvent,
} from '../collections/events.ts';
import type { RoomRecord } from '../collections/rooms.ts';
import type { SnapshotRecord } from '../collections/snapshots.ts';
import type { WorkpieceRecord } from '../collections/workpieces.ts';
import type { ArchiveKind, EntryRecord, Placement } from './definitions.ts';

/** Events that tell of the archive itself; they stay live, so the trace outlasts the thing. */
const STAYING = [
  'workpiece-archived',
  'workpiece-restored',
  'room-archived',
  'room-restored',
  'group-archived',
  'group-restored',
];

/** The collection each kind lives in, live and in the archive alike. */
const COLLECTION_OF = {
  workpiece: 'workpieces',
  room: 'rooms',
  group: 'groups',
} as const satisfies Record<ArchiveKind, string>;

/** The comments and tasks found under a set of things. */
interface Chain {
  readonly comments: ObjectId[];
  readonly tasks: ObjectId[];
}

/** Who archives, and why. */
export interface Archiving {
  readonly archivedBy: string;
  readonly reason?: string;
}

/** What archiving a workpiece takes on top: its forks at any depth. */
export interface WorkpieceArchiving extends Archiving {
  readonly forks: readonly ObjectId[];
}

/** Who brings an entry back. */
export interface Restoring {
  readonly restoredBy: string;
}

/** What only a workpiece writes into its entry. */
type Extra = Pick<EntryRecord, 'rooms' | 'forks'>;

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

/** Moves the workpiece and its forks with their changes and all that hangs on them. */
export async function archiveWorkpiece(
  db: Db,
  archive: Db,
  workpieceId: ObjectId,
  input: WorkpieceArchiving,
  now = new Date(),
): Promise<EntryRecord | undefined> {
  const ids: [ObjectId, ...ObjectId[]] = [workpieceId, ...input.forks];

  return archiveOne(db, archive, 'workpiece', ids, input, now, async (session) => {
    // Where each one stood, live or in an archived room, then out of all of them.
    const rooms = [
      ...(await placementsOf(db, ids, session)),
      ...(await placementsOf(archive, ids, session)),
    ];
    await pullFromRooms(db, ids, session);
    await pullFromRooms(archive, ids, session);

    await move(db, archive, 'updates', { workpieceId: { $in: ids } }, session);
    await keepNewestSnapshots(db, archive, ids, session);
    return { rooms, forks: [...input.forks] };
  });
}

/** Moves the room with all that hangs on it; its workpieces stay live. */
export async function archiveRoom(
  db: Db,
  archive: Db,
  roomId: ObjectId,
  input: Archiving,
  now = new Date(),
): Promise<EntryRecord | undefined> {
  return archiveOne(db, archive, 'room', [roomId], input, now);
}

/** Moves the group with its members and all that hangs on it; its grants stay live. */
export async function archiveGroup(
  db: Db,
  archive: Db,
  groupId: ObjectId,
  input: Archiving,
  now = new Date(),
): Promise<EntryRecord | undefined> {
  return archiveOne(db, archive, 'group', [groupId], input, now);
}

/** Brings an entry back under its ids, whatever its kind; null if there is none. */
export async function restoreEntry(
  db: Db,
  archive: Db,
  entryId: ObjectId,
  input: Restoring,
): Promise<EntryRecord | null> {
  const entry = await inTransaction(db, async (session) => {
    const found = await archive
      .collection<EntryRecord>('entries')
      .findOneAndDelete({ _id: entryId }, { session });
    if (found === null) {
      return null;
    }

    const ids = [found._id, ...(found.forks ?? [])];
    await moveWithChain(archive, db, COLLECTION_OF[found.kind], ids, session);
    if (found.kind === 'workpiece') {
      await move(archive, db, 'updates', { workpieceId: { $in: ids } }, session);
      await move(archive, db, 'snapshots', { workpieceId: { $in: ids } }, session);
      await placeBack(db, archive, found.rooms ?? [], session);
    }
    if (found.kind === 'room') {
      await keepLiveWorkpieces(db, found._id, session);
    }
    return found;
  });
  if (entry === null) {
    return null;
  }

  // Only now: a pseudonym drawn inside the transaction would clash with the one coming back.
  await recordEvent(db, {
    kind: `${entry.kind}-restored`,
    createdBy: input.restoredBy,
    anchor: { kind: entry.kind, id: entry._id },
    detail: { name: entry.name, ...defined({ forks: entry.forks }) },
  });
  return entry;
}

/** Moves one thing of a kind, writes its entry and its event; extra moves what only its kind has. */
async function archiveOne(
  db: Db,
  archive: Db,
  kind: ArchiveKind,
  ids: readonly [ObjectId, ...ObjectId[]],
  input: Archiving,
  now: Date,
  extra: (session: ClientSession) => Promise<Extra> = async () => ({}),
): Promise<EntryRecord | undefined> {
  const [id] = ids;
  const event: NewEvent = {
    kind: `${kind}-archived`,
    createdBy: input.archivedBy,
    anchor: { kind, id },
    ...defined({ reason: input.reason }),
  };
  // Drawn while the thing is live, so a new pseudonym moves along with the others.
  const anonymous = await eventStamps(db, event);

  let entry: EntryRecord | undefined;
  await writeReturningEvents(
    db,
    async (session) => {
      const thing = await db
        .collection<{ name: string }>(COLLECTION_OF[kind])
        .findOne({ _id: id }, { session, projection: { name: 1 } });
      if (thing === null) {
        return [];
      }

      const kept = await extra(session);
      await moveWithChain(db, archive, COLLECTION_OF[kind], ids, session);

      entry = {
        _id: id,
        kind,
        name: thing.name,
        archivedAt: now,
        ...defined({ reason: input.reason }),
        ...kept,
      };
      await archive.collection<EntryRecord>('entries').insertOne(entry, { session });

      const detail = { name: thing.name, ...defined({ forks: kept.forks }) };
      return [{ ...event, detail, anonymous }];
    },
    now,
  );
  return entry;
}

/** Moves the things, their chain, pseudonyms and events; grants stay where they are. */
async function moveWithChain(
  from: Db,
  to: Db,
  collection: string,
  ids: readonly ObjectId[],
  session: ClientSession,
): Promise<void> {
  const chain = await chainUnder(from, ids, session);
  const all = [...ids, ...chain.comments, ...chain.tasks];

  // One after another: a transaction runs one operation at a time.
  await move(from, to, collection, { _id: { $in: [...ids] } }, session);
  await move(from, to, 'comments', { _id: { $in: chain.comments } }, session);
  await move(from, to, 'tasks', { _id: { $in: chain.tasks } }, session);
  await move(from, to, 'pseudonyms', { 'about.id': { $in: [...ids] } }, session);
  await move(
    from,
    to,
    'events',
    {
      $or: [{ 'anchor.id': { $in: all } }, { 'about.id': { $in: [...ids] } }],
      kind: { $nin: STAYING },
    },
    session,
  );
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

/** The rooms of this database each of these workpieces stands in. */
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

/** Takes the workpieces out of every room of this database, so no room points at nothing. */
async function pullFromRooms(
  db: Db,
  ids: readonly ObjectId[],
  session: ClientSession,
): Promise<void> {
  await db
    .collection<RoomRecord>('rooms')
    .updateMany(
      { workpieces: { $in: [...ids] } },
      { $pullAll: { workpieces: [...ids] } },
      { session },
    );
}

/** Back into each room, live or archived; a room deleted meanwhile is left out. */
async function placeBack(
  db: Db,
  archive: Db,
  placements: readonly Placement[],
  session: ClientSession,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const { room, workpiece } of placements) {
    for (const where of [db, archive]) {
      await where
        .collection<RoomRecord>('rooms')
        .updateOne({ _id: room }, { $addToSet: { workpieces: workpiece } }, { session });
    }
  }
  /* eslint-enable no-await-in-loop */
}

/** Keeps only the workpieces of a room that are live; the others went to the archive meanwhile. */
async function keepLiveWorkpieces(db: Db, roomId: ObjectId, session: ClientSession): Promise<void> {
  const rooms = db.collection<RoomRecord>('rooms');
  const room = await rooms.findOne({ _id: roomId }, { session, projection: { workpieces: 1 } });
  if (room === null) {
    return;
  }

  // In the order the room had them.
  const live = await idsOf(db, 'workpieces', { _id: { $in: room.workpieces } }, session);
  const kept = new Set(live.map((id) => id.toHexString()));
  const workpieces = room.workpieces.filter((id) => kept.has(id.toHexString()));
  await rooms.updateOne({ _id: roomId }, { $set: { workpieces } }, { session });
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

/** Copies what the filter finds over to the other database and deletes it where it was. */
async function move(
  from: Db,
  to: Db,
  name: string,
  filter: Filter<Document>,
  session: ClientSession,
): Promise<void> {
  const found = await from.collection(name).find(filter, { session }).toArray();
  if (found.length === 0) {
    return;
  }

  await to.collection(name).insertMany(found, { session });
  await from
    .collection(name)
    .deleteMany({ _id: { $in: found.map((document) => document._id) } }, { session });
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
