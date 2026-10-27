import { ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { appendUpdate, readUpdatesSince } from '../../src/db/collections/updates.ts';
import { loadWorkpiece } from '../../src/realtime/hub/persistence.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_updates_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;

async function freshWorkpiece(): Promise<ObjectId> {
  return (await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' }))._id;
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('the stream of updates', () => {
  it('reads everything from the beginning when no cut is given', async () => {
    const workpieceId = await freshWorkpiece();

    const first = await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([1]),
      clients: [],
      createdBy: 'alice',
    });
    await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([2]),
      clients: [],
      createdBy: 'bob',
    });

    const all = await readUpdatesSince(storage.db, workpieceId);
    expect(all.map((row) => row.createdBy)).toEqual(['alice', 'bob']);

    const after = await readUpdatesSince(storage.db, workpieceId, first._id);
    expect(after.map((row) => row.createdBy)).toEqual(['bob']);
  });

  it('reads up to and including the upper bound, after the lower one if given', async () => {
    const workpieceId = await freshWorkpiece();
    const rows = [];
    for (const createdBy of ['alice', 'bob', 'carol']) {
      rows.push(
        // eslint-disable-next-line no-await-in-loop
        await appendUpdate(storage.db, {
          workpieceId,
          bytes: new Uint8Array([1]),
          clients: [],
          createdBy,
        }),
      );
    }
    const authors = async (since?: ObjectId, until?: ObjectId) =>
      (await readUpdatesSince(storage.db, workpieceId, since, until)).map((row) => row.createdBy);

    expect(await authors(undefined, rows[1]!._id)).toEqual(['alice', 'bob']);
    expect(await authors(rows[0]!._id, rows[1]!._id)).toEqual(['bob']);
    expect(await authors(rows[1]!._id, rows[1]!._id)).toEqual([]);
  });

  it('keeps the updates of other workpieces out', async () => {
    const mine = await freshWorkpiece();
    const other = await freshWorkpiece();

    await appendUpdate(storage.db, {
      workpieceId: other,
      bytes: new Uint8Array([1]),
      clients: [],
      createdBy: 'alice',
    });

    await expect(readUpdatesSince(storage.db, mine)).resolves.toEqual([]);
  });
});

describe('loading', () => {
  it('names the stored change that cannot be applied, so it can be found', async () => {
    const workpieceId = await freshWorkpiece();
    const broken = await appendUpdate(storage.db, {
      workpieceId,
      bytes: new Uint8Array([1, 2, 3]),
      clients: [],
      createdBy: 'alice',
    });

    await expect(loadWorkpiece(storage.db, silent, workpieceId)).rejects.toThrowError(
      `update ${broken._id.toHexString()} cannot be applied`,
    );
  });
});
