/** <ck-room-detail>: one room, its workpieces, and what each group may do there. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';

import type { Grant, Group, Room, Workpiece } from '../../api.ts';
import { plus, cross, forward } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { Form } from '../store.ts';
import { emit } from './events.ts';
import './access-card.ts';
import './legend.ts';
import './form.ts';
import './head.ts';

/** The room with its workpieces, and with manage the groups that may do something here. */
export class CkRoomDetail extends LitElement {
  static override properties = {
    t: { attribute: false },
    room: { attribute: false },
    workpieces: { attribute: false },
    groups: { attribute: false },
    manages: { attribute: false },
    edits: { attribute: false },
    grants: { attribute: false },
    creates: { attribute: false },
    busy: { attribute: false },
    form: { attribute: false },
  };

  static override styles = [base];

  declare t: Texts;
  declare room: Room;
  declare workpieces: ReadonlyMap<string, Workpiece>;
  declare groups: readonly Group[];
  /** Whether the own person holds manage at the room. */
  declare manages: boolean;
  /** Whether the own person holds edit at the room, which creating a workpiece there takes. */
  declare edits: boolean;
  /** The grants at the room, read only with manage there. */
  declare grants: readonly Grant[] | undefined;
  /** Whether the tool gave newWorkpiece, so workpieces can be created here. */
  declare creates: boolean;
  declare busy: boolean;
  declare form: Form | undefined;

  protected override render(): TemplateResult {
    const { t, room, form } = this;

    return html`
      <ck-head
        .t=${t}
        .name=${room.name}
        .manages=${this.manages}
        .nameLabel=${t.roomName}
        .question=${t.removeRoom}
        .form=${form}
        .busy=${this.busy}
      ></ck-head>
      <h3>${t.workpieces}</h3>
      <p class="lead">${t.leadWorkpieces}</p>
      ${
        room.workpieces.length === 0
          ? html`<p class="empty">${t.noWorkpieces}</p>`
          : room.workpieces.map((id) => this.workpieceRow(id))
      }
      ${
        this.edits && this.creates
          ? html`<button
              class="link"
              @click=${() => emit(this, 'ck-form-open', { kind: 'workpiece' })}
            >
              ${plus} ${t.newWorkpiece}
            </button>`
          : nothing
      }
      ${
        form?.kind === 'workpiece'
          ? html`<ck-form
              .t=${t}
              .kind=${'workpiece'}
              .placeholder=${t.workpieceName}
              .label=${t.create}
              .busy=${this.busy}
              .error=${form.error}
            ></ck-form>`
          : nothing
      }
      ${this.grants === undefined ? nothing : this.access(this.grants)}
    `;
  }

  /** One workpiece; the tool decides what opening means, CK only says which. */
  private workpieceRow(id: string): TemplateResult {
    const { t } = this;
    const workpiece = this.workpieces.get(id);

    return html`<div class="row">
      <span>${workpiece?.name ?? id}</span>
      <span class="actions">
        ${
          workpiece === undefined
            ? nothing
            : html`<button
                class="link"
                @click=${() => emit(this, 'ck-workpiece-open', { workpiece })}
              >
                ${t.open} ${forward}
              </button>`
        }
        ${
          this.manages
            ? html`<button
                class="link danger icon"
                aria-label=${t.takeOut}
                title=${t.takeOut}
                ?disabled=${this.busy}
                @click=${() =>
                  emit(this, 'ck-workpiece-take-out', { roomId: this.room._id, workpieceId: id })}
              >
                ${cross}
              </button>`
            : nothing
        }
      </span>
    </div>`;
  }

  /** The grants at the room, and a group without one to give access to. */
  private access(grants: readonly Grant[]): TemplateResult {
    const { t } = this;
    const nameOf = (groupId: string) =>
      this.groups.find((group) => group._id === groupId)?.name ?? groupId;
    const without = this.groups.filter(
      (group) => !grants.some((grant) => grant.groupId === group._id),
    );

    // The select is read on submit, so nothing has to follow each choice.
    const give = (event: SubmitEvent) => {
      event.preventDefault();
      const select = (event.currentTarget as HTMLFormElement).querySelector('select');
      if (select !== null) {
        emit(this, 'ck-grant-give', { groupId: select.value });
      }
    };

    return html`
      <div class="section">
        <h3>${t.access}</h3>
        <ck-legend .t=${t}></ck-legend>
        <p class="lead">${t.leadAccess}</p>
      </div>
      ${
        grants.length === 0
          ? html`<p class="empty">${t.noAccess}</p>`
          : grants.map(
              (grant) =>
                html`<ck-access-card
                  .t=${t}
                  .heading=${nameOf(grant.groupId)}
                  .subject=${nameOf(grant.groupId)}
                  .where=${t.whereHere}
                  .grant=${grant}
                  .busy=${this.busy}
                ></ck-access-card>`,
            )
      }
      ${
        without.length === 0
          ? nothing
          : html`<p class="hint">${t.giveAccessHint}</p>
              <form class="form" @submit=${give}>
                <select aria-label=${t.giveAccess}>
                  ${without.map((group) => html`<option value=${group._id}>${group.name}</option>`)}
                </select>
                <button class="button" type="submit" ?disabled=${this.busy}>${t.giveAccess}</button>
              </form>`
      }
    `;
  }
}
