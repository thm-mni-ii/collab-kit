import { ObjectId, type Db, type Document } from 'mongodb';

import { defined } from '../../utils/optional.ts';
import type { CollectionDefinition } from '../apply.ts';
import { stampField, stampsSchema, type Stamp } from './pseudonyms.ts';

/** A Y.Map whose keys are the units, at a path of map keys that starts at a root type. */
export interface UnitContainer {
  path: string[];
}

/** Where a fork comes from: the workpiece and the last change of it the fork took along. */
export interface ForkOrigin {
  id: ObjectId;
  /** Absent if the source had no change yet. */
  at?: ObjectId;
}

/** One row per Y.Doc; its content is the update stream, snapshots are only a shortcut. */
export interface WorkpieceRecord {
  _id: ObjectId;
  name: string;
  /** What the tool registered while docking. The service never reads into it. */
  contract: Document;
  /** Where the tool keeps its units, so conflicts hang on the unit they hit; empty if nowhere. */
  units: UnitContainer[];
  /** Only at a fork: where it was forked from. */
  forkOf?: ForkOrigin;
  createdAt: Date;
  createdBy: string;
  /** Whether whoever created it wrote anonymously, with the pseudonym; decided when they did. */
  anonymous?: Stamp[];
}

export const workpiecesDefinition: CollectionDefinition = {
  name: 'workpieces',
  schema: {
    bsonType: 'object',
    required: ['name', 'contract', 'units', 'createdAt', 'createdBy'],
    properties: {
      name: { bsonType: 'string' },
      contract: {
        bsonType: 'object',
        description: 'what the tool registered while docking, deliberately unconstrained',
      },
      units: {
        bsonType: 'array',
        maxItems: 20,
        description: 'the maps whose keys are units, each at a path of keys from a root type',
        items: {
          bsonType: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: {
            path: { bsonType: 'array', minItems: 1, maxItems: 10, items: { bsonType: 'string' } },
          },
        },
      },
      forkOf: {
        bsonType: 'object',
        description: 'only at a fork: the source and the last change of it taken along',
        required: ['id'],
        properties: {
          id: { bsonType: 'objectId' },
          at: { bsonType: 'objectId', description: 'absent if the source had no change yet' },
        },
      },
      createdAt: { bsonType: 'date' },
      createdBy: { bsonType: 'string' },
      anonymous: stampsSchema,
    },
  },
  // Whose forks a workpiece is, as the own forks lend their source.
  indexes: [{ key: { createdBy: 1 }, name: 'created_by' }],
};

export interface NewWorkpiece {
  /** Chosen beforehand when its history is written first, as for a fork. */
  readonly id?: ObjectId;
  readonly name: string;
  readonly createdBy: string;
  readonly contract?: Document;
  readonly units?: UnitContainer[];
  readonly forkOf?: ForkOrigin;
  /** Whether its creator writes anonymously, decided by the route; left out, openly. */
  readonly anonymous?: readonly Stamp[];
}

/** Creates an empty workpiece without a start state: every change, even the first, is an update. */
export async function createWorkpiece(
  db: Db,
  input: NewWorkpiece,
  now = new Date(),
): Promise<WorkpieceRecord> {
  const created: WorkpieceRecord = {
    _id: input.id ?? new ObjectId(),
    name: input.name,
    contract: input.contract ?? {},
    units: input.units ?? [],
    ...defined({ forkOf: input.forkOf }),
    createdAt: now,
    createdBy: input.createdBy,
    ...stampField(input.anonymous ?? []),
  };

  await db.collection<WorkpieceRecord>('workpieces').insertOne(created);
  return created;
}

/** A workpiece as a thing, as it is stored. */
export type Workpiece = WorkpieceRecord;

/** The workpiece, or null if nobody created it. */
export async function findWorkpiece(db: Db, id: ObjectId): Promise<Workpiece | null> {
  return db.collection<WorkpieceRecord>('workpieces').findOne({ _id: id });
}

/** These workpieces, or every one when no keys are named. */
export async function findWorkpieces(db: Db, ids?: readonly ObjectId[]): Promise<Workpiece[]> {
  const filter = ids === undefined ? {} : { _id: { $in: [...ids] } };

  return db.collection<WorkpieceRecord>('workpieces').find(filter).toArray();
}

/** Whether the workpiece is there, reading nothing but its key. */
export async function workpieceExists(db: Db, id: ObjectId): Promise<boolean> {
  const found = await db
    .collection<WorkpieceRecord>('workpieces')
    .findOne({ _id: id }, { projection: { _id: 1 } });

  return found !== null;
}

/** Where the workpiece was forked from, if this actor forked it; anything else has no source. */
export async function sourceOfOwnFork(
  db: Db,
  id: ObjectId,
  actorId: string,
): Promise<ObjectId | undefined> {
  const found = await db
    .collection<WorkpieceRecord>('workpieces')
    .findOne({ _id: id, createdBy: actorId }, { projection: { forkOf: 1 } });

  return found?.forkOf?.id;
}

/** Every fork this actor made, as keys only. */
export async function ownForks(db: Db, actorId: string): Promise<ObjectId[]> {
  const found = await db
    .collection<WorkpieceRecord>('workpieces')
    .find({ createdBy: actorId, forkOf: { $exists: true } }, { projection: { _id: 1 } })
    .toArray();

  return found.map((workpiece) => workpiece._id);
}
