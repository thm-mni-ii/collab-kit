import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// First, so the page is there before Lit loads.
import { page } from './page.ts';
import type { CollabKitApi, ManagementOpen, ManagementOptions } from '../../../client/src/api.ts';
import { createCollabKitApi } from '../../../client/src/index.ts';
import '../../../client/src/manage/index.ts';
import { createTokenCheck } from '../../../src/auth/token.ts';
import { applyDefinitions } from '../../../src/db/apply.ts';
import { connect, type Storage } from '../../../src/db/client.ts';
import { collectionDefinitions } from '../../../src/db/schemas.ts';
import { attachGateway, createWorkpieceHub, type Gateway } from '../../../src/realtime/index.ts';
import { createApi } from '../../../src/routes/index.ts';
import { createServer } from '../../../src/routes/server.ts';
import { waitFor } from '../yjs-client.ts';

const uri = process.env['MONGODB_URI'];
if (uri === undefined || uri === '') {
  throw new Error('MONGODB_URI is missing, start the database with npm run db:up');
}

const secret = 'geheimnis-des-werkzeugs';
const database = `collab_kit_client_manage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const silent = pino({ level: 'silent' });

/** The element as a tool sees it, and what a test waits on. */
type Management = HTMLElement & ManagementOptions & { readonly updateComplete: Promise<boolean> };

let storage: Storage;
let gateway: Gateway;
let server: ReturnType<typeof createServer>;
let url: string;

// Alice is at the top and may everything, bob only what a grant gives him.
let alice: CollabKitApi;
let bob: CollabKitApi;

/** The library as this person, the name in the token with a capital. */
function as(actor: string, top = false): CollabKitApi {
  const name = `${actor[0]?.toUpperCase()}${actor.slice(1)}`;
  const token = jwt.sign({ sub: actor, name, ...(top ? { globalRole: 'ADMIN' } : {}) }, secret, {
    expiresIn: '15m',
  });
  return createCollabKitApi({ url, getToken: () => token });
}

/** Puts the element into the page as a tool would, and waits until it shows what CK gave. */
async function mount(ck: CollabKitApi, options: Partial<ManagementOptions> = {}) {
  const element = document.createElement('ck-management') as Management;
  Object.assign(element, options);
  element.ck = ck;
  document.body.append(element);
  await settled(element);
  return element;
}

/** Waits until no call to CK is under way and what came back is drawn. */
async function settled(element: Management): Promise<void> {
  await element.updateComplete;
  expect(await waitFor(() => !element.hasAttribute('aria-busy'))).toBe(true);
  await element.updateComplete;
  // The parts draw themselves a turn later than the element that holds them.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function rootOf(element: Management): ShadowRoot {
  if (element.shadowRoot === null) {
    throw new Error('the element has no shadow root');
  }
  return element.shadowRoot;
}

/** Every element of the selector in this root and in the roots of the parts below it. */
function find(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  for (const each of root.querySelectorAll('*')) {
    if (each.shadowRoot !== null) {
      found.push(...find(each.shadowRoot, selector));
    }
  }
  return found;
}

/** The text of this root with the text of the parts below it. */
function textIn(root: ParentNode): string {
  const parts = [...root.querySelectorAll('*')].flatMap((each) =>
    each.shadowRoot === null ? [] : [textIn(each.shadowRoot)],
  );
  return `${root.textContent ?? ''} ${parts.join(' ')}`;
}

/** All the element shows, as one line. */
function textOf(element: Management): string {
  return textIn(rootOf(element)).replaceAll(/\s+/g, ' ');
}

/** The first button with this text or this label. */
function button(element: Management, label: string): HTMLButtonElement {
  const found = find(rootOf(element), 'button').find(
    (each) => each.textContent?.trim() === label || each.getAttribute('aria-label') === label,
  );
  if (found === undefined) {
    throw new Error(`no button "${label}"`);
  }
  return found as HTMLButtonElement;
}

async function click(element: Management, label: string): Promise<void> {
  button(element, label).click();
  await settled(element);
}

/** Types into the open form and sends it. */
async function fill(element: Management, text: string): Promise<void> {
  const input = find(rootOf(element), 'form input[name=text]')[0] as HTMLInputElement | undefined;
  if (input === undefined) {
    throw new Error('no form open');
  }
  input.value = text;
  input.form?.dispatchEvent(new Event('submit', { cancelable: true }));
  await settled(element);
}

/** Picks the workpiece of this name in the list. */
async function pickWorkpiece(element: Management, name: string): Promise<HTMLElement> {
  const item = (find(rootOf(element), '.item') as HTMLElement[]).find(
    (each) => each.querySelector('.name')?.textContent?.trim() === name,
  );
  if (item === undefined) {
    throw new Error(`no workpiece "${name}"`);
  }
  item.click();
  await settled(element);
  return item;
}

/** Gives this group access to the shown room. */
async function give(element: Management, groupId: string): Promise<void> {
  const select = find(rootOf(element), 'select')[0] as HTMLSelectElement | undefined;
  if (select === undefined) {
    throw new Error('no group to give access to');
  }
  select.value = groupId;
  select.form?.dispatchEvent(new Event('submit', { cancelable: true }));
  await settled(element);
}

/** The German text of every right. */
const CHIPS: Record<string, string> = {
  see: 'Sehen',
  edit: 'Bearbeiten',
  plan: 'Planen',
};

/** Switches one right in the access card of this name; anonymous takes the way not yet chosen. */
async function toggle(element: Management, row: string, right: string): Promise<void> {
  const card = find(rootOf(element), 'ck-access-card').find(
    (each) => each.shadowRoot?.querySelector('.name')?.textContent?.trim() === row,
  )?.shadowRoot;
  const chip =
    right === 'anonymous'
      ? [...(card?.querySelectorAll('.seg button') ?? [])].find(
          (each) => each.getAttribute('aria-pressed') === 'false',
        )
      : [...(card?.querySelectorAll('.chip') ?? [])].find(
          (each) => each.textContent?.trim() === CHIPS[right],
        );
  if (!(chip instanceof HTMLElement)) {
    throw new Error(`no right "${right}" in the row "${row}"`);
  }
  chip.click();
  await settled(element);
}

beforeAll(async () => {
  storage = await connect({ uri, database });
  await applyDefinitions(storage.db, collectionDefinitions);

  const hub = createWorkpieceHub({ db: storage.db, logger: silent });
  const checkToken = createTokenCheck({
    key: secret,
    algorithm: 'HS256',
    top: { claim: 'globalRole', values: ['ADMIN'] },
  });
  server = createServer({
    logger: silent,
    api: createApi({
      db: storage.db,
      hub,
      checkToken,
      logger: silent,
      recheckAccess: () => gateway.recheck(),
    }),
  });
  gateway = attachGateway({ server, db: storage.db, hub, checkToken, logger: silent });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  alice = as('alice', true);
  bob = as('bob');
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.db.dropDatabase();
  await storage.close();
  await page.happyDOM.close();
});

describe('<ck-management>', () => {
  it('lets one at the top create a room and a group and switch the rights of the group there', async () => {
    const element = await mount(alice);

    await click(element, 'Raum anlegen');
    await fill(element, 'Übung 3');
    const room = (await alice.me.rooms()).find((each) => each.name === 'Übung 3');
    expect(room).toBeDefined();

    await click(element, 'Gruppen');
    await click(element, 'Gruppe anlegen');
    await fill(element, 'Team A');
    const group = (await alice.groups.list()).find((each) => each.name === 'Team A');
    expect(group).toBeDefined();

    await click(element, 'Räume');
    await give(element, group?._id ?? '');
    await toggle(element, 'Team A', 'edit');
    const scope = { kind: 'room', id: room?._id ?? '' };
    expect(await alice.grants.list({ scope })).toMatchObject([
      { groupId: group?._id, rights: ['see', 'edit'] },
    ]);

    // Without any right left the grant goes.
    await toggle(element, 'Team A', 'see');
    await toggle(element, 'Team A', 'edit');
    expect(await alice.grants.list({ scope })).toEqual([]);
    expect(textOf(element)).toContain('Noch keine Gruppe hat hier Zugriff.');
  });

  it('adds members through findPeople or by key, and removes them', async () => {
    const group = await alice.groups.create({ name: 'Team B' });
    const element = await mount(alice, {
      findPeople: async (text) =>
        text === 'bo'
          ? [{ actorId: 'bob', label: 'Bob' }]
          : text === 'c'
            ? [{ actorId: 'carol', label: 'Carol' }, { actorId: 'dave' }]
            : [],
    });
    await click(element, 'Gruppen');
    await click(element, 'Team B');

    // One found is taken at once, of several one is picked.
    await click(element, 'Mitglied aufnehmen');
    await fill(element, 'bo');
    await click(element, 'Mitglied aufnehmen');
    await fill(element, 'c');
    await click(element, 'Carol');
    expect((await alice.groups.get(group._id)).members).toEqual(['bob', 'carol']);
    // The name findPeople gave, its key beside it.
    const carol = find(rootOf(element), '.row').find(
      (row) => row.querySelector('.key')?.textContent === 'carol',
    );
    expect(carol?.textContent).toContain('Carol');

    await click(element, 'Mitglied aufnehmen');
    await fill(element, 'nobody');
    expect(textOf(element)).toContain('Niemand gefunden.');

    await click(element, 'Entlassen');
    expect((await alice.groups.get(group._id)).members).toEqual(['carol']);

    // Without findPeople the text is the key.
    const plain = await mount(alice);
    await click(plain, 'Gruppen');
    await click(plain, 'Team B');
    await click(plain, 'Mitglied aufnehmen');
    await fill(plain, 'erin');
    expect((await alice.groups.get(group._id)).members).toEqual(['carol', 'erin']);
  });

  it('shows one without manage what is there, and nothing to change it with', async () => {
    const room = await alice.rooms.create({ name: 'Übung 4' });
    const workpiece = await alice.workpieces.create({ name: 'Entwurf', roomId: room._id });
    const team = await alice.groups.create({ name: 'Team D', members: ['bob'] });
    await alice.grants.set({
      groupId: team._id,
      scope: { kind: 'room', id: room._id },
      rights: ['see'],
    });

    const element = await mount(bob);
    const text = textOf(element);
    expect(text).toContain('Übung 4');
    expect(text).toContain('Entwurf');
    for (const absent of ['Raum anlegen', 'Umbenennen', 'Löschen', 'Zugriff der Gruppen']) {
      expect(text).not.toContain(absent);
    }

    // Opening is up to the tool; the element only says which.
    const opened = new Promise<ManagementOpen>((resolve) => {
      element.addEventListener(
        'ck-open',
        (event) => resolve((event as CustomEvent<ManagementOpen>).detail),
        { once: true },
      );
    });
    await click(element, 'Öffnen');
    expect((await opened).workpiece._id).toBe(workpiece._id);
  });

  it('creates a workpiece only with newWorkpiece, as the tool builds it, in the room', async () => {
    const room = await alice.rooms.create({ name: 'Übung 5' });

    const without = await mount(alice);
    await click(without, 'Übung 5');
    expect(textOf(without)).not.toContain('Werkstück anlegen');

    const element = await mount(alice, {
      newWorkpiece: (_room, name) => ({ name, contract: { format: 'test' } }),
    });
    await click(element, 'Übung 5');
    await click(element, 'Werkstück anlegen');
    await fill(element, 'Klassendiagramm');

    const [id] = (await alice.rooms.get(room._id)).workpieces;
    expect(await alice.workpieces.get(id ?? '')).toMatchObject({
      name: 'Klassendiagramm',
      contract: { format: 'test' },
    });
    expect(textOf(element)).toContain('Klassendiagramm');
  });

  it('offers creating a workpiece with edit at the room, not with manage alone', async () => {
    const room = await alice.rooms.create({ name: 'Übung 7' });
    const team = await alice.groups.create({ name: 'Team F', members: ['bob'] });
    const scope = { kind: 'room' as const, id: room._id };
    await alice.grants.set({ groupId: team._id, scope, rights: ['see', 'manage'] });

    const managing = await mount(bob, { newWorkpiece: (_room, name) => ({ name }) });
    await click(managing, 'Übung 7');
    expect(textOf(managing)).not.toContain('Werkstück anlegen');

    await alice.grants.set({ groupId: team._id, scope, rights: ['see', 'edit'] });
    const editing = await mount(bob, { newWorkpiece: (_room, name) => ({ name }) });
    await click(editing, 'Übung 7');
    await click(editing, 'Werkstück anlegen');
    await fill(editing, 'Entwurf');
    expect((await alice.rooms.get(room._id)).workpieces).toHaveLength(1);
  });

  it('switches whether a group writes anonymously, and keeps it while a right is switched', async () => {
    const room = await alice.rooms.create({ name: 'Übung 8' });
    const team = await alice.groups.create({ name: 'Team F', members: ['bob'] });
    const scope = { kind: 'room', id: room._id };
    await alice.grants.set({ groupId: team._id, scope, rights: ['see'] });

    const element = await mount(alice);
    await click(element, 'Übung 8');
    await toggle(element, 'Team F', 'anonymous');
    expect(await alice.grants.list({ scope })).toMatchObject([
      { rights: ['see'], anonymous: true },
    ]);

    await toggle(element, 'Team F', 'edit');
    expect(await alice.grants.list({ scope })).toMatchObject([
      { rights: ['see', 'edit'], anonymous: true },
    ]);
    await toggle(element, 'Team F', 'anonymous');
    const [open] = await alice.grants.list({ scope });
    expect(open?.anonymous).toBeUndefined();
  });

  it('shows the workpieces tab only with manage everywhere', async () => {
    const room = await alice.rooms.create({ name: 'Übung 11' });
    const team = await alice.groups.create({ name: 'Team H', members: ['bob'] });
    await alice.grants.set({
      groupId: team._id,
      scope: { kind: 'room', id: room._id },
      rights: ['see', 'manage'],
    });

    const element = await mount(bob);
    expect(() => button(element, 'Werkstücke')).toThrow();
  });

  it('shows every workpiece with its rooms, the groups there and its traces, and moves it', async () => {
    const first = await alice.rooms.create({ name: 'Ablage A' });
    const second = await alice.rooms.create({ name: 'Ablage B' });
    const workpiece = await alice.workpieces.create({ name: 'Modell', roomId: first._id });
    await alice.workpieces.fork(workpiece._id, { name: 'Modell, Abzweig' });
    await alice.workpieces.checkpoint(workpiece._id, { label: 'erster Stand' });
    const team = await alice.groups.create({ name: 'Team I' });
    await alice.grants.set({
      groupId: team._id,
      scope: { kind: 'room', id: first._id },
      rights: ['see', 'edit'],
    });

    const element = await mount(alice);
    await click(element, 'Werkstücke');
    const fork = await pickWorkpiece(element, 'Modell, Abzweig');
    expect(fork.classList.contains('fork')).toBe(true);
    expect(textOf(element)).toContain('Abzweig von Modell');
    expect(textOf(element)).toContain('Liegt in keinem Raum.');

    const item = await pickWorkpiece(element, 'Modell');
    expect(item.textContent).toContain('in einem Raum');
    const text = textOf(element);
    expect(text).toContain('Team I');
    expect(text).toContain('Ablage A');
    expect(text).toContain('Alice');

    // In the second room too, then out of the first.
    await give(element, second._id);
    expect((await alice.rooms.get(second._id)).workpieces).toContain(workpiece._id);
    expect(item.textContent).toContain('in 2 Räumen');
    await click(element, 'Aus dem Raum nehmen');
    expect((await alice.rooms.get(first._id)).workpieces).not.toContain(workpiece._id);
    expect(textOf(element)).not.toContain('Team I');
  });

  it('shows the first members of a long group and unfolds the rest on request', async () => {
    const members = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    await alice.groups.create({ name: 'Team K', members });

    const element = await mount(alice);
    await click(element, 'Gruppen');
    await click(element, 'Team K');
    expect(find(rootOf(element), '.row')).toHaveLength(5);
    expect(textOf(element)).toContain('Mitglieder (7)');
    expect(textOf(element)).toContain('2 weitere ausgeblendet');

    await click(element, 'Alle 7 anzeigen ▾');
    expect(find(rootOf(element), '.row')).toHaveLength(7);
    await click(element, 'Weniger anzeigen ▴');
    expect(find(rootOf(element), '.row')).toHaveLength(5);
  });

  it('tells a refusal of CK in its own words', async () => {
    const room = await alice.rooms.create({ name: 'Übung 6' });
    const team = await alice.groups.create({ name: 'Team E', members: ['bob'] });
    await alice.grants.set({
      groupId: team._id,
      scope: { kind: 'room', id: room._id },
      rights: ['see', 'manage'],
    });

    // Bob manages the room, but may only pass on what he holds himself.
    const element = await mount(bob);
    await click(element, 'Übung 6');
    await toggle(element, 'Team E', 'plan');
    expect(textOf(element)).toContain('Dafür fehlt dir das Recht.');
    expect(await alice.grants.list({ scope: { kind: 'room', id: room._id } })).toMatchObject([
      { rights: ['see', 'manage'] },
    ]);
  });
});
