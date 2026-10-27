/** One workpiece seen from above: the rooms it lies in, who reaches it there, its last traces. */

import { html, nothing, type TemplateResult } from 'lit';

import type { Group, Room, Workpiece } from '../../api.ts';
import { RIGHTS, type Use } from '../store.ts';
import { cross } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';

/** What the workpiece view shows, and what it may ask the element for. */
export interface WorkpieceView {
  readonly t: Texts;
  readonly workpiece: Workpiece;
  /** Its source, if it is a fork of a workpiece the person sees. */
  readonly source: Workpiece | undefined;
  readonly rooms: readonly Room[];
  readonly groups: readonly Group[];
  /** Loaded for this workpiece, or still under way. */
  readonly use: Use | undefined;
  readonly names: Readonly<Record<string, string>>;
  readonly busy: boolean;
  putIn(roomId: string): void;
  takeOut(room: Room): void;
}

/** How many rooms a workpiece lies in, as the list shows it. */
export function roomCount(t: Texts, count: number): string {
  return count === 0
    ? t.inNoRoom
    : count === 1
      ? t.inOneRoom
      : t.inRooms.replace('{n}', `${count}`);
}

/** The workpiece with its rooms, the groups reaching it through them and its last traces. */
export function workpieceView(view: WorkpieceView): TemplateResult {
  const { t, workpiece, source } = view;
  const use = view.use?.workpieceId === workpiece._id ? view.use : undefined;

  return html`
    <div class="head"><h2>${workpiece.name}</h2></div>
    ${
      source === undefined
        ? nothing
        : html`<p class="hint">${t.forkOf.replace('{name}', source.name)}</p>`
    }
    ${roomsView(view)}
    ${use === undefined ? nothing : html`${reachView(view, use)} ${activityView(view, use)}`}
  `;
}

/** The rooms it lies in, each to take it out of, and one more to put it in. */
function roomsView(view: WorkpieceView): TemplateResult {
  const { t, workpiece } = view;
  const lies = view.rooms.filter((room) => room.workpieces.includes(workpiece._id));
  const others = view.rooms.filter((room) => !room.workpieces.includes(workpiece._id));

  // The select is read on submit, so nothing has to follow each choice.
  const putIn = (event: SubmitEvent) => {
    event.preventDefault();
    const select = (event.currentTarget as HTMLFormElement).querySelector('select');
    if (select !== null) {
      view.putIn(select.value);
    }
  };

  return html`
    <h3>${t.liesIn}</h3>
    ${
      lies.length === 0
        ? html`<p class="empty">${t.liesNowhere}</p>`
        : lies.map(
            (room) =>
              html`<div class="row">
                <span>${room.name}</span>
                <button
                  class="link danger"
                  aria-label=${t.takeOut}
                  title=${t.takeOut}
                  ?disabled=${view.busy}
                  @click=${() => view.takeOut(room)}
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
            <button class="button" type="submit" ?disabled=${view.busy}>${t.putIn}</button>
          </form>`
    }
  `;
}

/** Each grant at one of its rooms, its rights only to read; they are switched at the room. */
function reachView(view: WorkpieceView, use: Use): TemplateResult {
  const { t } = view;
  const nameOf = (groupId: string) =>
    view.groups.find((group) => group._id === groupId)?.name ?? groupId;
  const roomOf = (roomId: string | undefined) =>
    view.rooms.find((room) => room._id === roomId)?.name ?? roomId;

  return html`
    <h3>${t.reach}</h3>
    ${
      use.grants.length === 0
        ? html`<p class="empty">${t.reachNone}</p>`
        : use.grants.map(
            (grant) =>
              html`<div class="row">
                <span
                  >${nameOf(grant.groupId)}<span class="key">${roomOf(grant.scope?.id)}</span></span
                >
                <span class="chips">
                  ${RIGHTS.filter((right) => grant.rights.includes(right)).map(
                    (right) => html`<span class="chip held">${right}</span>`,
                  )}
                  ${grant.anonymous === true ? html`<span class="chip held">anonymous</span>` : nothing}
                </span>
              </div>`,
          )
    }
    <p class="hint">${t.alsoEverywhere}</p>
  `;
}

/** The newest trace of each person, newest first. */
function activityView(view: WorkpieceView, use: Use): TemplateResult {
  const { t } = view;
  const when = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });

  return html`
    <h3>${t.lastActivity}</h3>
    ${
      use.activity.length === 0
        ? html`<p class="empty">${t.noActivity}</p>`
        : use.activity.map(
            (trace) =>
              html`<div class="row">
                <span>${view.names[trace.actorId] ?? trace.actorId}</span>
                <span class="key">${when.format(new Date(trace.at))}</span>
              </div>`,
          )
    }
  `;
}
