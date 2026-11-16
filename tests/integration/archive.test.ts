import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import { ObjectId, type Db, type Document } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

import { createTokenCheck } from '../../src/auth/token.ts';
import { applyDefinitions } from '../../src/db/apply.ts';
import { archiveDefinitions, type EntryRecord } from '../../src/db/archive/definitions.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import { createComment } from '../../src/db/collections/comments.ts';
import { setGrant } from '../../src/db/collections/grants.ts';
import { createGroup } from '../../src/db/collections/groups.ts';
import { pseudonymOf } from '../../src/db/collections/pseudonyms.ts';
import { addToRoom, createRoom, findRoom } from '../../src/db/collections/rooms.ts';
import { storeSnapshot } from '../../src/db/collections/snapshots.ts';
import { createTask } from '../../src/db/collections/tasks.ts';
import { appendUpdate } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import {
  attachGateway,
  createWorkpieceHub,
  type Gateway,
  type WorkpieceHub,
} from '../../src/realtime/index.ts';
import { createApi } from '../../src/routes/index.ts';
import { createServer } from '../../src/routes/server.ts';
import { connectClient, waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_archive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

/** Collections whose content comes back exactly as it went; grants never leave. */
const RETURNING = [
  'workpieces',
  'updates',
  'comments',
  'tasks',
  'pseudonyms',
  'grants',
  'rooms',
  'groups',
] as const;

/** Events that tell of the archive itself and so stay live. */
const ABOUT_ARCHIVE = new Set([
  'workpiece-archived',
  'workpiece-restored',
  'room-archived',
  'room-restored',
  'group-archived',
  'group-restored',
]);

let storage: Storage;
let hub: WorkpieceHub;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let port: number;
/** How often the routes asked the open connections again. */
let rechecks = 0;

const tokenOf = (actor: string) =>
  jwt.sign({ sub: actor, name: actor }, secret, { expiresIn: '15m' });
const as = (actor: string) => ({ Authorization: `Bearer ${tokenOf(actor)}` });

/** A room alice manages and bob only sees, with a workpiece of alice in it. */
async function roomWithWorkpiece() {
  const room = await createRoom(storage.db, { name: 'Seminar', createdBy: 'alice' });
  const managers = await createGroup(storage.db, {
    name: 'Leitung',
    createdBy: 'alice',
    members: ['alice'],
  });
  const readers = await createGroup(storage.db, {
    name: 'Lesende',
    createdBy: 'alice',
    members: ['bob'],
  });
  const scope = { kind: 'room' as const, id: room._id };
  await setGrant(storage.db, {
    groupId: managers._id,
    scope,
    rights: ['see', 'edit', 'manage'],
    setBy: 'alice',
  });
  await setGrant(storage.db, { groupId: readers._id, scope, rights: ['see'], setBy: 'alice' });

  const workpiece = await createWorkpiece(storage.db, {
    name: 'Modell',
    createdBy: 'alice',
    contract: { kind: 'modell' },
    units: [],
  });
  await addToRoom(storage.db, room._id, { workpieceId: workpiece._id, addedBy: 'alice' });
  return { roomId: room._id, managersId: managers._id, readersId: readers._id, id: workpiece._id };
}

/** Two changes and two snapshots, a thread with a reply, a task with a subtask, a grant, a pseudonym. */
async function fillWorkpiece(workpieceId: ObjectId, readersId: ObjectId) {
  const doc = new Y.Doc();
  const bytes: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => bytes.push(update));
  doc.getText('t').insert(0, 'a');
  doc.getText('t').insert(1, 'b');

  const changes = [];
  for (const update of bytes) {
    // In order, so the changes keep the order they were made in.
    // eslint-disable-next-line no-await-in-loop
    const change = await appendUpdate(storage.db, {
      workpieceId,
      bytes: update,
      clients: [doc.clientID],
      createdBy: 'alice',
    });
    changes.push(change);
  }
  for (const change of changes) {
    // eslint-disable-next-line no-await-in-loop
    await storeSnapshot(storage.db, {
      workpieceId,
      upToUpdateId: change._id,
      state: Y.encodeStateAsUpdate(doc),
    });
  }

  const anchor = { kind: 'workpiece' as const, id: workpieceId, unit: 'c1' };
  const thread = await createComment(storage.db, {
    kind: 'note',
    anchor,
    createdBy: 'bob',
    body: { text: 'Frage' },
  });
  await createComment(storage.db, {
    kind: 'note',
    anchor,
    parentId: thread._id,
    createdBy: 'alice',
    body: { text: 'Antwort' },
  });
  const task = await createTask(storage.db, {
    kind: 'todo',
    title: 'Pruefen',
    state: 'open',
    createdBy: 'alice',
    anchor: { kind: 'comment', id: thread._id },
  });
  await createTask(storage.db, {
    kind: 'todo',
    title: 'Teil',
    state: 'open',
    createdBy: 'alice',
    parentId: task._id,
  });
  await setGrant(storage.db, {
    groupId: readersId,
    scope: { kind: 'comment', id: thread._id },
    rights: ['speak'],
    setBy: 'alice',
  });
  await pseudonymOf(storage.db, { kind: 'workpiece', id: workpieceId }, 'bob');
  return { lastChange: changes.at(-1)?._id };
}

