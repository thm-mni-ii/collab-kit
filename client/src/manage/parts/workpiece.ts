/** <ck-workpiece-detail>: one workpiece seen from above, the rooms it lies in, who reaches it there, its last traces. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';

import type { Group, Room, Workpiece } from '../../api.ts';
import { cross } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import { RIGHTS, type Use } from '../store.ts';
import { emit } from './events.ts';
import { wording } from './wording.ts';

/** How many rooms a workpiece lies in, as the list shows it. */
export function roomCount(t: Texts, count: number): string {
  return count === 0
    ? t.inNoRoom
    : count === 1
      ? t.inOneRoom
      : t.inRooms.replace('{n}', `${count}`);
}

/** The workpiece with its rooms, the groups reaching it through them and its last traces. */
export class CkWorkpieceDetail extends LitElement {
  static override properties = {
    t: { attribute: false },
    workpiece: { attribute: false },
    source: { attribute: false },
    rooms: { attribute: false },
    groups: { attribute: false },
    use: { attribute: false },
    names: { attribute: false },
    busy: { attribute: false },
  };

  static override styles = [base];

  declare t: Texts;
  declare workpiece: Workpiece;
  /** Its source, if it is a fork of a workpiece the person sees. */
  declare source: Workpiece | undefined;
  declare rooms: readonly Room[];
  declare groups: readonly Group[];
  /** Loaded for this workpiece, or still under way. */
  declare use: Use | undefined;
  declare names: Readonly<Record<string, string>>;
  declare busy: boolean;

  protected override render(): TemplateResult {
    const { t, workpiece, source } = this;
    const use = this.use?.workpieceId === workpiece._id ? this.use : undefined;

    return html`
      <div class="head"><h2>${workpiece.name}</h2></div>
      ${
        source === undefined
          ? nothing
          : html`<p class="hint">${t.forkOf.replace('{name}', source.name)}</p>`
      }
      ${this.roomsView()}
      ${use === undefined ? nothing : html`${this.reach(use)} ${this.activity(use)}`}
    `;
  }

  /** The rooms it lies in, each to take it out of, and one more to put it in. */
  private roomsView(): TemplateResult {
    const { t, workpiece } = this;
    const lies = this.rooms.filter((room) => room.workpieces.includes(workpiece._id));
    const others = this.rooms.filter((room) => !room.workpieces.includes(workpiece._id));

    // The select is read on submit, so nothing has to follow each choice.
    const putIn = (event: SubmitEvent) => {
      event.preventDefault();
      const select = (event.currentTarget as HTMLFormElement).querySelector('select');
      if (select !== null) {
        emit(this, 'ck-workpiece-put-in', { roomId: select.value, workpieceId: workpiece._id });
      }
    };

    return html`
      <h3>${t.liesIn}</h3>
      <p class="lead">${t.leadLies}</p>
      ${
        lies.length === 0
          ? html`<p class="empty">${t.liesNowhere}</p>`
          : lies.map(
              (room) =>
                html`<div class="row">
                  <span>${room.name}</span>
                  <button
                    class="link danger icon"
                    aria-label=${t.takeOut}
                    title=${t.takeOut}
                    ?disabled=${this.busy}
                    @click=${() =>
                      emit(this, 'ck-workpiece-take-out', {
                        roomId: room._id,
                        workpieceId: workpiece._id,
                      })}
                  >
                    ${cross}
                  </button>
                </div>`,
            )
      }
      ${
        others.length === 0
          ? nothing
          : html`<form class="form" @submit=${putIn}>
              <select aria-label=${t.putIn}>
                ${others.map((room) => html`<option value=${room._id}>${room.name}</option>`)}
              </select>
              <button class="button" type="submit" ?disabled=${this.busy}>${t.putIn}</button>
            </form>`
      }
    `;
  }

  /** Each grant at one of its rooms, its rights only to read; they are switched at the room. */
  private reach(use: Use): TemplateResult {
    const { t } = this;
    const words = wording(t);
    const nameOf = (groupId: string) =>
      this.groups.find((group) => group._id === groupId)?.name ?? groupId;
    const roomOf = (roomId: string | undefined) =>
      this.rooms.find((room) => room._id === roomId)?.name ?? roomId;

    return html`
      <h3>${t.reach}</h3>
      <p class="lead">${t.leadReach}</p>
      ${
        use.grants.length === 0
          ? html`<p class="empty">${t.reachNone}</p>`
          : use.grants.map(
              (grant) =>
                html`<div class="row">
                  <span
                    >${nameOf(grant.groupId)}<span class="key"
                      >${roomOf(grant.scope?.id)}</span
                    ></span
                  >
                  <span class="chips">
                    ${RIGHTS.filter((right) => grant.rights.includes(right)).map(
                      (right) =>
                        html`<span class="chip held" title=${words[right].hint}
                          >${words[right].name}</span
                        >`,
                    )}
                    ${
                      grant.anonymous === true
                        ? html`<span class="chip held" title=${t.hintHideName}>${t.hideName}</span>`
                        : nothing
                    }
                  </span>
                </div>`,
            )
      }
    `;
  }

  /** The newest trace of each person, newest first. */
  private activity(use: Use): TemplateResult {
    const { t } = this;
    const when = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });

    return html`
      <h3>${t.lastActivity}</h3>
      ${
        use.activity.length === 0
          ? html`<p class="empty">${t.noActivity}</p>`
          : use.activity.map(
              (trace) =>
                html`<div class="row">
                  <span>${this.names[trace.actorId] ?? trace.actorId}</span>
                  <span class="key">${when.format(new Date(trace.at))}</span>
                </div>`,
            )
      }
    `;
  }
}
