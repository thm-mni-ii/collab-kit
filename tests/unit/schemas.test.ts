import { describe, expect, it } from 'vitest';

import { archiveDefinitions } from '../../src/db/archive/definitions.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';

describe('collectionDefinitions', () => {
  it('names every collection exactly once', () => {
    const names = collectionDefinitions.map((definition) => definition.name);

    expect(names).toEqual([
      'actors',
      'comments',
      'workpieces',
      'events',
      'grants',
      'groups',
      'pseudonyms',
      'rooms',
      'settings',
      'snapshots',
      'tasks',
      'updates',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every collection as an object', () => {
    for (const definition of collectionDefinitions) {
      expect(definition.schema['bsonType']).toBe('object');
    }
  });

  it('gives every index a name of its own', () => {
    for (const definition of collectionDefinitions) {
      const names = (definition.indexes ?? []).map((index) => index.name);

      expect(names.every((name) => name !== undefined)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('archiveDefinitions', () => {
  it('names the collections that move, plus entries', () => {
    expect(archiveDefinitions.map((definition) => definition.name)).toEqual([
      'comments',
      'workpieces',
      'events',
      'grants',
      'groups',
      'pseudonyms',
      'rooms',
      'snapshots',
      'tasks',
      'updates',
      'entries',
    ]);
  });

  it('packs every collection with zstd', () => {
    for (const definition of archiveDefinitions) {
      expect(definition.compressor).toBe('zstd');
    }
  });

  it('keeps the schema and validation of the live collection', () => {
    for (const definition of archiveDefinitions) {
      const live = collectionDefinitions.find((candidate) => candidate.name === definition.name);
      if (live !== undefined) {
        expect(definition.schema).toBe(live.schema);
        expect(definition.validationAction).toBe(live.validationAction);
      }
    }
  });

  it('gives every index a name of its own', () => {
    for (const definition of archiveDefinitions) {
      const names = (definition.indexes ?? []).map((index) => index.name);

      expect(names.every((name) => name !== undefined)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
