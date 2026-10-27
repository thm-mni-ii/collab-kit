import { ObjectId } from 'mongodb';
import pino from 'pino';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDefinitions } from '../../src/db/apply.ts';
import { connect, type Storage } from '../../src/db/client.ts';
import {
  latestSnapshot,
  storeSnapshot,
  type SnapshotRecord,
} from '../../src/db/collections/snapshots.ts';
import { appendUpdate, readUpdatesSince } from '../../src/db/collections/updates.ts';
import { createWorkpiece } from '../../src/db/collections/workpieces.ts';
import { collectionDefinitions } from '../../src/db/schemas.ts';
import { loadWorkpiece, readStateAt, SNAPSHOT_EVERY } from '../../src/realtime/hub/persistence.ts';
import { createWorkpieceHub, type Connection } from '../../src/realtime/index.ts';
import type { WorkpieceHub } from '../../src/realtime/hub/types.ts';
import { waitFor } from './yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const database = `collab_kit_snapshots_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

let storage: Storage;
let hub: WorkpieceHub;

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);
  hub = createWorkpieceHub({ db: storage.db, logger: silent });
});

afterAll(async () => {
  await hub.close();
  await storage.db.dropDatabase();
  await storage.close();
});

/** A connection without a socket, to drive the hub directly. */
const quiet = (actorId: string): Connection => ({
  actor: { actorId },
  wantsEvents: false,
  send: () => {},
  close: () => {},
});

/** A workpiece without any change yet. */
const freshWorkpiece = async () =>
  (await createWorkpiece(storage.db, { name: 'Modell', createdBy: 'alice' }))._id;

/** A doc of the tool with a fixed client id, so it is known whose pieces are whose. */
function toolDoc(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

/** Stores what the tool sends while working, each update as one change, as the hub would. */
async function storeFrom(workpieceId: ObjectId, tool: Y.Doc, work: () => void): Promise<void> {
  const sent: Uint8Array[] = [];
  const keep = (update: Uint8Array) => sent.push(update);
  tool.on('update', keep);
  work();
  tool.off('update', keep);

  /* eslint-disable no-await-in-loop */
  for (const bytes of sent) {
    await appendUpdate(storage.db, { workpieceId, bytes, clients: [], createdBy: 'alice' });
  }
  /* eslint-enable no-await-in-loop */
}

/** So many changes to the cells, each its own update. */
const cellChanges = (tool: Y.Doc, count: number) => () => {
  for (let index = 0; index < count; index += 1) {
    tool.getMap('cells').set(`c${index % 30}`, index);
  }
};

/** The state after the change until, replayed from the whole chain without any snapshot. */
async function replayed(workpieceId: ObjectId, until?: ObjectId): Promise<Y.Doc> {
  const doc = new Y.Doc({ gc: false });
  for (const row of await readUpdatesSince(storage.db, workpieceId, undefined, until)) {
    Y.applyUpdate(doc, new Uint8Array(row.bytes.buffer));
  }
  return doc;
}

/** The state CK gives after the change at, or the newest, as a doc. */
async function given(workpieceId: ObjectId, at?: ObjectId): Promise<Y.Doc> {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, (await readStateAt(storage.db, silent, workpieceId, at)).state);
  return doc;
}

/** Both hold the same pieces, nothing more and nothing less, and show the same cells. */
function expectSame(actual: Y.Doc, expected: Y.Doc): void {
  expect(Y.encodeStateVector(actual)).toEqual(Y.encodeStateVector(expected));
  expect(actual.getMap('cells').toJSON()).toEqual(expected.getMap('cells').toJSON());
}

/** How many changes of a workpiece are stored. */
const storedOf = (workpieceId: ObjectId) =>
  storage.db.collection('updates').countDocuments({ workpieceId });

/** The snapshots of a workpiece, oldest first. */
const snapshotsOf = (workpieceId: ObjectId) =>
  storage.db
    .collection<SnapshotRecord>('snapshots')
    .find({ workpieceId })
    .sort({ upToUpdateId: 1 })
    .toArray();

