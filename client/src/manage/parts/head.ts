/** <ck-head>: the name of a room, group or workpiece, with rename and archive for whoever holds manage there. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { Form } from '../store.ts';
import { emit } from './events.ts';
import './form.ts';

/** The head asks to open a form or to archive; the question before archiving is the caller's. */
export class CkHead extends LitElement {
  static override properties = {
    t: { attribute: false },
    name: { attribute: false },
    manages: { attribute: false },
    renames: { attribute: false },
    archives: { attribute: false },
    nameLabel: { attribute: false },
    question: { attribute: false },
    form: { attribute: false },
    busy: { attribute: false },
  };

  static override styles = [
    base,
    css`
      .confirm {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
      }
      .confirm p {
        flex-basis: 100%;
      }
    `,
  ];

  declare t: Texts;
  declare name: string;
  declare manages: boolean;
  /** Whether it can be renamed; CK renames no workpiece. */
  declare renames: boolean;
  /** Whether it can be archived; the archive may be off. */
  declare archives: boolean;
  /** The label of the rename field, and the question asked before archiving. */
  declare nameLabel: string;
  declare question: string;
  declare form: Form | undefined;
  declare busy: boolean;

  constructor() {
    super();
    this.renames = true;
    this.archives = false;
  }

  protected override render(): TemplateResult {
    const { t, form } = this;

    return html`
      <div class="head">
        <h2>${this.name}</h2>
        ${
          this.manages
            ? html`<span class="actions">
                ${
                  this.renames
                    ? html`<button
                        class="link"
                        @click=${() => emit(this, 'ck-form-open', { kind: 'rename' })}
                      >
                        ${t.rename}
                      </button>`
                    : nothing
                }
                ${
                  this.archives
                    ? html`<button
                        class="link danger"
                        @click=${() => emit(this, 'ck-form-open', { kind: 'archive' })}
                      >
                        ${t.archive}
                      </button>`
                    : nothing
                }
              </span>`
            : nothing
        }
      </div>
      ${
        form?.kind === 'rename'
          ? html`<ck-form
              .t=${t}
              .kind=${'rename'}
              .placeholder=${this.nameLabel}
              .label=${t.save}
              .value=${this.name}
              .busy=${this.busy}
              .error=${form.error}
            ></ck-form>`
          : nothing
      }
      ${
        form?.kind === 'archive'
          ? html`<div class="confirm" role="alert">
                <p>${this.question}</p>
                <button
                  class="button primary"
                  ?disabled=${this.busy}
                  @click=${() => emit(this, 'ck-archive')}
                >
                  ${t.confirmArchive}
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
