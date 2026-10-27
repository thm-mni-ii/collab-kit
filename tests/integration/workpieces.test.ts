import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  createWorkpiece,
  workpieceExists,
  findWorkpiece,
} from '../../src/db/collections/workpieces.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_workpieces_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let storage: Storage;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('workpieces', () => {
  it('is born empty, without a state', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });

    expect(created).toMatchObject({ name: 'Entwurf', createdBy: 'alice', contract: {} });
    expect(await findWorkpiece(storage.db, created._id)).toEqual(created);
  });

  it('keeps the contract of the tool untouched', async () => {
    const contract = { unit: 'statement', identifiedBy: 'id', nested: { whatever: [1, 2] } };

    const created = await createWorkpiece(storage.db, {
      name: 'Entwurf',
      createdBy: 'alice',
      contract,
    });

    const stored = await findWorkpiece(storage.db, created._id);
    expect(stored?.contract).toEqual(contract);
  });

  it('answers with null for a workpiece nobody created', async () => {
    await expect(findWorkpiece(storage.db, new ObjectId())).resolves.toBeNull();
  });

  it('tells whether a workpiece is there', async () => {
    const created = await createWorkpiece(storage.db, { name: 'Entwurf', createdBy: 'alice' });

    await expect(workpieceExists(storage.db, created._id)).resolves.toBe(true);
    await expect(workpieceExists(storage.db, new ObjectId())).resolves.toBe(false);
  });
});