describe('rebuilding a state', () => {
  it('gives every state as the whole chain does, from a snapshot and the rest', async () => {
    const workpieceId = await freshWorkpiece();
    const count = 2 * SNAPSHOT_EVERY + 50;
    const tool = toolDoc(1);
    await storeFrom(workpieceId, tool, cellChanges(tool, count));
    const rows = await readUpdatesSince(storage.db, workpieceId);

    // The first reading lays the snapshots, every later one starts from one of them.
    const newest = await readStateAt(storage.db, silent, workpieceId);
    expect(newest.upToUpdateId).toEqual(rows.at(-1)!._id);
    expect(await snapshotsOf(workpieceId)).toHaveLength(2);

    // Before, on and after each border, and the newest.
    /* eslint-disable no-await-in-loop */
    for (const index of [0, SNAPSHOT_EVERY - 2, SNAPSHOT_EVERY - 1, SNAPSHOT_EVERY, count - 1]) {
      const at = rows[index]!._id;
      expectSame(await given(workpieceId, at), await replayed(workpieceId, at));
    }
    /* eslint-enable no-await-in-loop */
    expectSame(await given(workpieceId), await replayed(workpieceId));
  });

  it('catches up the snapshots a long way lacks, each exactly up to its change', async () => {
    const workpieceId = await freshWorkpiece();
    const tool = toolDoc(1);
    await storeFrom(workpieceId, tool, cellChanges(tool, 2 * SNAPSHOT_EVERY + 50));
    const rows = await readUpdatesSince(storage.db, workpieceId);

    // Too short a way to need one.
    await readStateAt(storage.db, silent, workpieceId, rows[SNAPSHOT_EVERY - 2]!._id);
    expect(await snapshotsOf(workpieceId)).toEqual([]);

    // A long one lays those it passes, none beyond the point asked for.
    await readStateAt(storage.db, silent, workpieceId, rows[2 * SNAPSHOT_EVERY + 10]!._id);
    const snapshots = await snapshotsOf(workpieceId);
    expect(snapshots.map((snapshot) => snapshot.upToUpdateId)).toEqual([
      rows[SNAPSHOT_EVERY - 1]!._id,
      rows[2 * SNAPSHOT_EVERY - 1]!._id,
    ]);

    /* eslint-disable no-await-in-loop */
    for (const snapshot of snapshots) {
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, new Uint8Array(snapshot.state.buffer));
      expectSame(doc, await replayed(workpieceId, snapshot.upToUpdateId));
    }
    /* eslint-enable no-await-in-loop */
  });

  it('keeps a deleted container as a frame, so a late change in it finds its place', async () => {
    const workpieceId = await freshWorkpiece();
    const tool = toolDoc(1);
    const late = toolDoc(2);

    // A cell with a name, which the late writer holds too.
    await storeFrom(workpieceId, tool, () =>
      tool.transact(() => {
        const cell = new Y.Map<string>();
        tool.getMap('cells').set('cell', cell);
        cell.set('name', 'a');
      }),
    );
    Y.applyUpdate(late, Y.encodeStateAsUpdate(tool));

    // Deleted, then enough other changes that the snapshot lies behind the deletion.
    await storeFrom(workpieceId, tool, () => tool.getMap('cells').delete('cell'));
    await storeFrom(workpieceId, tool, cellChanges(tool, SNAPSHOT_EVERY - 2));
    await readStateAt(storage.db, silent, workpieceId);
    expect(await snapshotsOf(workpieceId)).toHaveLength(1);

    // Renamed by somebody who never saw the deletion, stored after the snapshot.
    await storeFrom(workpieceId, late, () =>
      (late.getMap('cells').get('cell') as Y.Map<string>).set('name', 'b'),
    );

    // Placed in its deleted cell, not dropped as garbage for want of a place.
    const { state } = await readStateAt(storage.db, silent, workpieceId);
    const renamed = Y.decodeUpdate(state).structs.filter((struct) => struct.id.client === 2);
    expect(renamed).not.toHaveLength(0);
    expect(renamed.every((struct) => struct instanceof Y.Item)).toBe(true);
    expectSame(await given(workpieceId), await replayed(workpieceId));
  });
});