/** Every document of the collections that come back unchanged, events without the archive's own. */
async function contentOf(db: Db): Promise<Record<string, Document[]>> {
  const content: Record<string, Document[]> = {};
  for (const name of RETURNING) {
    // eslint-disable-next-line no-await-in-loop
    content[name] = await db
      .collection(name)
      .find({}, { sort: { _id: 1 } })
      .toArray();
  }
  const events = await db
    .collection('events')
    .find({}, { sort: { _id: 1 } })
    .toArray();
  content['events'] = events.filter((event) => !ABOUT_ARCHIVE.has(event['kind'] as string));
  return content;
}

/** How many documents of each collection hang on the workpiece. */
async function countsAt(db: Db, workpieceId: ObjectId) {
  return {
    workpieces: await db.collection('workpieces').countDocuments({ _id: workpieceId }),
    updates: await db.collection('updates').countDocuments({ workpieceId }),
    snapshots: await db.collection('snapshots').countDocuments({ workpieceId }),
    pseudonyms: await db.collection('pseudonyms').countDocuments({ 'about.id': workpieceId }),
  };
}

/** Archives as this person. */
const archiveAs = (actor: string, workpieceId: ObjectId, body: object = {}) =>
  request(server)
    .post(`/workpieces/${workpieceId.toHexString()}/archive`)
    .set(as(actor))
    .send(body);

/** Restores as this person. */
const restoreAs = (actor: string, entryId: ObjectId) =>
  request(server).post(`/archive/${entryId.toHexString()}/restore`).set(as(actor));

/** The archive as this person sees it. */
const listAs = async (actor: string, kind?: string) =>
  (
    await request(server)
      .get('/archive')
      .query(kind === undefined ? {} : { kind })
      .set(as(actor))
  ).body as EntryRecord[];

/** Archives a room or a group as this person. */
const archiveKindAs = (actor: string, kind: 'rooms' | 'groups', id: ObjectId) =>
  request(server).post(`/${kind}/${id.toHexString()}/archive`).set(as(actor)).send({});

/** The status a GET answers this person with. */
const statusAs = async (actor: string, path: string) =>
  (await request(server).get(path).set(as(actor))).status;

/** A group whose member erin sees the room, which the managers of the room manage. */
async function teamIn(roomId: ObjectId, managersId: ObjectId): Promise<ObjectId> {
  const team = await createGroup(storage.db, {
    name: 'Team',
    createdBy: 'alice',
    members: ['erin'],
  });
  await setGrant(storage.db, {
    groupId: team._id,
    scope: { kind: 'room', id: roomId },
    rights: ['see'],
    setBy: 'alice',
  });
  await setGrant(storage.db, {
    groupId: managersId,
    scope: { kind: 'group', id: team._id },
    rights: ['see', 'manage'],
    setBy: 'alice',
  });
  return team._id;
}

