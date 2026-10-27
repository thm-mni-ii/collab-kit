import { Binary, MongoServerError, ObjectId, type Db } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** A workpiece as it stood after one stored change; only a shortcut, the truth is the updates. */
export interface SnapshotRecord {
  _id: ObjectId;
  workpieceId: ObjectId;
  /** The last update it contains; nothing after it is in state. */
  upToUpdateId: ObjectId;
  /** The Yjs state up to that update, produced by Yjs, opaque here. */
  state: Binary;
  createdAt: Date;
}

export const snapshotsDefinition: CollectionDefinition = {
  name: 'snapshots',
  schema: {
    bsonType: 'object',
    required: ['workpieceId', 'upToUpdateId', 'state', 'createdAt'],
    properties: {
      workpieceId: { bsonType: 'objectId' },
      upToUpdateId: { bsonType: 'objectId', description: 'the last update contained in state' },
      state: { bsonType: 'binData', description: 'Yjs state, opaque to the service' },
      createdAt: { bsonType: 'date' },
    },
  },
  // One per change, and the newest up to a change found by the index alone.
  indexes: [{ key: { workpieceId: 1, upToUpdateId: 1 }, name: 'workpiece_upto', unique: true }],
};

export interface NewSnapshot {
  readonly workpieceId: ObjectId;
  readonly upToUpdateId: ObjectId;
  readonly state: Uint8Array;
}

/** Keeps a snapshot; if one up to the same change is there already, that one stays. */
export async function storeSnapshot(
  db: Db,
  input: NewSnapshot,
  now = new Date(),
): Promise<boolean> {
  try {
    await db.collection<SnapshotRecord>('snapshots').insertOne({
      _id: new ObjectId(),
      workpieceId: input.workpieceId,
      upToUpdateId: input.upToUpdateId,
      state: new Binary(input.state),
      createdAt: now,
    });
    return true;
  } catch (error) {
    // Made by somebody else meanwhile, from the same chain, so the first one is as good.
    if (error instanceof MongoServerError && error.code === 11000) {
      return false;
    }
    throw error;
  }
}

/** The newest snapshot up to and including the given change, or the newest of all. */
export async function latestSnapshot(
  db: Db,
  workpieceId: ObjectId,
  upTo?: ObjectId,
): Promise<SnapshotRecord | null> {
  const filter =
    upTo === undefined ? { workpieceId } : { workpieceId, upToUpdateId: { $lte: upTo } };

  return db.collection<SnapshotRecord>('snapshots').findOne(filter, { sort: { upToUpdateId: -1 } });
}
