import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck, createTokenSwitch } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { createWorkpieceHub } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_services_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'services-secret';
const logger = pino({ level: 'silent' });
const issuer = 'modeling-copilot';
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });
// Alice stands at the top and lets the service in once; bob only logs in.
const alice = tokenFor('alice', { globalRole: 'ADMIN' });
const bob = tokenFor('bob');
// The service signs its own token, short-lived, with its private key.
const service = jwt.sign({ sub: 'service-modeling-copilot' }, key.privateKey, {
  algorithm: 'ES256',
  issuer,
  expiresIn: '5m',
});

let storage: Storage;
let server: ReturnType<typeof createServer>;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

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

  const hub = createWorkpieceHub({ db: storage.db, logger });
  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub,
      checkToken: createTokenSwitch(checkPerson, { issuer, check: checkService }),
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

describe('a service with its own tokens', () => {
  it('is an actor like any other, without rights until a grant gives it some', async () => {
    const me = await request(server).get('/me').set(as(service));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ actorId: 'service-modeling-copilot' });

    const room = await request(server).post('/rooms').set(as(service)).send({ name: 'bob' });
    expect(room.status).toBe(403);
  });

  it('sets up the room of a person once the top has granted it the rights', async () => {
    // Done once by the top: a group of services, holding everywhere what they hand on.
    const services = await request(server)
      .post('/groups')
      .set(as(alice))
      .send({ name: 'Dienste', members: ['service-modeling-copilot'] });
    const granted = await request(server)
      .put('/grants')
      .set(as(alice))
      .send({ groupId: services.body._id as string, rights: ['see', 'edit', 'manage'] });
    expect(granted.status).toBe(200);

    // At bob's login: his room, a group of him alone, and see and edit there.
    const room = await request(server)
      .post('/rooms')
      .set(as(service))
      .send({ name: 'bob', settings: { personal: 'bob' } });
    expect(room.status).toBe(201);
    expect(room.body).toMatchObject({ createdBy: 'service-modeling-copilot' });

    const own = await request(server)
      .post('/groups')
      .set(as(service))
      .send({ name: 'bob', members: ['bob'] });
    expect(own.status).toBe(201);

    const roomId = room.body._id as string;
    const handed = await request(server)
      .put('/grants')
      .set(as(service))
      .send({
        groupId: own.body._id as string,
        scope: { kind: 'room', id: roomId },
        rights: ['see', 'edit'],
      });
    expect(handed.status).toBe(200);

    expect((await request(server).get(`/rooms/${roomId}`).set(as(bob))).status).toBe(200);
  });

  it('refuses a person whose key looks like a service', async () => {
    const forged = tokenFor('service-modeling-copilot');

    expect((await request(server).get('/me').set(as(forged))).status).toBe(401);
  });
});
