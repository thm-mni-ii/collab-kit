/** <ck-management>: the element; it draws what the store holds, puts the parts together and hands every action to the store. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';

import type {
  CollabKitApi,
  ManagementElement,
  ManagementOpen,
  ManagementOptions,
  Room,
  Workpiece,
} from '../api.ts';
import { info, plus } from './look/icons.ts';
import { textsFor, type Texts } from './look/texts.ts';
import { base, frame, tokens } from './look/theme.ts';
import type { PartEvents } from './parts/events.ts';
import { roomCount } from './parts/workpiece.ts';
import { Store, type FormKind, type Tab } from './store.ts';

/** What a tool sets, as properties and the lang attribute; the rest lives in the store. */
export class Management extends LitElement implements ManagementElement {
  static override properties = {
    ck: { attribute: false },
    newWorkpiece: { attribute: false },
    findPeople: { attribute: false },
    extraTabs: { attribute: false },
    language: { attribute: 'lang' },
    infoOpen: { state: true },
  };

  static override styles = [tokens, base, frame];

  declare ck: CollabKitApi | undefined;
  declare newWorkpiece: ManagementOptions['newWorkpiece'];
  declare findPeople: ManagementOptions['findPeople'];
  declare extraTabs: ManagementOptions['extraTabs'];
  /** The lang attribute; left out, the one of the page counts. */
  declare language: string | undefined;
  /** Whether the longer explanation under the title is shown. */
  declare infoOpen: boolean;

  /** Data and calls to CK; it has the element drawn again on every change. */
  private readonly store = new Store(this, () => this.t);

  constructor() {
    super();
    this.infoOpen = false;
    // What the parts ask for goes to the store, and no further than here.
    this.listen('ck-form-open', ({ kind }) => this.store.openForm(kind));
    this.listen('ck-form-close', () => this.store.closeForm());
    this.listen('ck-form-input', () => this.store.clearError());
    this.listen(
      'ck-form-submit',
      ({ kind, text, choice }) => void this.store.submit(kind, text, choice),
    );
    this.listen('ck-remove', () => void this.store.removePlace());
    this.listen('ck-grant-toggle', ({ grant, chip }) => void this.store.toggle(grant, chip));
    this.listen('ck-grant-give', ({ groupId }) => {
      const room = this.store.room();
      if (room !== undefined) {
        void this.store.give(room, groupId);
      }
    });
    this.listen('ck-grant-give-everywhere', () => {
      const group = this.store.group();
      if (group !== undefined) {
        void this.store.giveEverywhere(group);
      }
    });
    this.listen('ck-grant-remove', ({ grant }) => void this.store.removeGrant(grant));
    this.listen('ck-workpiece-open', ({ workpiece }) => {
      const room = this.store.room();
      if (room !== undefined) {
        this.open(workpiece, room);
      }
    });
    this.listen('ck-workpiece-take-out', ({ roomId, workpieceId }) => {
      const room = this.store.state.rooms.find((each) => each._id === roomId);
      if (room !== undefined) {
        void this.store.takeOut(room, workpieceId);
      }
    });
    this.listen('ck-workpiece-put-in', ({ roomId, workpieceId }) => {
      void this.store.putIn(roomId, workpieceId);
    });
    this.listen('ck-member-pick', ({ person }) => {
      const group = this.store.group();
      if (group !== undefined) {
        void this.store.pick(group, person);
      }
    });
    this.listen('ck-member-dismiss', ({ actorId }) => {
      const group = this.store.group();
      if (group !== undefined) {
        void this.store.dismiss(group, actorId);
      }
    });
  }

  /** Asks for rooms, groups and workpieces anew; the selection stays where it still exists. */
  reload(): Promise<void> {
    return this.store.load();
  }

  /** The words in the language of the element, else of the page. */
  private get t(): Texts {
    return textsFor(this.language ?? document.documentElement.lang);
  }

  /** Takes an event of a part and hands what it carries on. */
  private listen<Name extends keyof PartEvents>(
    name: Name,
    handle: (detail: PartEvents[Name]) => void,
  ): void {
    this.addEventListener(name, (event) => {
      event.stopPropagation();
      handle(event.detail as PartEvents[Name]);
    });
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Another ck may be another person, so everything is asked for anew.
    if (changed.has('ck')) {
      void this.store.load();
    }
    // A tab the tool took away is no longer shown.
    const { extra } = this.store.state;
    if (extra !== undefined && !(this.extraTabs ?? []).some((each) => each.id === extra)) {
      this.store.showExtra(undefined);
    }
  }

