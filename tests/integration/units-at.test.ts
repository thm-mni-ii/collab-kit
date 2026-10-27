import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { appendUpdate } from '../../src/db/collections/updates.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_units_at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'units-at-secret';
const logger = pino({ level: 'silent' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });

// Alice is at the top and sees every workpiece, bob has no grant and sees none.
const alice = tokenFor('alice', { globalRole: 'ADMIN' });
const bob = tokenFor('bob');

let storage: Storage;
let server: ReturnType<typeof createServer>;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger });
  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub,
      checkToken: createTokenCheck({
        key: secret,
        algorithm: 'HS256',
        top: { claim: 'globalRole', values: ['ADMIN'] },
      }),
      logger,
      // No sockets in these tests, so there is nothing to ask again.
      recheckAccess: async () => {},
    }),
  });
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

/** A workpiece of alice that names these maps as holding units. */
async function workpieceWith(units: { path: string[] }[]): Promise<string> {
  const created = await request(server)
    .post('/workpieces')
    .set(as(alice))
    .send({ name: 'Modell', units });
  return created.body._id as string;
}

/** Runs each step as one change on a doc and stores it, in order; gives the ids of the changes. */
async function changed(workpieceId: string, steps: ((doc: Y.Doc) => void)[]): Promise<ObjectId[]> {
  const writer = new Y.Doc();
  const captured: Uint8Array[] = [];
  writer.on('update', (update: Uint8Array) => captured.push(update));
  for (const step of steps) {
    writer.transact(() => step(writer));
  }

  const ids: ObjectId[] = [];
  for (const bytes of captured) {
    // eslint-disable-next-line no-await-in-loop
    const stored = await appendUpdate(storage.db, {
      workpieceId: new ObjectId(workpieceId),
      bytes,
      clients: [],
      createdBy: 'alice',
    });
    ids.push(stored._id);
  }
  return ids;
}

/** What the route answers as this person, with these query parameters. */
async function unitsOf(workpieceId: string, token: string, query: Record<string, string> = {}) {
  return request(server).get(`/workpieces/${workpieceId}/units`).query(query).set(as(token));
}

describe('the units of a state as JSON', () => {
  it('hands out each named container after a change, or the newest', async () => {
    const workpieceId = await workpieceWith([
      { path: ['cells'] },
      { path: ['nested', 'inner'] },
      { path: ['cells', 'b'] },
      { path: ['missing'] },
    ]);
    const [first, , third] = await changed(workpieceId, [
      (doc) => doc.getMap('cells').set('a', 1),
      (doc) => {
        doc.getMap('cells').set('b', { index: 0, xml: '<b/>' });
        const inner = doc.getMap('nested').set('inner', new Y.Map());
        inner.set('k', new Y.Text('hallo'));
        doc.getMap('other').set('z', 1);
      },
      (doc) => doc.getMap('cells').delete('a'),
    ]);

    const earlier = await unitsOf(workpieceId, alice, { at: first!.toHexString() });
    expect(earlier.status).toBe(200);
    expect(earlier.body).toEqual({
      upToUpdateId: first!.toHexString(),
      containers: [
        { path: ['cells'], units: { a: 1 } },
        { path: ['nested', 'inner'], units: {} },
        { path: ['cells', 'b'], units: {} },
        { path: ['missing'], units: {} },
      ],
    });

    // A nested text comes as JSON; b is a plain value, no map, and other was never named.
    const newest = await unitsOf(workpieceId, alice);
    expect(newest.body).toEqual({
      upToUpdateId: third!.toHexString(),
      containers: [
        { path: ['cells'], units: { b: { index: 0, xml: '<b/>' } } },
        { path: ['nested', 'inner'], units: { k: 'hallo' } },
        { path: ['cells', 'b'], units: {} },
        { path: ['missing'], units: {} },
      ],
    });
  });

  it('gives an empty list for a workpiece that named no containers', async () => {
    const workpieceId = await workpieceWith([]);
    const [only] = await changed(workpieceId, [(doc) => doc.getMap('units').set('a', 1)]);

    expect((await unitsOf(workpieceId, alice)).body).toEqual({
      upToUpdateId: only!.toHexString(),
      containers: [],
    });
  });

  it('names no change while there is none', async () => {
    const workpieceId = await workpieceWith([{ path: ['cells'] }]);

    expect((await unitsOf(workpieceId, alice)).body).toEqual({
      containers: [{ path: ['cells'], units: {} }],
    });
  });

  it('refuses a point that is no change of this workpiece', async () => {
    const workpieceId = await workpieceWith([{ path: ['cells'] }]);
    await changed(workpieceId, [(doc) => doc.getMap('cells').set('a', 1)]);
    const elsewhere = await workpieceWith([{ path: ['cells'] }]);
    const [foreign] = await changed(elsewhere, [(doc) => doc.getMap('cells').set('b', 2)]);

    expect((await unitsOf(workpieceId, alice, { at: 'kaputt' })).status).toBe(400);
    expect((await unitsOf(workpieceId, alice, { at: foreign!.toHexString() })).status).toBe(404);
  });

  it('answers whoever does not see the workpiece as if there were none', async () => {
    const workpieceId = await workpieceWith([{ path: ['cells'] }]);
    await changed(workpieceId, [(doc) => doc.getMap('cells').set('a', 1)]);

    expect((await unitsOf(workpieceId, bob)).status).toBe(404);
  });
});
