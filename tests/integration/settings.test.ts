import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import * as decoding from 'lib0/decoding';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck, createTokenSwitch } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { createRoom } from '../../src/db/collections/rooms.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { seedServiceGroup } from '../../src/db/seedService.ts';
import {
  createWorkpieceHub,
  type Connection,
  type WorkpieceHub,
} from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_settings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'settings-secret';
const logger = pino({ level: 'silent' });
const issuer = 'modeling-copilot';
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });
// Alice stands at the top, bob is a plain person, carol and dave hold manage at different places.
const alice = tokenFor('alice', { globalRole: 'ADMIN' });
const bob = tokenFor('bob');
const carol = tokenFor('carol');
const dave = tokenFor('dave');
const service = jwt.sign({ sub: 'service-modeling-copilot' }, key.privateKey, {
  algorithm: 'ES256',
  issuer,
  expiresIn: '5m',
});

let storage: Storage;
let hub: WorkpieceHub;
let server: ReturnType<typeof createServer>;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A connection without a socket that keeps the events it is sent. */
function listener(actorId: string, wantsEvents: boolean): Connection & { heard: object[] } {
  const heard: object[] = [];
  return {
    actor: { actorId },
    wantsEvents,
    heard,
    send: (message) => {
      // Message 101 is the type, then the event as JSON.
      const decoder = decoding.createDecoder(message);
      expect(decoding.readVarUint(decoder)).toBe(101);
      heard.push(JSON.parse(decoding.readVarString(decoder)) as object);
    },
    close: () => {},
  };
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
  await seedServiceGroup(storage.db, 'service-modeling-copilot');

  // Carol manages everywhere, dave only in one room.
  const everywhere = await createGroup(storage.db, {
    name: 'Tutoren',
    createdBy: 'alice',
    members: ['carol'],
  });
  await setGrant(storage.db, { groupId: everywhere._id, rights: ['manage'], setBy: 'alice' });
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const inRoom = await createGroup(storage.db, {
    name: 'Raum',
    createdBy: 'alice',
    members: ['dave'],
  });
  await setGrant(storage.db, {
    groupId: inRoom._id,
    scope: { kind: 'room', id: room._id },
    rights: ['manage'],
    setBy: 'alice',
  });

  const checkPerson = createTokenCheck({
    key: secret,
    algorithm: 'HS256',
    top: { claim: 'globalRole', values: ['ADMIN'] },
  });
  const checkService = createTokenCheck({
    key: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    algorithm: 'ES256',
    issuer,
    keys: 'services',
  });

  hub = createWorkpieceHub({ db: storage.db, logger });
  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub,
      checkToken: createTokenSwitch(checkPerson, { issuer, check: checkService }),
      logger,
      recheckAccess: async () => {},
    }),
  });
});

afterAll(async () => {
  await hub.close();
  await storage.db.dropDatabase();
  await storage.close();
});

describe('settings routes', () => {
  it('stores, lists, replaces and removes an area', async () => {
    const empty = await request(server).get('/settings/sharing').set(as(bob));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({});

    const set = await request(server)
      .put('/settings/sharing')
      .set(as(alice))
      .send({ delaySeconds: 30, nested: { on: true } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ delaySeconds: 30, nested: { on: true } });

    // Replaced whole: a key left out is gone.
    await request(server).put('/settings/sharing').set(as(alice)).send({ delaySeconds: 10 });
    await request(server).put('/settings/groups').set(as(alice)).send({ size: 3 });

    const read = await request(server).get('/settings/sharing').set(as(bob));
    expect(read.body).toEqual({ delaySeconds: 10 });
    const stored = await storage.db.collection('settings').findOne({ _id: 'sharing' as never });
    expect(stored?.['updatedBy']).toBe('alice');
    expect(stored?.['updatedAt']).toBeInstanceOf(Date);

    const listed = await request(server).get('/settings').set(as(bob));
    expect(listed.body).toEqual(['groups', 'sharing']);

    const removed = await request(server).delete('/settings/groups').set(as(alice));
    expect(removed.status).toBe(204);
    const again = await request(server).delete('/settings/groups').set(as(alice));
    expect(again.status).toBe(204);
    expect((await request(server).get('/settings/groups').set(as(bob))).body).toEqual({});
  });

  it('refuses a malformed key and values that are no object', async () => {
    const malformed = await request(server).get('/settings/no.dots').set(as(alice));
    expect(malformed.status).toBe(400);

    const list = await request(server).put('/settings/sharing').set(as(alice)).send([1, 2]);
    expect(list.status).toBe(400);
  });

  it('needs a token to read', async () => {
    expect((await request(server).get('/settings')).status).toBe(401);
  });
});

describe('who may change settings', () => {
  it('lets every token read but only manage without a place write', async () => {
    expect((await request(server).get('/settings/sharing').set(as(service))).status).toBe(200);

    // One after another on purpose: each writes and then removes the same area.
    /* eslint-disable no-await-in-loop */

    for (const token of [bob, dave]) {
      const put = await request(server).put('/settings/rights').set(as(token)).send({ a: 1 });
      expect(put.status).toBe(403);
      const del = await request(server).delete('/settings/rights').set(as(token));
      expect(del.status).toBe(403);
    }

    for (const token of [alice, carol, service]) {
      const put = await request(server).put('/settings/rights').set(as(token)).send({ a: 1 });
      expect(put.status).toBe(200);
      const del = await request(server).delete('/settings/rights').set(as(token));
      expect(del.status).toBe(204);
    }
    /* eslint-enable no-await-in-loop */
  });
});

describe('settings-changed', () => {
  it('goes to every connection that asked for events, at every workpiece, and is not stored', async () => {
    const first = await createWorkpiece(storage.db, { name: 'Erster', createdBy: 'alice' });
    const second = await createWorkpiece(storage.db, { name: 'Zweiter', createdBy: 'alice' });
    const asking = listener('bob', true);
    const elsewhere = listener('carol', true);
    const quiet = listener('dave', false);
    await hub.join(first._id, asking);
    await hub.join(first._id, quiet);
    await hub.join(second._id, elsewhere);

    await request(server).put('/settings/events').set(as(alice)).send({ on: true });
    await request(server).delete('/settings/events').set(as(alice));

    const told = { kind: 'settings-changed', key: 'events' };
    expect(asking.heard).toEqual([told, told]);
    expect(elsewhere.heard).toEqual([told, told]);
    expect(quiet.heard).toEqual([]);
    expect(await storage.db.collection('events').countDocuments({ kind: 'settings-changed' })).toBe(
      0,
    );

    await hub.leave(first._id, asking);
    await hub.leave(first._id, quiet);
    await hub.leave(second._id, elsewhere);
  });
});
