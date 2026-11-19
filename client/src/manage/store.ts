/** The data of <ck-management> and every call to CK; the element only draws what it holds. */

import type { ReactiveControllerHost } from 'lit';

import type {
  Activity,
  ActorName,
  ArchiveCapabilities,
  ArchiveEntry,
  Grant,
  Group,
  ManagementOptions,
  ManagementOwnTab,
  Named,
  Reference,
  Right,
  Room,
  Workpiece,
} from '../api.ts';
import type { Texts } from './look/texts.ts';

/** The six rights in the order CK names them. */
export const RIGHTS: readonly Right[] = ['see', 'speak', 'edit', 'plan', 'decide', 'manage'];

/** What one chip of a grant switches: a right, or whether its members write anonymously. */
export type Switch = Right | 'anonymous';

/** Which list is shown; workpieces and archive only with manage everywhere. */
export type Tab = ManagementOwnTab;

/** Every own tab, in the order the bar shows them. */
const TABS: readonly Tab[] = ['rooms', 'groups', 'workpieces', 'archive'];

/** The tabs that take manage everywhere. */
const TOP_TABS: ReadonlySet<Tab> = new Set(['workpieces', 'archive']);

/** What the one open form is for; archive and delete only ask before it happens. */
export type FormKind = 'room' | 'group' | 'workpiece' | 'member' | 'rename' | 'archive' | 'delete';

/** The one form open at a time, with what went wrong or whom findPeople found. */
export interface Form {
  readonly kind: FormKind;
  readonly error?: string;
  readonly found?: readonly ActorName[];
}

/** The own rights at the shown room or group, and its grants where the person may read them. */
export interface Detail {
  readonly place: Reference;
  readonly rights: readonly Right[];
  readonly grants?: readonly Named<Grant>[];
}

/** Who reaches the shown workpiece through its rooms, and who left the last traces on it. */
export interface Use {
  readonly workpieceId: string;
  /** The grants at every room it lies in. */
  readonly grants: readonly Grant[];
  /** The newest trace of each person, newest first. */
  readonly activity: readonly Activity[];
}

/** A workpiece in the list, and whether it stands under its source as a fork. */
export interface Entry {
  readonly workpiece: Workpiece;
  readonly fork: boolean;
}

/** Everything the element shows. */
export interface State {
  readonly tab: Tab;
  /** The id of the tab of the tool shown instead of tab; undefined while an own one is. */
  readonly extra: string | undefined;
  readonly rooms: readonly Named<Room>[];
  readonly groups: readonly Named<Group>[];
  readonly workpieces: ReadonlyMap<string, Workpiece>;
  /** What is in the archive, newest first, as far as the person saw it live. */
  readonly archived: readonly ArchiveEntry[];
  /** What the archive can do for this person; none while unknown, e.g. at a CK without the route. */
  readonly archiveCapabilities: ArchiveCapabilities | undefined;
  /** Names to the keys of people, as CK or findPeople gave them. */
  readonly names: Readonly<Record<string, string>>;
  /** Whether the person holds manage everywhere, which creating a room or a group takes. */
  readonly mayCreate: boolean;
  readonly selected: Readonly<Record<Tab, string | undefined>>;
  readonly detail: Detail | undefined;
  readonly use: Use | undefined;
  readonly form: Form | undefined;
  readonly busy: boolean;
  /** What CK refused last, when no form was open to show it. */
  readonly failure: string | undefined;
  /** What was saved last, until the next call or the next selection. */
  readonly saved: string | undefined;
  readonly loaded: boolean;
}

/** Before ck is set. */
const EMPTY: State = {
  tab: 'rooms',
  extra: undefined,
  rooms: [],
  groups: [],
  workpieces: new Map(),
  archived: [],
  archiveCapabilities: undefined,
  names: {},
  mayCreate: false,
  selected: { rooms: undefined, groups: undefined, workpieces: undefined, archive: undefined },
  detail: undefined,
  use: undefined,
  form: undefined,
  busy: false,
  failure: undefined,
  saved: undefined,
  loaded: false,
};

