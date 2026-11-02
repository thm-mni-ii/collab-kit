/** <ck-group-detail>: one group, its members, and what it may do where. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { ActorName, Grant, Group, Reference } from '../../api.ts';
import { cross, plus } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { Form } from '../store.ts';
import { emit } from './events.ts';
import { counted } from './wording.ts';
import './access-card.ts';
import './fold.ts';
import './legend.ts';
import './form.ts';
import './head.ts';

/** The group with its members, and with manage the places where it may do something. */
export class CkGroupDetail extends LitElement {
  static override properties = {
    t: { attribute: false },
    group: { attribute: false },
    names: { attribute: false },
    manages: { attribute: false },
    grants: { attribute: false },
    searches: { attribute: false },
    mayEverywhere: { attribute: false },
    leaving: { state: true },
    busy: { attribute: false },
    form: { attribute: false },
    placeName: { attribute: false },
  };

  static override styles = [
    base,
    css`
      .switch {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        margin-top: 14px;
        padding: 10px 12px;
        text-align: left;
        background: var(--surface-alt);
        border: 1px solid var(--border);
        border-radius: var(--radius);
      }
      .switch .text {
        flex: 1;
      }
      .switch .text b {
        display: block;
        font-weight: 500;
      }
      .switch .text span {
        font-size: 12px;
        color: var(--text-muted);
      }
      .track {
        position: relative;
        flex: none;
        width: 36px;
        height: 20px;
        background: var(--border);
        border-radius: 10px;
      }
      .track::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        background: var(--surface);
        border-radius: 50%;
      }
      .switch[aria-checked='true'] .track {
        background: var(--accent);
      }
      .switch[aria-checked='true'] .track::after {
        left: 18px;
      }
    `,
  ];

  declare t: Texts;
  declare group: Group;
  /** Names to the keys of members, as far as CK or the tool knows one. */
  declare names: Readonly<Record<string, string>>;
  /** Whether the own person holds manage at the group. */
  declare manages: boolean;
  /** The grants of the group wherever they are, read only with manage at it. */
  declare grants: readonly Grant[] | undefined;
  /** Whether the tool gave findPeople, so a member is searched and not typed as a key. */
  declare searches: boolean;
  /** Whether the own person may give and take access everywhere, which takes manage there. */
  declare mayEverywhere: boolean;
  /** Whether the person is asked before access everywhere goes. */
  declare leaving: boolean;
  declare busy: boolean;
  /** The open form; for a member it holds the people findPeople gave, when it was more than one. */
  declare form: Form | undefined;
  declare placeName: (scope: Reference | undefined) => string;

  constructor() {
    super();
    this.leaving = false;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Another group, or its access changed, so the question no longer fits.
    if (changed.has('group') || changed.has('grants')) {
      this.leaving = false;
    }
  }

  protected override render(): TemplateResult {
    const { t, group, form } = this;

    return html`
      <ck-head
        .t=${t}
        .name=${group.name}
        .manages=${this.manages}
        .nameLabel=${t.groupName}
        .question=${t.removeGroup}
        .form=${form}
        .busy=${this.busy}
      ></ck-head>
      <h3>${counted(t.members, group.members.length)}</h3>
      <p class="lead">${t.leadMembers}</p>
      ${
        group.members.length === 0
          ? html`<p class="empty">${t.noMembers}</p>`
          : html`<ck-fold
              .t=${t}
              .limit=${5}
              .items=${group.members.map((actorId) => this.memberRow(actorId))}
            ></ck-fold>`
      }
      ${
        this.manages
          ? html`<button
              class="link"
              @click=${() => emit(this, 'ck-form-open', { kind: 'member' })}
            >
              ${plus} ${t.addMember}
            </button>`
          : nothing
      }
      ${
        this.manages && form?.kind === 'member'
          ? html`<ck-form
                .t=${t}
                .kind=${'member'}
                .placeholder=${this.searches ? t.memberSearch : t.memberKey}
                .label=${t.add}
                .busy=${this.busy}
                .error=${form.error}
              ></ck-form>
              ${form.found === undefined ? nothing : this.found(form.found)}`
          : nothing
      }
      ${this.grants === undefined ? nothing : this.everywhere(this.grants)}
      ${this.grants === undefined ? nothing : this.access(this.grants)}
    `;
  }