  protected override updated(): void {
    // Tells screen readers, and whoever waits, that calls to CK are under way.
    this.toggleAttribute('aria-busy', this.store.state.busy);
  }

  protected override render(): TemplateResult | typeof nothing {
    if (this.ck === undefined) {
      return nothing;
    }
    const { t } = this;
    const { tab, extra, failure, saved, mayCreate } = this.store.state;

    return html`<div class="frame">
      <div class="title">
        <h1>${t.title}</h1>
        <button
          class="info"
          aria-label=${t.infoToggle}
          aria-expanded=${this.infoOpen}
          @click=${() => (this.infoOpen = !this.infoOpen)}
        >
          ${info}
        </button>
      </div>
      <p class="subtitle">${t.intro}</p>
      ${this.infoOpen ? this.infoView(t) : nothing}
      <div class="bar" role="tablist">
        ${this.tabButton('rooms', t.rooms)} ${this.tabButton('groups', t.groups)}
        ${mayCreate ? this.tabButton('workpieces', t.workpieces) : nothing}
        ${(this.extraTabs ?? []).map((each) => this.extraButton(each.id, each.label))}
      </div>
      ${failure === undefined ? nothing : html`<p class="error banner" role="alert">${failure}</p>`}
      ${saved === undefined ? nothing : html`<p class="hint banner" role="status">${saved}</p>`}
      ${
        extra === undefined
          ? html`<div class="body">
              <div class="list">
                ${tab === 'workpieces' ? this.workpieceList(t) : this.listView(t)}
              </div>
              <div class="detail">
                ${
                  tab === 'rooms'
                    ? this.roomDetail(t)
                    : tab === 'groups'
                      ? this.groupDetail(t)
                      : this.workpieceDetail(t)
                }
              </div>
            </div>`
          : // What the tab shows the tool puts into its light DOM.
            html`<div class="extra"><slot name=${extra}></slot></div>`
      }
    </div>`;
  }

  /** The longer explanation: the words of the panel and the rules that are not to be seen in it. */
  private infoView(t: Texts): TemplateResult {
    const entries = [
      [t.glossRoom, t.glossRoomText],
      [t.glossWorkpiece, t.glossWorkpieceText],
      [t.glossGroup, t.glossGroupText],
      [t.glossAccess, t.glossAccessText],
      [t.glossEverywhere, t.glossEverywhereText],
      [t.glossPerson, t.glossPersonText],
      [t.glossCreate, t.glossCreateText],
    ];

    return html`<div class="more">
      ${entries.map(([term, text]) => html`<p><b>${term}</b> ${text}</p>`)}
    </div>`;
  }

  private tabButton(tab: Tab, label: string): TemplateResult {
    return html`<button
      class="tab"
      role="tab"
      aria-selected=${this.store.state.extra === undefined && this.store.state.tab === tab}
      @click=${() => void this.store.show(tab)}
    >
      ${label}
    </button>`;
  }

  /** The button of a tab of the tool, with the label the tool gave it. */
  private extraButton(id: string, label: string): TemplateResult {
    return html`<button
      class="tab"
      role="tab"
      aria-selected=${this.store.state.extra === id}
      @click=${() => this.store.showExtra(id)}
    >
      ${label}
    </button>`;
  }

  /** The button at the top of a list that opens the form to create one, and the form once open. */
  private createBlock(
    t: Texts,
    kind: FormKind,
    label: string,
    placeholder: string,
    choices?: readonly { readonly value: string; readonly label: string }[],
  ): TemplateResult {
    const { form, busy } = this.store.state;

    return html`<div class="create">
      <button class="link" @click=${() => this.store.openForm(kind)}>${plus} ${label}</button>
      ${
        form?.kind === kind
          ? html`<ck-form
              block
              .t=${t}
              .kind=${kind}
              .placeholder=${placeholder}
              .label=${t.create}
              .busy=${busy}
              .error=${form.error}
              .choices=${choices}
              .choiceLabel=${t.inRoom}
            ></ck-form>`
          : nothing
      }
    </div>`;
  }

