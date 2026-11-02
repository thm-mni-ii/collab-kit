import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenCheck, createTokenSwitch } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { grantsOf, removeGrant } from '../../src/db/collections/grants.ts';
import { SERVICE_GROUP, seedServiceGroup } from '../../src/db/seedService.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import type { GroupRecord } from '../../src/db/collections/groups.ts';
import { RIGHTS } from '../../src/model/right.ts';
import { createWorkpieceHub } from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_seed_service_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const logger = pino({ level: 'silent' });
const issuer = 'modeling-copilot';
const actorId = 'service-modeling-copilot';
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const service = jwt.sign({ sub: actorId }, key.privateKey, {
  algorithm: 'ES256',
  issuer,
  expiresIn: '5m',
});

let storage: Storage;
let server: ReturnType<typeof createServer>;

const groups = () =>
  storage.db.collection<GroupRecord>('groups').find({ name: SERVICE_GROUP }).toArray();

/** The one group of services, or a failure when there is none. */
const theGroup = async (): Promise<GroupRecord> => {
  const [group] = await groups();
  if (group === undefined) {
    throw new Error('the group of services is missing');
  }
  return group;
};

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const checkPerson = createTokenCheck({ key: 'seed-secret', algorithm: 'HS256' });
  const checkService = createTokenCheck({
    key: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    algorithm: 'ES256',
    issuer,
    keys: 'services',
  });
  server = createServer({
    logger,
    api: createApi({
      db: storage.db,
      hub: createWorkpieceHub({ db: storage.db, logger }),
      checkToken: createTokenSwitch(checkPerson, { issuer, check: checkService }),
      logger,
      recheckAccess: async () => {},
    }),
  });
});

afterAll(async () => {
  await storage.db.dropDatabase();
  await storage.close();
});

describe('seedServiceGroup', () => {
  it('makes one group with every right however often it runs, and the service may make a room', async () => {
    await seedServiceGroup(storage.db, actorId);
    await seedServiceGroup(storage.db, actorId);

    expect(await groups()).toHaveLength(1);
    const group = await theGroup();
    expect(group.members).toEqual([actorId]);
    expect((await grantsOf(storage.db, group._id))[0]?.rights).toEqual([...RIGHTS]);

    const room = await request(server)
      .post('/rooms')
      .set({ Authorization: `Bearer ${service}` })
      .send({ name: 'bob' });
    expect(room.status).toBe(201);
  });

  it('puts back the rights and the member that were taken away', async () => {
    const group = await theGroup();
    await removeGrant(storage.db, { groupId: group._id, removedBy: 'alice' });
    await storage.db
      .collection<GroupRecord>('groups')
      .updateOne({ _id: group._id }, { $set: { members: [] } });

    await seedServiceGroup(storage.db, actorId);

    expect(await groups()).toHaveLength(1);
    expect((await theGroup()).members).toEqual([actorId]);
    expect((await grantsOf(storage.db, group._id))[0]?.rights).toEqual([...RIGHTS]);
  });
});