/** The keys of entries as JSON carries them. */
const idsIn = (entries: EntryRecord[]) => entries.map((entry) => String(entry._id));

/** The status a WebSocket handshake to the workpiece gets as this person. */
function handshakeAs(actor: string, workpieceId: ObjectId): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${workpieceId.toHexString()}`, [
      'bearer',
      tokenOf(actor),
    ]);
    socket.on('open', () => {
      socket.close();
      resolve(101);
    });
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
  await applyDefinitions(storage.archive, archiveDefinitions);

  hub = createWorkpieceHub({ db: storage.db, logger: silent, bundlePause: 200 });
  const checkToken = createTokenCheck({ key: secret, algorithm: 'HS256' });
  server = createServer({
    logger: silent,
    api: createApi({
      db: storage.db,
      hub,
      checkToken,
      logger: silent,
      // Counted, and passed on to the gateway attached below.
      recheckAccess: async () => {
        rechecks += 1;
        await gateway.recheck();
      },
    }),
  });
  gateway = attachGateway({ server, db: storage.db, hub, checkToken, logger: silent });

  // admin manages everywhere, for orders in which nobody else could reach a thing any more.
  const admins = await createGroup(storage.db, {
    name: 'Verwaltung',
    createdBy: 'admin',
    members: ['admin'],
  });
  await setGrant(storage.db, {
    groupId: admins._id,
    rights: ['see', 'edit', 'manage'],
    setBy: 'admin',
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.archive.dropDatabase();
  await storage.close();
});

describe('archiving a workpiece', () => {
  it('moves it with all that hangs on it and brings it back unchanged', async () => {
    const { roomId, readersId, id } = await roomWithWorkpiece();
    const { lastChange } = await fillWorkpiece(id, readersId);
    const before = await contentOf(storage.db);
    const live = await countsAt(storage.db, id);

    const archived = await archiveAs('alice', id, { reason: 'Semester vorbei' });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      _id: id.toHexString(),
      kind: 'workpiece',
      name: 'Modell',
      reason: 'Semester vorbei',
      rooms: [{ workpiece: id.toHexString(), room: roomId.toHexString() }],
      forks: [],
    });
    // Grants stay where they are.
    expect(await contentOf(storage.db)).toMatchObject({ grants: before['grants'] });

    // Live nothing is left of it, not even in its room; the archive holds it, one snapshot only.
    expect(await countsAt(storage.db, id)).toEqual({
      workpieces: 0,
      updates: 0,
      snapshots: 0,
      pseudonyms: 0,
    });
    expect(await countsAt(storage.archive, id)).toEqual({ ...live, snapshots: 1 });
    expect((await findRoom(storage.db, roomId))?.workpieces).toEqual([]);
    expect(await storage.db.collection('comments').countDocuments({ 'anchor.id': id })).toBe(0);
    expect(await storage.archive.collection('comments').countDocuments({ 'anchor.id': id })).toBe(
      2,
    );
    expect(await storage.archive.collection('tasks').countDocuments()).toBe(2);
    expect(
      (await request(server).get(`/workpieces/${id.toHexString()}`).set(as('alice'))).status,
    ).toBe(404);

    // The trace of archiving stays live.
    expect(
      await storage.db
        .collection('events')
        .countDocuments({ kind: 'workpiece-archived', 'anchor.id': id }),
    ).toBe(1);

    const restored = await restoreAs('alice', id);
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ restored: true });

    // Everything as it was, except the older snapshot, and back in its room.
    expect(await contentOf(storage.db)).toEqual(before);
    const snapshots = await storage.db.collection('snapshots').find({ workpieceId: id }).toArray();
    expect(snapshots.map((snapshot) => snapshot['upToUpdateId'])).toEqual([lastChange]);
    expect((await findRoom(storage.db, roomId))?.workpieces).toEqual([id]);
    expect(await storage.archive.collection('entries').countDocuments({ _id: id })).toBe(0);
    expect(await storage.archive.collection('updates').countDocuments({ workpieceId: id })).toBe(0);
    expect(
      await storage.db
        .collection('events')
        .countDocuments({ kind: 'workpiece-restored', 'anchor.id': id }),
    ).toBe(1);
  });

  it('takes its forks along at any depth and puts each back in its own room', async () => {
    const { roomId, id } = await roomWithWorkpiece();
    const otherRoom = await createRoom(storage.db, { name: 'Uebung', createdBy: 'alice' });
    const fork = async (sourceId: ObjectId, body: object) => {
      const forked = await request(server)
        .post(`/workpieces/${sourceId.toHexString()}/forks`)
        .set(as('alice'))
        .send({ name: 'Kopie', ...body });
      expect(forked.status).toBe(201);
      return new ObjectId(forked.body._id as string);
    };
    const child = await fork(id, { roomId: roomId.toHexString() });
    await addToRoom(storage.db, otherRoom._id, { workpieceId: child, addedBy: 'alice' });
    const grandchild = await fork(child, {});

    const archived = await archiveAs('alice', id);
    expect(archived.status).toBe(200);
    expect(archived.body.forks).toEqual([child.toHexString(), grandchild.toHexString()]);
    expect(
      await storage.db
        .collection('workpieces')
        .countDocuments({ _id: { $in: [id, child, grandchild] } }),
    ).toBe(0);
    expect((await findRoom(storage.db, otherRoom._id))?.workpieces).toEqual([]);

    expect((await restoreAs('alice', id)).status).toBe(200);
    expect(
      await storage.db
        .collection('workpieces')
        .countDocuments({ _id: { $in: [id, child, grandchild] } }),
    ).toBe(3);
    expect((await findRoom(storage.db, roomId))?.workpieces).toEqual([id, child]);
    expect((await findRoom(storage.db, otherRoom._id))?.workpieces).toEqual([child]);
  });

  it('is for whoever manages it, and the archive shows what each one saw', async () => {
    const { id } = await roomWithWorkpiece();

    // carol sees nothing, bob only sees.
    expect((await archiveAs('carol', id)).status).toBe(404);
    expect((await archiveAs('bob', id)).status).toBe(403);
    expect((await archiveAs('alice', id)).status).toBe(200);

    expect(idsIn(await listAs('bob'))).toContain(id.toHexString());
    expect(idsIn(await listAs('bob', 'workpiece'))).toContain(id.toHexString());
    expect(idsIn(await listAs('bob', 'room'))).not.toContain(id.toHexString());
    expect(idsIn(await listAs('carol'))).not.toContain(id.toHexString());
    expect(
      (await request(server).get('/archive').query({ kind: 'thing' }).set(as('bob'))).status,
    ).toBe(400);

    expect((await restoreAs('carol', id)).status).toBe(404);
    expect((await restoreAs('bob', id)).status).toBe(403);
    expect((await restoreAs('alice', id)).status).toBe(200);
    expect((await restoreAs('alice', id)).status).toBe(404);
  });

  it('leaves a grant at it live, opening nothing until it is back', async () => {
    const { id } = await roomWithWorkpiece();
    const guests = await createGroup(storage.db, {
      name: 'Gaeste',
      createdBy: 'alice',
      members: ['dave'],
    });
    await setGrant(storage.db, {
      groupId: guests._id,
      scope: { kind: 'workpiece', id },
      rights: ['see'],
      setBy: 'alice',
    });
    expect(await statusAs('dave', `/workpieces/${id.toHexString()}`)).toBe(200);

    expect((await archiveAs('alice', id)).status).toBe(200);
    expect(await storage.db.collection('grants').countDocuments({ groupId: guests._id })).toBe(1);
    expect(await statusAs('dave', `/workpieces/${id.toHexString()}`)).toBe(404);

    expect((await restoreAs('alice', id)).status).toBe(200);
    expect(await statusAs('dave', `/workpieces/${id.toHexString()}`)).toBe(200);
  });

  it('does not keep anyone from taking in members for a grant at it', async () => {
    const { managersId, id } = await roomWithWorkpiece();
    const guests = await createGroup(storage.db, {
      name: 'Gaeste',
      createdBy: 'alice',
      members: ['dave'],
    });
    await setGrant(storage.db, {
      groupId: managersId,
      scope: { kind: 'group', id: guests._id },
      rights: ['see', 'manage'],
      setBy: 'alice',
    });
    await setGrant(storage.db, {
      groupId: guests._id,
      scope: { kind: 'workpiece', id },
      rights: ['see'],
      setBy: 'alice',
    });

    // alice manages the workpiece only through its room, which it left when archived.
    expect((await archiveAs('alice', id)).status).toBe(200);
    const added = await request(server)
      .post(`/groups/${guests._id.toHexString()}/members`)
      .set(as('alice'))
      .send({ actorId: 'frank' });
    expect(added.status).toBe(201);
  });

  it('closes open connections with 4403 and turns new ones away', async () => {
    const { id } = await roomWithWorkpiece();
    const client = await connectClient(
      `ws://127.0.0.1:${port}/ws/${id.toHexString()}`,
      ['bearer', tokenOf('alice')],
      new Y.Doc(),
    );
    await client.synced;
    client.doc.getText('t').insert(0, 'x');
    expect(
      await waitFor(
        async () =>
          (await storage.db.collection('updates').countDocuments({ workpieceId: id })) === 1,
      ),
    ).toBe(true);

    expect((await archiveAs('alice', id)).status).toBe(200);
    await expect(client.closed).resolves.toBe(4403);
    expect(gateway.countFor(id)).toBe(0);

    // What was typed went along, and so did the trace of leaving.
    expect(await storage.archive.collection('updates').countDocuments({ workpieceId: id })).toBe(1);
    expect(
      await storage.archive.collection('events').countDocuments({ kind: 'left', 'anchor.id': id }),
    ).toBe(1);
    expect(await handshakeAs('alice', id)).toBe(404);
  });

  it('answers 409 while the workpiece is withheld already', async () => {
    const { id } = await roomWithWorkpiece();
    let letGo!: () => void;
    const holding = hub.withhold([id], () => new Promise<void>((resolve) => (letGo = resolve)));

    expect((await archiveAs('alice', id)).status).toBe(409);
    letGo();
    await holding;
    expect((await archiveAs('alice', id)).status).toBe(200);
  });
});