  /** The rooms or the groups the person sees, and creating one with manage everywhere. */
  private listView(t: Texts): TemplateResult {
    const { tab, loaded, mayCreate, selected } = this.store.state;
    const rooms = tab === 'rooms';
    const items: readonly { readonly _id: string; readonly name: string }[] = rooms
      ? this.store.state.rooms
      : this.store.state.groups;

    return html`
      ${
        mayCreate
          ? rooms
            ? this.createBlock(t, 'room', t.newRoom, t.roomName)
            : this.createBlock(t, 'group', t.newGroup, t.groupName)
          : nothing
      }
      <div class="items">
        ${
          !loaded
            ? html`<p class="empty">${t.loading}</p>`
            : items.length === 0
              ? html`<p class="empty">${rooms ? t.noRooms : t.noGroups}</p>`
              : items.map(
                  (item) =>
                    html`<button
                      class="item"
                      aria-current=${item._id === selected[tab]}
                      @click=${() => void this.store.select(item._id)}
                    >
                      ${item.name}
                    </button>`,
                )
        }
      </div>
    `;
  }

  /** Every workpiece, forks under their source, and how many rooms each lies in. */
  private workpieceList(t: Texts): TemplateResult {
    const { store } = this;
    const { loaded, selected, rooms } = store.state;
    const entries = store.entries();
    // A workpiece is made by the tool and lies in a room, so both must be there.
    const creates = this.newWorkpiece !== undefined && rooms.length > 0;

    return html`
      ${
        creates
          ? this.createBlock(
              t,
              'workpiece',
              t.newWorkpiece,
              t.workpieceName,
              rooms.map((room) => ({ value: room._id, label: room.name })),
            )
          : nothing
      }
      <div class="items">
        ${
          !loaded
            ? html`<p class="empty">${t.loading}</p>`
            : entries.length === 0
              ? html`<p class="empty">${t.noWorkpiecesAtAll}</p>`
              : entries.map(
                  ({ workpiece, fork }) =>
                    html`<button
                      class="item ${fork ? 'fork' : ''}"
                      aria-current=${workpiece._id === selected.workpieces}
                      @click=${() => void store.select(workpiece._id)}
                    >
                      <span class="name">${workpiece.name}</span>
                      <span class="sub">${roomCount(t, store.roomsOf(workpiece._id).length)}</span>
                    </button>`,
                )
        }
      </div>
    `;
  }

  private workpieceDetail(t: Texts): TemplateResult | typeof nothing {
    const { store } = this;
    const workpiece = store.workpiece();
    if (workpiece === undefined) {
      return nothing;
    }
    const { forkOf } = workpiece;

    return html`<ck-workpiece-detail
      .t=${t}
      .workpiece=${workpiece}
      .source=${forkOf === undefined ? undefined : store.state.workpieces.get(forkOf.id)}
      .rooms=${store.state.rooms}
      .groups=${store.state.groups}
      .use=${store.state.use}
      .names=${store.state.names}
      .busy=${store.state.busy}
    ></ck-workpiece-detail>`;
  }

  private roomDetail(t: Texts): TemplateResult | typeof nothing {
    const { store } = this;
    const room = store.room();
    if (room === undefined) {
      return nothing;
    }
    const detail = store.detailOf(room._id);

    return html`<ck-room-detail
      .t=${t}
      .room=${room}
      .workpieces=${store.state.workpieces}
      .groups=${store.state.groups}
      .manages=${detail?.rights.includes('manage') === true}
      .edits=${detail?.rights.includes('edit') === true}
      .grants=${detail?.grants}
      .creates=${this.newWorkpiece !== undefined}
      .busy=${store.state.busy}
      .form=${store.state.form}
    ></ck-room-detail>`;
  }

  private groupDetail(t: Texts): TemplateResult | typeof nothing {
    const { store } = this;
    const group = store.group();
    if (group === undefined) {
      return nothing;
    }
    const detail = store.detailOf(group._id);

    return html`<ck-group-detail
      .t=${t}
      .group=${group}
      .names=${store.state.names}
      .manages=${detail?.rights.includes('manage') === true}
      .grants=${detail?.grants}
      .searches=${this.findPeople !== undefined}
      .mayEverywhere=${store.state.mayCreate}
      .busy=${store.state.busy}
      .form=${store.state.form}
      .placeName=${(scope: Parameters<Store['placeName']>[0]) => store.placeName(scope)}
    ></ck-group-detail>`;
  }

  /** Tells the tool which workpiece to open; what opening means is up to it. */
  private open(workpiece: Workpiece, room: Room): void {
    const detail: ManagementOpen = { workpiece, room };
    this.dispatchEvent(new CustomEvent('ck-open', { detail, bubbles: true, composed: true }));
  }
}
