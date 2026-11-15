import type { Db, Document } from 'mongodb';

import type { CollectionDefinition } from '../apply.ts';

/** What a settings key may hold, so it stands in a URL as it is. */
export const SETTINGS_KEY = /^[A-Za-z0-9_-]+$/;

/** One area of settings, named by the tool; the service never reads what values holds. */
export interface SettingsRecord {
  _id: string;
  values: Document;
  updatedBy: string;
  updatedAt: Date;
}

export const settingsDefinition: CollectionDefinition = {
  name: 'settings',
  schema: {
    bsonType: 'object',
    required: ['_id', 'values', 'updatedBy', 'updatedAt'],
    properties: {
      _id: { bsonType: 'string', pattern: SETTINGS_KEY.source },
      values: { bsonType: 'object', description: 'the tool decides what goes in here' },
      updatedBy: { bsonType: 'string' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

/** The names of every stored area, in order. */
export async function listSettingKeys(db: Db): Promise<string[]> {
  const found = await db
    .collection<SettingsRecord>('settings')
    .find({}, { projection: { _id: 1 }, sort: { _id: 1 } })
    .toArray();
  return found.map(({ _id }) => _id);
}

/** The values of an area; undefined while there is none. */
export async function findSettings(db: Db, key: string): Promise<Document | undefined> {
  const found = await db
    .collection<SettingsRecord>('settings')
    .findOne({ _id: key }, { projection: { values: 1 } });
  return found?.values;
}

/** Replaces the values of an area as a whole, creating it if it is new. */
export async function replaceSettings(
  db: Db,
  key: string,
  values: Document,
  actorId: string,
): Promise<void> {
  await db
    .collection<SettingsRecord>('settings')
    .replaceOne(
      { _id: key },
      { values, updatedBy: actorId, updatedAt: new Date() },
      { upsert: true },
    );
}

/** Removes an area; one that is missing is no mistake. */
export async function removeSettings(db: Db, key: string): Promise<void> {
  await db.collection<SettingsRecord>('settings').deleteOne({ _id: key });
}
