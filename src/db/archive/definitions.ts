import type { IndexDescription, ObjectId } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';
import { collectionDefinitions } from '../schemas.ts';

/** The things that can be archived; everything else moves along with one of them. */
export const ARCHIVE_KINDS = ['workpiece', 'room', 'group'] as const;

export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/** A workpiece and a room it stood in. */
export interface Placement {
  workpiece: ObjectId;
  room: ObjectId;
}

/** One archived thing; its parts lie in the collections of the same name next to it. */
export interface EntryRecord {
  /** The id the thing had live, so it comes back under the same one. */
  _id: ObjectId;
  kind: ArchiveKind;
  name: string;
  /** Who archived it is in the event workpiece-archived, where pseudonyms are kept. */
  archivedAt: Date;
  reason?: string;
  /** The rooms a workpiece and its forks stood in, to put each back where it was. */
  rooms?: Placement[];
  /** The forks that went along with a workpiece, at any depth. */
  forks?: ObjectId[];
  /** The grants this entry holds, as a grant hangs on a group and a place at once. */
  grants: ObjectId[];
}

export const entriesDefinition: CollectionDefinition = {
  name: 'entries',
  schema: {
    bsonType: 'object',
    required: ['kind', 'name', 'archivedAt', 'grants'],
    properties: {
      kind: { enum: [...ARCHIVE_KINDS] },
      name: { bsonType: 'string' },
      archivedAt: { bsonType: 'date' },
      reason: { bsonType: 'string' },
      rooms: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['workpiece', 'room'],
          properties: { workpiece: { bsonType: 'objectId' }, room: { bsonType: 'objectId' } },
        },
      },
      forks: { bsonType: 'array', items: { bsonType: 'objectId' } },
      grants: { bsonType: 'array', items: { bsonType: 'objectId' } },
    },
  },
  compressor: 'zstd',
};

/** The live collections that move, each with only the indexes restore and delete look up by. */
const lookups: Readonly<Record<string, readonly IndexDescription[]>> = {
  workpieces: [],
  updates: [{ key: { workpieceId: 1, _id: 1 }, name: 'workpiece_stream' }],
  snapshots: [{ key: { workpieceId: 1 }, name: 'workpiece' }],
  pseudonyms: [{ key: { 'about.id': 1 }, name: 'about_id' }],
  comments: [{ key: { 'anchor.id': 1 }, name: 'anchor_id' }],
  tasks: [
    { key: { 'anchor.id': 1 }, name: 'anchor_id' },
    { key: { parentId: 1 }, name: 'parent_id' },
  ],
  // Found through the ids their entry lists.
  grants: [],
  events: [
    { key: { 'anchor.id': 1 }, name: 'anchor_id' },
    { key: { 'about.id': 1 }, name: 'about_id' },
  ],
  rooms: [],
  groups: [],
};

/** A live collection as the archive keeps it: same schema, so whatever live holds can move. */
function archived(definition: CollectionDefinition): CollectionDefinition {
  return { ...definition, indexes: lookups[definition.name] ?? [], compressor: 'zstd' };
}

/** The archive: the live collections that move, plus the entries that list what was archived. */
export const archiveDefinitions: readonly CollectionDefinition[] = [
  ...collectionDefinitions.filter((definition) => definition.name in lookups).map(archived),
  entriesDefinition,
];