  /** One member by name, its key beside it; without a name only the key. */
  private memberRow(actorId: string): TemplateResult {
    const { t } = this;
    const name = this.names[actorId];

    return html`<div class="row">
      <span>
        ${name ?? actorId}${name === undefined ? nothing : html`<span class="key">${actorId}</span>`}
      </span>
      ${
        this.manages
          ? html`<button
              class="link danger icon"
              aria-label=${t.dismiss}
              title=${t.dismiss}
              ?disabled=${this.busy}
              @click=${() => emit(this, 'ck-member-dismiss', { actorId })}
            >
              ${cross}
            </button>`
          : nothing
      }
    </div>`;
  }

  /** The people findPeople gave, one of them to pick. */
  private found(found: readonly ActorName[]): TemplateResult {
    return html`<p class="hint">${this.t.pick}</p>
      <div class="chips">
        ${found.map(
          (person) =>
            html`<button
              class="chip"
              ?disabled=${this.busy}
              @click=${() => emit(this, 'ck-member-pick', { person })}
            >
              ${person.label ?? person.actorId}
            </button>`,
        )}
      </div>`;
  }

  /** The switch for access in all rooms, and the card of it once it is on. */
  private everywhere(grants: readonly Grant[]): TemplateResult | typeof nothing {
    const { t } = this;
    const global = grants.find((grant) => grant.scope === undefined);
    if (!this.mayEverywhere && global === undefined) {
      return nothing;
    }

    return html`${
      this.mayEverywhere
        ? html`<button
            class="switch"
            role="switch"
            aria-checked=${global !== undefined}
            ?disabled=${this.busy}
            @click=${() =>
              global === undefined ? emit(this, 'ck-grant-give-everywhere') : (this.leaving = true)}
          >
            <span class="text">
              <b>${t.everywhereLabel}</b>
              <span>${global === undefined ? t.everywhereOff : t.everywhereOn}</span>
            </span>
            <span class="track"></span>
          </button>`
        : nothing
    }
    ${
      global !== undefined && this.leaving
        ? html`<div class="warn" role="alert">
            ${t.warnEverywhere}
            <div class="actions">
              <button
                class="button primary"
                ?disabled=${this.busy}
                @click=${() => emit(this, 'ck-grant-remove', { grant: global })}
              >
                ${t.warnYes}
              </button>
              <button class="button" @click=${() => (this.leaving = false)}>${t.cancel}</button>
            </div>
          </div>`
        : nothing
    }
    ${
      global === undefined
        ? nothing
        : html`<ck-access-card
            style="margin-top: 8px"
            .t=${t}
            .heading=${t.allRooms}
            .headingHint=${t.hintEverywhere}
            .subject=${t.thisGroup}
            .where=${t.whereEverywhere}
            .grant=${global}
            .busy=${this.busy}
          ></ck-access-card>`
    }`;
  }

  /** The places where the group has a grant in a single room, each as a card. */
  private access(all: readonly Grant[]): TemplateResult {
    const { t } = this;
    const grants = all.filter((grant) => grant.scope !== undefined);

    return html`<div class="section">
        <h3>${counted(t.groupAccess, grants.length)}</h3>
        <ck-legend .t=${t}></ck-legend>
        <p class="lead">${t.leadGroupAccess}</p>
      </div>
      ${
        grants.length === 0
          ? html`<p class="empty">${t.groupHasNone}</p>`
          : html`<ck-fold
              .t=${t}
              .limit=${3}
              .items=${grants.map(
                (grant) =>
                  html`<ck-access-card
                    .t=${t}
                    .heading=${this.placeName(grant.scope)}
                    .headingHint=${grant.scope === undefined ? t.hintEverywhere : undefined}
                    .subject=${t.thisGroup}
                    .where=${
                      grant.scope === undefined
                        ? t.whereEverywhere
                        : t.wherePlace.replace('{name}', this.placeName(grant.scope))
                    }
                    .grant=${grant}
                    .busy=${this.busy}
                  ></ck-access-card>`,
              )}
            ></ck-fold>`
      }`;
  }
}
