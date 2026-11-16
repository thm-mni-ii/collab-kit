/** <ck-archive-detail>: one entry of the archive, what it was and where, to bring back or delete for good. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { ArchiveEntry, ArchiveKind, Room } from '../../api.ts';
import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { Form } from '../store.ts';
import { emit } from './events.ts';

/** The kind of an entry in the words of the panel. */
export function kindName(t: Texts, kind: ArchiveKind): string {
  return kind === 'workpiece' ? t.glossWorkpiece : kind === 'room' ? t.glossRoom : t.glossGroup;
}

/** The entry with its reason, forks and rooms, and the two ways out of the archive. */
export class CkArchiveDetail extends LitElement {
  static override properties = {
    t: { attribute: false },
    entry: { attribute: false },
    rooms: { attribute: false },
    form: { attribute: false },
    busy: { attribute: false },
  };

  static override styles = [
    base,
    css`
      .confirm,
      .ways {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-top: 12px;
      }
      .confirm p {
        flex-basis: 100%;
      }
    `,
  ];

  declare t: Texts;
  declare entry: ArchiveEntry;
  /** The live rooms, to name those a workpiece lay in. */
  declare rooms: readonly Room[];
  declare form: Form | undefined;
  declare busy: boolean;

  protected override render(): TemplateResult {
    const { t, entry, form } = this;
    const when = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });
    const forks = entry.forks?.length ?? 0;
    // Only rooms still live have a name here, each once.
    const lay = [...new Set(entry.rooms?.map((placement) => placement.room))].flatMap(
      (id) => this.rooms.find((room) => room._id === id)?.name ?? [],
    );

    return html`
      <div class="head"><h2>${entry.name}</h2></div>
      <p class="hint">
        ${kindName(t, entry.kind)} ·
        ${t.archivedAt.replace('{date}', when.format(new Date(entry.archivedAt)))}
      </p>
      ${entry.reason === undefined ? nothing : html`<p>${t.archivedWhy.replace('{reason}', entry.reason)}</p>`}
      ${
        forks === 0
          ? nothing
          : html`<p>${forks === 1 ? t.forksOne : t.forksMany.replace('{n}', `${forks}`)}</p>`
      }
      ${lay.length === 0 ? nothing : html`<p>${t.archivedIn.replace('{rooms}', lay.join(', '))}</p>`}
      <div class="ways">
        <button
          class="button primary"
          ?disabled=${this.busy}
          @click=${() => emit(this, 'ck-restore')}
        >
          ${t.restore}
        </button>
        <button class="link danger" @click=${() => emit(this, 'ck-form-open', { kind: 'delete' })}>
          ${t.deleteForGood}
        </button>
      </div>
      ${
        form?.kind === 'delete'
          ? html`<div class="confirm" role="alert">
                <p>${t.deleteQuestion}</p>
                <button
                  class="button primary"
                  ?disabled=${this.busy}
                  @click=${() => emit(this, 'ck-delete')}
                >
                  ${t.confirmDelete}
                </button>
                <button class="button" @click=${() => emit(this, 'ck-form-close')}>
                  ${t.cancel}
                </button>
              </div>
              ${
                form.error === undefined
                  ? nothing
                  : html`<p class="error" role="alert">${form.error}</p>`
              }`
          : nothing
      }
    `;
  }
}