describe('the hub', () => {
  it('lays one after every 200 stored changes, holding nothing beyond its change', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = quiet('alice');
    const { doc } = await hub.join(workpieceId, alice);

    // In one go, so the Y.Doc holds every change before the first of them is stored.
    const count = 2 * SNAPSHOT_EVERY + 20;
    for (let index = 0; index < count; index += 1) {
      doc.transact(() => doc.getMap('cells').set(`c${index % 30}`, index), alice);
    }
    expect(await waitFor(async () => (await storedOf(workpieceId)) === count, 10_000)).toBe(true);
    expect(await waitFor(async () => (await snapshotsOf(workpieceId)).length === 2)).toBe(true);

    // Each exactly up to its change, from the stored chain, though the Y.Doc was further.
    const rows = await readUpdatesSince(storage.db, workpieceId);
    expect(rows).toHaveLength(count);
    const snapshots = await snapshotsOf(workpieceId);
    expect(snapshots.map((snapshot) => snapshot.upToUpdateId)).toEqual([
      rows[SNAPSHOT_EVERY - 1]!._id,
      rows[2 * SNAPSHOT_EVERY - 1]!._id,
    ]);
    /* eslint-disable no-await-in-loop */
    for (const snapshot of snapshots) {
      const laid = new Y.Doc({ gc: false });
      Y.applyUpdate(laid, new Uint8Array(snapshot.state.buffer));
      expectSame(laid, await replayed(workpieceId, snapshot.upToUpdateId));
    }
    /* eslint-enable no-await-in-loop */

    await hub.leave(workpieceId, alice);
  });

  it('loads from the newest snapshot and the changes after it', async () => {
    const workpieceId = await freshWorkpiece();
    const alice = quiet('alice');
    const held = await hub.join(workpieceId, alice);
    const count = SNAPSHOT_EVERY + 30;
    for (let index = 0; index < count; index += 1) {
      held.doc.transact(() => held.doc.getMap('cells').set(`c${index % 30}`, index), alice);
    }
    expect(await waitFor(async () => (await storedOf(workpieceId)) === count, 10_000)).toBe(true);
    expect(await waitFor(async () => (await snapshotsOf(workpieceId)).length === 1)).toBe(true);
    await hub.leave(workpieceId, alice);

    // Counted from the snapshot, it holds what the whole chain holds.
    const { doc, stored } = await loadWorkpiece(storage.db, silent, workpieceId);
    const rows = await readUpdatesSince(storage.db, workpieceId);
    expect(stored.updatesSinceSnapshot).toBe(count - SNAPSHOT_EVERY);
    expect(stored.lastUpdateId).toEqual(rows.at(-1)!._id);
    expectSame(doc, await replayed(workpieceId));

    const again = await hub.join(workpieceId, alice);
    expectSame(again.doc, await replayed(workpieceId));
    await hub.leave(workpieceId, alice);
  });
});

describe('the snapshots', () => {
  it('keeps the first of two up to the same change', async () => {
    const workpieceId = new ObjectId();
    const upToUpdateId = new ObjectId();

    await expect(
      storeSnapshot(storage.db, { workpieceId, upToUpdateId, state: new Uint8Array([1]) }),
    ).resolves.toBe(true);
    await expect(
      storeSnapshot(storage.db, { workpieceId, upToUpdateId, state: new Uint8Array([2]) }),
    ).resolves.toBe(false);

    const kept = await latestSnapshot(storage.db, workpieceId);
    expect([...new Uint8Array(kept!.state.buffer)]).toEqual([1]);
  });
});