describe('archiving a room', () => {
  it('moves it with what hangs on it, leaves its workpieces live and brings it back', async () => {
    const { roomId, id } = await roomWithWorkpiece();
    const room = { kind: 'room' as const, id: roomId };
    await createComment(storage.db, {
      kind: 'note',
      anchor: room,
      createdBy: 'bob',
      body: { text: 'Raumfrage' },
    });
    await pseudonymOf(storage.db, room, 'bob');
    const before = await contentOf(storage.db);
    const workpiece = `/workpieces/${id.toHexString()}`;
    expect(await statusAs('bob', workpiece)).toBe(200);

    // carol sees nothing, bob only sees.
    expect((await archiveKindAs('carol', 'rooms', roomId)).status).toBe(404);
    expect((await archiveKindAs('bob', 'rooms', roomId)).status).toBe(403);
    const counted = rechecks;
    const archived = await archiveKindAs('alice', 'rooms', roomId);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ _id: roomId.toHexString(), kind: 'room' });
    expect(rechecks).toBe(counted + 1);

    // The room and its thread are gone, its workpiece stays, and so does what opens it.
    expect(await findRoom(storage.db, roomId)).toBeNull();
    expect(await storage.db.collection('comments').countDocuments({ 'anchor.id': roomId })).toBe(0);
    expect(await storage.db.collection('pseudonyms').countDocuments({ 'about.id': roomId })).toBe(
      0,
    );
    expect(await storage.db.collection('workpieces').countDocuments({ _id: id })).toBe(1);
    expect(await statusAs('bob', workpiece)).toBe(404);
    expect(idsIn(await listAs('bob', 'room'))).toContain(roomId.toHexString());

    expect((await restoreAs('alice', roomId)).status).toBe(200);
    expect(rechecks).toBe(counted + 2);
    expect(await contentOf(storage.db)).toEqual(before);
    expect(await statusAs('bob', workpiece)).toBe(200);
  });

  it('gets its workpiece back in whatever order both left and return', async () => {
    for (const archivedFirst of ['room', 'workpiece'] as const) {
      for (const restoredFirst of ['room', 'workpiece'] as const) {
        // eslint-disable-next-line no-await-in-loop
        const { roomId, id } = await roomWithWorkpiece();
        const archiveRoom = () => archiveKindAs('admin', 'rooms', roomId);
        const archiveWorkpiece = () => archiveAs('admin', id);
        const steps =
          archivedFirst === 'room'
            ? [archiveRoom, archiveWorkpiece]
            : [archiveWorkpiece, archiveRoom];
        const restores = restoredFirst === 'room' ? [roomId, id] : [id, roomId];

        for (const step of steps) {
          // eslint-disable-next-line no-await-in-loop
          expect((await step()).status).toBe(200);
        }
        for (const entryId of restores) {
          // eslint-disable-next-line no-await-in-loop
          expect((await restoreAs('admin', entryId)).status).toBe(200);
        }
        // eslint-disable-next-line no-await-in-loop
        expect((await findRoom(storage.db, roomId))?.workpieces).toEqual([id]);
      }
    }
  });
});

