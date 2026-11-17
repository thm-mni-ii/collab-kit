import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck, createTokenSwitch } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { archiveDefinitions } from '../../src/db/archive/definitions.ts';
import { archiveGroup } from '../../src/db/archive/move.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { grantsOf, setGrant } from '../../src/db/collections/grants.ts';
import { createGroup, findGroup } from '../../src/db/collections/groups.ts';
import { SERVICE_GROUP, seedServiceGroup } from '../../src/db/seedService.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { RIGHTS } from '../../src/model/right.ts';
import { createWorkpieceHub } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_service_group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const secret = 'service-group-secret';
const logger = pino({ level: 'silent' });
const issuer = 'modeling-copilot';
const serviceId = 'service-modeling-copilot';
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const tokenFor = (subject: string, claims: object = {}) =>
  jwt.sign({ sub: subject, ...claims }, secret, { algorithm: 'HS256' });
// Alice stands at the top, carol holds every right everywhere by a grant, the service by its group.
const alice = tokenFor('alice', { globalRole: 'ADMIN' });
const carol = tokenFor('carol');
const service = jwt.sign({ sub: serviceId }, key.privateKey, {
  algorithm: 'ES256',
  issuer,
  expiresIn: '5m',
});

let storage: Storage;
let server: ReturnType<typeof createServer>;
let groupId: string;

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Every change that would leave the service without rights, each sent as one actor. */
const refusals = [
  {
    what: 'archiving',
    send: (token: string) =>
      request(server).post(`/groups/${groupId}/archive`).set(as(token)).send({}),
  },
  {
    what: 'renaming',
    send: (token: string) =>
      request(server).patch(`/groups/${groupId}`).set(as(token)).send({ name: 'other' }),
  },
  {
    what: 'taking a person in',
    send: (token: string) =>
      request(server).post(`/groups/${groupId}/members`).set(as(token)).send({ actorId: 'dave' }),
  },
  {
    what: 'removing the service',
    send: (token: string) =>
      request(server).delete(`/groups/${groupId}/members/${serviceId}`).set(as(token)),
  },
  {
    what: 'changing the grant everywhere',
    send: (token: string) =>
      request(server)
        .put('/grants')
        .set(as(token))
        .send({ groupId, rights: ['see'] }),
  },
  {
    what: 'taking the grant everywhere',
    send: (token: string) => request(server).delete('/grants').query({ groupId }).set(as(token)),
  },
];

const actors = { top: alice, person: carol, service };
const cases = Object.entries(actors).flatMap(([who, token]) =>
  refusals.map(({ what, send }) => ({ who, what, send: () => send(token) })),
);

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
  await applyDefinitions(storage.archive, archiveDefinitions);

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
      service: serviceId,
    }),
  });

  // As at startup, then a group that gives carol every right everywhere.
  await seedServiceGroup(storage.db, serviceId);
  const found = await storage.db.collection('groups').findOne({ name: SERVICE_GROUP });
  groupId = String(found?._id);
  const admins = await createGroup(storage.db, {
    name: 'admins',
    createdBy: 'alice',
    members: ['carol'],
  });
  await setGrant(storage.db, { groupId: admins._id, rights: RIGHTS, setBy: 'alice' });
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.archive.dropDatabase();
  await storage.close();
});

describe('the group of the service', () => {
  it.each(cases)('refuses $what to the $who with 409', async ({ send }) => {
    const response = await send();
    expect(response.status).toBe(409);
  });

  it('stays whole after every refusal', async () => {
    const id = new ObjectId(groupId);
    expect(await findGroup(storage.db, id)).toMatchObject({
      name: SERVICE_GROUP,
      members: [serviceId],
    });
    const grants = await grantsOf(storage.db, id);
    expect(grants.map((grant) => grant.rights.toSorted())).toEqual([RIGHTS.toSorted()]);
  });

  it('takes in another service and lets it go again', async () => {
    const added = await request(server)
      .post(`/groups/${groupId}/members`)
      .set(as(alice))
      .send({ actorId: 'service-tutor' });
    expect(added.status).toBe(201);

    const removed = await request(server)
      .delete(`/groups/${groupId}/members/service-tutor`)
      .set(as(alice));
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ members: [serviceId] });
  });

  it('keeps its settings open to change', async () => {
    const changed = await request(server)
      .patch(`/groups/${groupId}`)
      .set(as(alice))
      .send({ settings: { note: 'kept by the service' } });
    expect(changed.status).toBe(200);
  });

  it('is told by the service in it, not by its name alone', async () => {
    const own = await request(server)
      .post('/groups')
      .set(as(alice))
      .send({ name: SERVICE_GROUP, members: ['carol'] });
    const id = own.body._id as string;

    const renamed = await request(server)
      .patch(`/groups/${id}`)
      .set(as(alice))
      .send({ name: 'ours' });
    expect(renamed.status).toBe(200);

    const archived = await request(server).post(`/groups/${id}/archive`).set(as(alice)).send({});
    expect(archived.status).toBe(200);
  });

  it('comes back from the archive when it went there before it was guarded', async () => {
    const id = new ObjectId(groupId);
    const entry = await archiveGroup(storage.db, storage.archive, id, { archivedBy: 'alice' });
    expect(entry).toBeDefined();

    const restored = await request(server)
      .post(`/archive/${entry?._id.toHexString()}/restore`)
      .set(as(alice));
    expect(restored.status).toBe(200);
    expect(await findGroup(storage.db, id)).toMatchObject({ name: SERVICE_GROUP });
  });
});
