/** <ck-head>: the name of a room or a group, with rename and delete for whoever holds manage there. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { Form } from '../store.ts';
import { emit } from './events.ts';
import './form.ts';

/** The head asks to open a form or to delete; the question of the deletion is the tool's to word. */
export class CkHead extends LitElement {
  static override properties = {
    t: { attribute: false },
    name: { attribute: false },
    manages: { attribute: false },
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
  /** The label of the rename field, and the question asked before deleting. */
  declare nameLabel: string;
  declare question: string;
  declare form: Form | undefined;
  declare busy: boolean;

  protected override render(): TemplateResult {
    const { t, form } = this;

    return html`
      <div class="head">
        <h2>${this.name}</h2>
        ${
          this.manages
            ? html`<span class="actions">
                <button class="link" @click=${() => emit(this, 'ck-form-open', { kind: 'rename' })}>
                  ${t.rename}
                </button>
                <button
                  class="link danger"
                  @click=${() => emit(this, 'ck-form-open', { kind: 'remove' })}
                >
                  ${t.remove}
                </button>
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
        form?.kind === 'remove'
          ? html`<div class="confirm" role="alert">
                <p>${this.question}</p>
                <button
                  class="button primary"
                  ?disabled=${this.busy}
                  @click=${() => emit(this, 'ck-remove')}
                >
                  ${t.confirmRemove}
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