describe('archiving a group', () => {
  it('moves it with its members, keeps its grants live and brings it back', async () => {
    const { roomId, managersId, id } = await roomWithWorkpiece();
    const team = await teamIn(roomId, managersId);
    await createComment(storage.db, {
      kind: 'note',
      anchor: { kind: 'group', id: team },
      createdBy: 'alice',
      body: { text: 'Gruppennotiz' },
    });
    const before = await contentOf(storage.db);
    const workpiece = `/workpieces/${id.toHexString()}`;
    expect(await statusAs('erin', workpiece)).toBe(200);

    // carol sees nothing, erin sees her group but does not manage it.
    expect((await archiveKindAs('carol', 'groups', team)).status).toBe(404);
    expect((await archiveKindAs('erin', 'groups', team)).status).toBe(403);
    const counted = rechecks;
    const archived = await archiveKindAs('alice', 'groups', team);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ _id: team.toHexString(), kind: 'group', name: 'Team' });
    expect(rechecks).toBe(counted + 1);

    // The group and its note are gone; its grant stays, but opens nothing for erin meanwhile.
    expect(await storage.db.collection('groups').countDocuments({ _id: team })).toBe(0);
    expect(await storage.db.collection('comments').countDocuments({ 'anchor.id': team })).toBe(0);
    expect(await storage.db.collection('grants').countDocuments({ groupId: team })).toBe(1);
    expect(await statusAs('erin', workpiece)).toBe(404);

    expect((await restoreAs('alice', team)).status).toBe(200);
    expect(rechecks).toBe(counted + 2);
    expect(await contentOf(storage.db)).toEqual(before);
    expect(await statusAs('erin', workpiece)).toBe(200);
  });

  it('opens the room again through its grant, whichever of the two comes back first', async () => {
    for (const restoredFirst of ['group', 'room'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const { roomId, managersId, id } = await roomWithWorkpiece();
      // eslint-disable-next-line no-await-in-loop
      const team = await teamIn(roomId, managersId);

      // eslint-disable-next-line no-await-in-loop
      expect((await archiveKindAs('alice', 'groups', team)).status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      expect((await archiveKindAs('alice', 'rooms', roomId)).status).toBe(200);

      for (const entryId of restoredFirst === 'group' ? [team, roomId] : [roomId, team]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await statusAs('erin', `/workpieces/${id.toHexString()}`)).toBe(404);
        // eslint-disable-next-line no-await-in-loop
        expect((await restoreAs('alice', entryId)).status).toBe(200);
      }
      // eslint-disable-next-line no-await-in-loop
      expect(await statusAs('erin', `/workpieces/${id.toHexString()}`)).toBe(200);
    }
  });
});