/** The rights after switching one, in the order of RIGHTS. */
export function switched(rights: readonly Right[], right: Right): Right[] {
  return RIGHTS.filter((each) => (each === right) !== rights.includes(each));
}

/** By name, as people look for them. */
function byName<Item extends { readonly name: string }>(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The code CK named for a refusal, if it named one. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The status CK refused with, if it was a refusal of CK. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { readonly status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Holds the state, asks CK with the ck of the element, and has it drawn again on each change. */
export class Store {
  /** Replaced as a whole on every change, never changed in place. */
  state: State = EMPTY;

  private readonly host: ReactiveControllerHost & ManagementOptions;
  private readonly words: () => Texts;
  /** Calls under way; busy while there is any. */
  private pending = 0;

  constructor(host: ReactiveControllerHost & ManagementOptions, words: () => Texts) {
    this.host = host;
    this.words = words;
  }

  /** Everything the person sees, asked for anew; the selection stays where it still exists. */
  async load(): Promise<void> {
    const ck = this.host.ck;
    this.set({ loaded: false, detail: undefined });
    if (ck === undefined) {
      return;
    }

    await this.run(async () => {
      const [everywhere, rooms, groups, workpieces, archived, archiveCapabilities] =
        await Promise.all([
          ck.me.rights(),
          ck.me.rooms(),
          ck.groups.list(),
          ck.workpieces.list(),
          // With the archive off, CK would refuse the call.
          this.host.archive === true ? ck.archive.list() : Promise.resolve([]),
          // An older CK lacks the route; then the option alone decides.
          this.host.archive === true
            ? ck.archive.capabilities().catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
      // Another ck came meanwhile and loads its own.
      if (ck !== this.host.ck) {
        return;
      }
      this.set({
        mayCreate: everywhere.includes('manage'),
        rooms: byName(rooms),
        groups: byName(groups),
        workpieces: new Map(workpieces.map((workpiece) => [workpiece._id, workpiece])),
        archived,
        archiveCapabilities,
        loaded: true,
      });
      // The tool, or another person lacking manage everywhere, may leave the current tab out.
      const shown = this.shownTabs();
      this.set({ tab: shown.includes(this.state.tab) ? this.state.tab : (shown[0] ?? 'rooms') });
      this.takeNames(...groups);
      await this.select(this.keptOrFirst(this.state.tab));
      await this.fit();
    });
  }

  /** The own tabs in the bar: those the tool chose, workpieces and archive only with manage everywhere, archive only if switched on. */
  shownTabs(): Tab[] {
    const chosen = this.host.tabs ?? TABS;
    return TABS.filter(
      (tab) =>
        chosen.includes(tab) &&
        (this.state.mayCreate || !TOP_TABS.has(tab)) &&
        (tab !== 'archive' || this.host.archive === true),
    );
  }

  /** Moves off an own tab no longer shown: to the first one left, else to the first tab of the tool. */
  async fit(): Promise<void> {
    if (!this.state.loaded || this.state.extra !== undefined) {
      return;
    }
    const shown = this.shownTabs();
    if (shown.includes(this.state.tab)) {
      return;
    }
    const [first] = shown;
    if (first !== undefined) {
      await this.show(first);
      return;
    }
    // No own tab is left, so a tab of the tool shows if there is one.
    const [extra] = this.host.extraTabs ?? [];
    if (extra !== undefined) {
      this.showExtra(extra.id);
    }
  }

  async show(tab: Tab): Promise<void> {
    this.set({ tab, extra: undefined, form: undefined, failure: undefined, saved: undefined });
    await this.select(this.keptOrFirst(tab));
  }

  /** Shows the slot of a tab of the tool; the own tab stays as it was, for going back. */
  showExtra(id: string | undefined): void {
    this.set({ extra: id, form: undefined, failure: undefined, saved: undefined });
  }

  /** Shows this room, group or workpiece of the tab, with what holds there. */
  async select(id: string | undefined): Promise<void> {
    this.set({
      selected: { ...this.state.selected, [this.state.tab]: id },
      form: undefined,
      saved: undefined,
    });
    await (this.state.tab === 'workpieces' ? this.loadUse() : this.loadDetail());
  }

  room(): Named<Room> | undefined {
    return this.state.rooms.find((room) => room._id === this.state.selected.rooms);
  }

  group(): Named<Group> | undefined {
    return this.state.groups.find((group) => group._id === this.state.selected.groups);
  }

  workpiece(): Workpiece | undefined {
    const id = this.state.selected.workpieces;
    return id === undefined ? undefined : this.state.workpieces.get(id);
  }

  archiveEntry(): ArchiveEntry | undefined {
    return this.state.archived.find((entry) => entry._id === this.state.selected.archive);
  }

  /** Every workpiece by name, each fork under its source where the source is known. */
  entries(): Entry[] {
    const all = byName([...this.state.workpieces.values()]);
    const sourceOf = (workpiece: Workpiece) =>
      workpiece.forkOf !== undefined && this.state.workpieces.has(workpiece.forkOf.id)
        ? workpiece.forkOf.id
        : undefined;

    // A fork of a fork stands under that fork, so none is lost.
    const under = (id: string | undefined): Entry[] =>
      all
        .filter((workpiece) => sourceOf(workpiece) === id)
        .flatMap((workpiece) =>
          [{ workpiece, fork: id !== undefined }].concat(under(workpiece._id)),
        );
    return under(undefined);
  }

  /** The rooms this workpiece lies in. */
  roomsOf(workpieceId: string): Named<Room>[] {
    return this.state.rooms.filter((room) => room.workpieces.includes(workpieceId));
  }

  /** The detail of this room or group, if it is the one loaded. */
  detailOf(id: string): Detail | undefined {
    return this.state.detail?.place.id === id ? this.state.detail : undefined;
  }

  /** Where a grant of a group holds, by name where the person knows the place. */
  placeName(scope: Reference | undefined): string {
    if (scope === undefined) {
      return this.words().everywhere;
    }
    const { rooms, groups, workpieces } = this.state;
    const known =
      scope.kind === 'room'
        ? rooms.find((room) => room._id === scope.id)
        : scope.kind === 'group'
          ? groups.find((group) => group._id === scope.id)
          : scope.kind === 'workpiece'
            ? workpieces.get(scope.id)
            : undefined;
    return known?.name ?? `${scope.kind} ${scope.id}`;
  }

  /** Opens this form, or closes it when it is already open. */
  openForm(kind: FormKind): void {
    this.set({ form: this.state.form?.kind === kind ? undefined : { kind } });
  }

  closeForm(): void {
    this.set({ form: undefined });
  }

  /** Typing again takes away what went wrong and whom findPeople found. */
  clearError(): void {
    const { form } = this.state;
    if (form !== undefined && (form.error !== undefined || form.found !== undefined)) {
      this.set({ form: { kind: form.kind } });
    }
  }

  /** The text of a form, checked here, then carried out by CK. */
  async submit(kind: FormKind, text: string, choice?: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') {
      const t = this.words();
      this.set({ form: { kind, error: kind === 'member' ? t.keyMissing : t.nameMissing } });
      return;
    }
    await this.run(() => this.carryOut(kind, trimmed, choice));
  }

  async takeOut(room: Room, workpieceId: string): Promise<void> {
    await this.run(async () => {
      this.replaceRoom(await this.ck().rooms.removeWorkpiece(room._id, workpieceId));
      await this.loadUseIfShown();
    });
  }

  /** Puts a workpiece into one more room. */
  async putIn(roomId: string, workpieceId: string): Promise<void> {
    await this.run(async () => {
      this.replaceRoom(await this.ck().rooms.addWorkpiece(roomId, workpieceId));
      await this.loadUseIfShown();
    });
  }

  /** A group gets access to the room, at first only to see it. */
  async give(room: Room, groupId: string): Promise<void> {
    await this.run(async () => {
      const grant = await this.ck().grants.set({
        groupId,
        scope: { kind: 'room', id: room._id },
        rights: ['see'],
      });
      this.takeNames(grant);
      this.changeGrants((grants) => [...grants, grant]);
      this.set({ saved: this.words().savedGive });
    });
  }

  /** A group gets access everywhere, which holds in every room; at first only to see. */
  async giveEverywhere(group: Group): Promise<void> {
    await this.run(async () => {
      const grant = await this.ck().grants.set({ groupId: group._id, rights: ['see'] });
      this.takeNames(grant);
      this.changeGrants((grants) => [...grants, grant]);
      this.set({ saved: this.words().savedGive });
    });
  }

  /** Takes a grant away whole, once the person has been asked. */
  async removeGrant(grant: Grant): Promise<void> {
    await this.run(() => this.dropGrant(grant));
  }

  /** Switches one right of a grant or its flag; without any right left the grant goes. */
  async toggle(grant: Grant, chip: Switch): Promise<void> {
    const rights = chip === 'anonymous' ? [...grant.rights] : switched(grant.rights, chip);
    // Set whole, so the flag goes along with every right switched, and stays as it was.
    const anonymous = (grant.anonymous === true) !== (chip === 'anonymous');
    const which =
      grant.scope === undefined
        ? { groupId: grant.groupId }
        : { groupId: grant.groupId, scope: grant.scope };

    await this.run(async () => {
      if (rights.length === 0) {
        await this.dropGrant(grant);
        return;
      }
      const changed = await this.ck().grants.set({ ...which, rights, anonymous });
      this.takeNames(changed);
      this.changeGrants((grants) =>
        grants.map((each) => (each._id === grant._id ? changed : each)),
      );
      this.set({ saved: this.words().saved });
    });
  }

  /** Removes the grant at CK and from what is shown. */
  private async dropGrant(grant: Grant): Promise<void> {
    const which =
      grant.scope === undefined
        ? { groupId: grant.groupId }
        : { groupId: grant.groupId, scope: grant.scope };
    await this.ck().grants.remove(which);
    this.changeGrants((grants) => grants.filter((each) => each._id !== grant._id));
    this.set({ saved: this.words().savedRemoved });
  }

  /** One of the people findPeople gave becomes a member. */
  async pick(group: Group, person: ActorName): Promise<void> {
    await this.run(() => this.addMember(group, person));
  }

  async dismiss(group: Group, actorId: string): Promise<void> {
    await this.run(async () => {
      this.replaceGroup(await this.ck().groups.removeMember(group._id, actorId));
    });
  }

  /** Moves the shown room, group or workpiece into the archive, once asked again. */
  async archive(): Promise<void> {
    const { tab, selected } = this.state;
    const id = selected[tab];
    if (id === undefined || tab === 'archive') {
      return;
    }

    await this.run(async () => {
      const ck = this.ck();
      await (tab === 'rooms'
        ? ck.rooms.archive(id)
        : tab === 'groups'
          ? ck.groups.archive(id)
          : ck.workpieces.archive(id));
      // Rooms, forks and the archive changed with it, so everything is asked for anew.
      this.set({ form: undefined });
      await this.load();
      this.set({ saved: this.words().savedArchived });
    });
  }

  /** Brings the shown entry of the archive back, where it was before. */
  async restore(): Promise<void> {
    const id = this.state.selected.archive;
    if (id === undefined) {
      return;
    }

    await this.run(async () => {
      await this.ck().archive.restore(id);
      await this.load();
      this.set({ saved: this.words().savedRestored });
    });
  }

  /** Deletes the shown entry of the archive for good, once asked again, and shows the next one. */
  async deleteForGood(): Promise<void> {
    const id = this.state.selected.archive;
    if (id === undefined) {
      return;
    }

    await this.run(async () => {
      await this.ck().archive.remove(id);
      this.set({
        archived: this.state.archived.filter((entry) => entry._id !== id),
        form: undefined,
      });
      await this.select(this.keptOrFirst('archive'));
      this.set({ saved: this.words().savedDeleted });
    });
  }

  /** What a form asks for; each change takes over the answer of CK. */
  private async carryOut(kind: FormKind, text: string, choice?: string): Promise<void> {
    const ck = this.ck();

    switch (kind) {
      case 'room': {
        const room = await ck.rooms.create({ name: text });
        this.set({ rooms: byName([...this.state.rooms, room]), form: undefined });
        await this.select(room._id);
        return;
      }
      case 'group': {
        const group = await ck.groups.create({ name: text });
        this.takeNames(group);
        this.set({ groups: byName([...this.state.groups, group]), form: undefined });
        await this.select(group._id);
        return;
      }
      case 'rename': {
        const place = this.place();
        if (place?.kind === 'room') {
          this.replaceRoom(await ck.rooms.update(place.id, { name: text }));
        } else if (place?.kind === 'group') {
          this.replaceGroup(await ck.groups.update(place.id, { name: text }));
        }
        this.set({ form: undefined });
        return;
      }
      case 'workpiece': {
        // In the workpieces tab the room is the one picked, in a room the one shown.
        const room =
          choice === undefined ? this.room() : this.state.rooms.find((each) => each._id === choice);
        const make = this.host.newWorkpiece;
        if (room === undefined || make === undefined) {
          return;
        }
        // The tool builds it, the room is the one it was created in.
        const made = await make(room, text);
        const workpiece = await ck.workpieces.create({ ...made, roomId: room._id });
        this.set({
          workpieces: new Map(this.state.workpieces).set(workpiece._id, workpiece),
          form: undefined,
        });
        this.replaceRoom(await ck.rooms.get(room._id));
        if (this.state.tab === 'workpieces') {
          await this.select(workpiece._id);
        }
        return;
      }
      case 'member': {
        const group = this.group();
        if (group === undefined) {
          return;
        }
        const find = this.host.findPeople;
        if (find === undefined) {
          await this.addMember(group, { actorId: text });
          return;
        }
        // One found is taken at once, several are offered to pick from.
        const found = await find(text);
        const [only] = found;
        if (found.length === 1 && only !== undefined) {
          await this.addMember(group, only);
        } else {
          const error = this.words().nobodyFound;
          this.set({ form: found.length === 0 ? { kind, error } : { kind, found } });
        }
        return;
      }
      case 'archive':
      case 'delete':
        return;
    }
  }

  /** The own rights at the shown place, and its grants if manage there lets them be read. */
  private async loadDetail(): Promise<void> {
    const ck = this.host.ck;
    const place = this.place();
    this.set({ detail: undefined });
    if (ck === undefined || place === undefined) {
      return;
    }

    await this.run(async () => {
      const rights = await ck.me.rights(place);
      const grants = rights.includes('manage')
        ? await ck.grants.list(place.kind === 'group' ? { groupId: place.id } : { scope: place })
        : undefined;
      // Another room or group may have been picked meanwhile.
      if (this.place()?.id !== place.id) {
        return;
      }
      if (grants === undefined) {
        this.set({ detail: { place, rights } });
        return;
      }
      this.takeNames(...grants);
      this.set({ detail: { place, rights, grants } });
    });
  }

  /** The grants at the rooms of the shown workpiece, and the newest trace of each person on it. */
  private async loadUse(): Promise<void> {
    const ck = this.host.ck;
    const workpiece = this.workpiece();
    this.set({ use: undefined });
    if (ck === undefined || workpiece === undefined) {
      return;
    }

    await this.run(async () => {
      const scopes = this.roomsOf(workpiece._id).map((room) => ({ kind: 'room', id: room._id }));
      const [grants, activity] = await Promise.all([
        Promise.all(scopes.map((scope) => ck.grants.list({ scope }))),
        ck.workpieces.activity(workpiece._id),
      ]);
      // Another workpiece may have been picked meanwhile.
      if (this.workpiece()?._id !== workpiece._id) {
        return;
      }
      this.takeNames(...grants.flat(), ...activity);
      this.set({
        use: {
          workpieceId: workpiece._id,
          grants: grants.flat(),
          activity: activity.toSorted((a, b) => b.at.localeCompare(a.at)),
        },
      });
    });
  }

  /** After a workpiece moved, its rooms and their grants are others. */
  private async loadUseIfShown(): Promise<void> {
    if (this.state.tab === 'workpieces') {
      await this.loadUse();
    }
  }

  /** Adds a member; a name from findPeople stands in until CK knows one itself. */
  private async addMember(group: Group, person: ActorName): Promise<void> {
    const changed = await this.ck().groups.addMember(group._id, person.actorId);
    if (person.label !== undefined) {
      this.set({ names: { [person.actorId]: person.label, ...this.state.names } });
    }
    this.replaceGroup(changed);
    this.set({ form: undefined });
  }

  /** The shown room or group; a workpiece or an entry of the archive is no place renamed here. */
  private place(): Reference | undefined {
    const { tab, selected } = this.state;
    const id = selected[tab];
    return id === undefined || TOP_TABS.has(tab)
      ? undefined
      : { kind: tab === 'rooms' ? 'room' : 'group', id };
  }

  private keptOrFirst(tab: Tab): string | undefined {
    const items: readonly { readonly _id: string }[] =
      tab === 'rooms'
        ? this.state.rooms
        : tab === 'groups'
          ? this.state.groups
          : tab === 'archive'
            ? this.state.archived
            : this.entries().map((entry) => entry.workpiece);
    const kept = this.state.selected[tab];
    return items.some((item) => item._id === kept) ? kept : items[0]?._id;
  }

  private changeGrants(change: (grants: readonly Named<Grant>[]) => readonly Named<Grant>[]): void {
    const { detail } = this.state;
    if (detail?.grants !== undefined) {
      this.set({ detail: { ...detail, grants: change(detail.grants) } });
    }
  }

  private replaceRoom(room: Named<Room>): void {
    const rooms = this.state.rooms.map((each) => (each._id === room._id ? room : each));
    this.set({ rooms: byName(rooms) });
  }

  private replaceGroup(group: Named<Group>): void {
    this.takeNames(group);
    const groups = this.state.groups.map((each) => (each._id === group._id ? group : each));
    this.set({ groups: byName(groups) });
  }

  /** Keeps the names CK put into its answers. */
  private takeNames(...answers: readonly Named<object>[]): void {
    const names = { ...this.state.names };
    for (const answer of answers) {
      Object.assign(names, answer.names);
    }
    this.set({ names });
  }

  /** The ck of the element; actions come only from what it drew, so only once there is one. */
  private ck(): NonNullable<ManagementOptions['ck']> {
    const { ck } = this.host;
    if (ck === undefined) {
      throw new Error('ck is not set');
    }
    return ck;
  }

  /** Takes over a change and has the element drawn again. */
  private set(change: Partial<State>): void {
    this.state = { ...this.state, ...change };
    this.host.requestUpdate();
  }

  /** Runs calls to CK; a refusal shows in the open form, else above the lists. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.pending += 1;
    this.set({ busy: true, failure: undefined, saved: undefined });
    try {
      await action();
    } catch (error) {
      const message = this.messageOf(error);
      const { form } = this.state;
      this.set(
        form === undefined ? { failure: message } : { form: { kind: form.kind, error: message } },
      );
    } finally {
      this.pending -= 1;
      this.set({ busy: this.pending > 0 });
    }
  }

  /** What went wrong in words of the element where it has some, else as CK said it. */
  private messageOf(error: unknown): string {
    const t = this.words();
    const status = statusOf(error);
    const code = codeOf(error);
    if (code === 'archive_disabled') {
      return t.archiveDisabled;
    }
    if (code === 'delete_disabled') {
      return t.deleteDisabled;
    }
    if (status === 401) {
      return t.signedOut;
    }
    if (status === 403) {
      return t.notAllowed;
    }
    if (status === 404) {
      return t.notFound;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
