import type { Binary, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import * as Y from 'yjs';

import { findWorkpiece, type UnitContainer } from '../../db/collections/workpieces.ts';
import { latestSnapshot, storeSnapshot } from '../../db/collections/snapshots.ts';
import {
  appendUpdate,
  readUpdatesDeleting,
  readUpdatesSince,
} from '../../db/collections/updates.ts';
import { authorOf, stampsOf, type Author } from '../../db/collections/pseudonyms.ts';
import { defined } from '../../utils/optional.ts';

/** How far a workpiece is stored, and the queue its writes run through. */
export interface Stored {
  readonly workpieceId: ObjectId;
  /** Writes run one after another, so the stored order matches the order of arrival. */
  queue: Promise<void>;
  /** The newest update written for this workpiece, where the next snapshot ends. */
  lastUpdateId?: ObjectId;
  /** Stored since a snapshot was last laid or tried, so a failure is not retried at once. */
  updatesSinceSnapshot: number;
  /** Whether a snapshot is being made, so there is at most one per workpiece at a time. */
  snapshotting: boolean;
}

/** How many stored changes lie between two snapshots, so rebuilding a state replays no more. */
export const SNAPSHOT_EVERY = 200;

/** A stored state rebuilt in memory, and how far it reaches. */
interface Rebuilt {
  readonly doc: Y.Doc;
  /** The last change it holds; undefined while there is none. */
  readonly upToUpdateId?: ObjectId;
  /** Changes it holds after the last snapshot that was there or tried on the way. */
  readonly sinceSnapshot: number;
}

/** Rebuilds the workpiece and says where its units lie; the newest state, as every state comes. */
export async function loadWorkpiece(
  db: Db,
  logger: Logger,
  workpieceId: ObjectId,
): Promise<{
  readonly doc: Y.Doc;
  readonly stored: Stored;
  readonly units: readonly UnitContainer[];
}> {
  const record = await findWorkpiece(db, workpieceId);

  if (record === null) {
    throw new Error(`unknown workpiece ${workpieceId.toHexString()}`);
  }

  const { doc, upToUpdateId, sinceSnapshot } = await rebuild(db, logger, workpieceId);

  // How far it is stored: the newest change, and how many came after the last snapshot.
  const stored: Stored = {
    workpieceId,
    queue: Promise.resolve(),
    updatesSinceSnapshot: sinceSnapshot,
    snapshotting: false,
    ...defined({ lastUpdateId: upToUpdateId }),
  };

  return { doc, stored, units: record.units };
}

/** A stored state as one Yjs update: as it stood after the change at, or the newest one. */
export async function readStateAt(
  db: Db,
  logger: Logger,
  workpieceId: ObjectId,
  at?: ObjectId,
): Promise<{ readonly state: Uint8Array; readonly upToUpdateId?: ObjectId }> {
  const { doc, upToUpdateId } = await rebuild(db, logger, workpieceId, at);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return { state, ...defined({ upToUpdateId }) };
}

/** The newest snapshot up to at, then the stored changes after it up to at; at left out, all. */
async function rebuild(
  db: Db,
  logger: Logger,
  workpieceId: ObjectId,
  at?: ObjectId,
): Promise<Rebuilt> {
  const snapshot = await latestSnapshot(db, workpieceId, at);

  // Starts from the snapshot, if there is one; deleted containers stay as frames throughout.
  const doc = new Y.Doc({ gcFilter: keepsFrames });
  if (snapshot !== null) {
    applyStored(doc, snapshot.state, `snapshot ${snapshot._id.toHexString()}`);
  }

  // Then the changes after it, keeping the snapshot due after every SNAPSHOT_EVERY of them.
  const rows = await readUpdatesSince(db, workpieceId, snapshot?.upToUpdateId, at);
  const keeping: Promise<void>[] = [];
  let sinceSnapshot = 0;
  for (const row of rows) {
    applyStored(doc, row.bytes, `update ${row._id.toHexString()}`);
    sinceSnapshot += 1;
    if (sinceSnapshot === SNAPSHOT_EVERY) {
      keeping.push(keepSnapshot(db, logger, workpieceId, row._id, Y.encodeStateAsUpdate(doc)));
      sinceSnapshot = 0;
    }
  }
  await Promise.all(keeping);

  return {
    doc,
    sinceSnapshot,
    ...defined({ upToUpdateId: rows.at(-1)?._id ?? snapshot?.upToUpdateId }),
  };
}

/** Stores a snapshot made from the stored chain; a failure is only logged, it costs only time. */
async function keepSnapshot(
  db: Db,
  logger: Logger,
  workpieceId: ObjectId,
  upToUpdateId: ObjectId,
  state: Uint8Array,
): Promise<void> {
  try {
    await storeSnapshot(db, { workpieceId, upToUpdateId, state });
  } catch (error) {
    logger.error(
      { err: error, workpieceId: workpieceId.toHexString() },
      'could not keep a snapshot, rebuilding replays further until the next one',
    );
  }
}

/** Keeps a deleted map, text or array as a frame, so a later change in it still finds its place. */
function keepsFrames(item: Y.Item): boolean {
  return !(item.content instanceof Y.ContentType);
}

/** Applies stored bytes; what does not apply names itself, so the row can be found. */
function applyStored(doc: Y.Doc, bytes: Binary, what: string): void {
  try {
    Y.applyUpdate(doc, new Uint8Array(bytes.buffer));
  } catch (error) {
    throw new Error(`${what} cannot be applied`, { cause: error });
  }
}

/** Runs work after everything queued before it; a failure reaches only whoever queued it. */
export function enqueue<T>(stored: Pick<Stored, 'queue'>, work: () => T | Promise<T>): Promise<T> {
  // Chained behind the last work, whatever became of it.
  const run = stored.queue.then(work);
  // The queue itself never fails, so one failure does not hold up the rest.
  stored.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Keeps one change, counts it towards the next snapshot, gives its id. Runs inside the queue. */
export async function storeUpdate(
  db: Db,
  stored: Stored,
  update: Uint8Array,
  author: Author,
): Promise<ObjectId> {
  const record = await appendUpdate(db, {
    workpieceId: stored.workpieceId,
    bytes: update,
    // Which clients bring new pieces, so whose they are can be found later.
    clients: [...Y.parseUpdateMeta(update).from.keys()],
    // Whose pieces it deleted, so who deleted one can be found later.
    deletes: [...Y.decodeUpdate(update).ds.clients.keys()],
    createdBy: author.actorId,
    anonymous: stampsOf([author]),
  });

  // The newest stored change is where the next snapshot ends.
  stored.lastUpdateId = record._id;
  stored.updatesSinceSnapshot += 1;
  return record._id;
}

/** Who deleted this piece: the author of the one stored change whose deletions hold it. */
export async function deleterOf(
  db: Db,
  workpieceId: ObjectId,
  id: { readonly client: number; readonly clock: number },
): Promise<Author | undefined> {
  // Each piece is deleted by one stored change, so the first that holds it is the one.
  for await (const row of readUpdatesDeleting(db, workpieceId, id.client)) {
    if (Y.isDeleted(Y.decodeUpdate(new Uint8Array(row.bytes.buffer)).ds, id)) {
      return authorOf(row);
    }
  }
  return undefined;
}

/** Lays the snapshot due up to this stored change, from the database, never from a Y.Doc. */
export async function snapshotUpTo(
  db: Db,
  logger: Logger,
  workpieceId: ObjectId,
  upTo: ObjectId,
): Promise<void> {
  // Rebuilding up to it keeps the snapshot it passes, as reading does.
  const { doc } = await rebuild(db, logger, workpieceId, upTo);
  doc.destroy();
}
