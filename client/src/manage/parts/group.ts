/** <ck-group-detail>: one group, its members, and what it may do where. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';

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
    busy: { attribute: false },
    form: { attribute: false },
    placeName: { attribute: false },
  };

  static override styles = [base];

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
  declare busy: boolean;
  /** The open form; for a member it holds the people findPeople gave, when it was more than one. */
  declare form: Form | undefined;
  declare placeName: (scope: Reference | undefined) => string;

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

  /** The places where the group has a grant, each as a card. */
  private access(grants: readonly Grant[]): TemplateResult {
    const { t } = this;

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
