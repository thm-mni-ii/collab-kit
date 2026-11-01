/** <ck-form>: one text field with its button, and what went wrong with it. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import type { FormKind } from '../store.ts';
import { emit } from './events.ts';

/** The field takes the focus when it appears; what it means is up to whoever placed it. */
export class CkForm extends LitElement {
  static override properties = {
    t: { attribute: false },
    kind: { attribute: false },
    placeholder: { attribute: false },
    label: { attribute: false },
    value: { attribute: false },
    busy: { attribute: false },
    error: { attribute: false },
  };

  // A form in a narrow list puts its field on a line of its own.
  static override styles = [
    base,
    css`
      :host([block]) input {
        flex-basis: 100%;
      }
    `,
  ];

  declare t: Texts;
  declare kind: FormKind;
  declare placeholder: string;
  declare label: string;
  declare value: string | undefined;
  declare busy: boolean;
  declare error: string | undefined;

  protected override firstUpdated(): void {
    this.renderRoot.querySelector('input')?.focus();
  }

  protected override render(): TemplateResult {
    const { t } = this;

    // The field is read on submit, so nothing has to follow each key.
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      const input = (event.currentTarget as HTMLFormElement).querySelector('input');
      emit(this, 'ck-form-submit', { kind: this.kind, text: input?.value ?? '' });
    };

    return html`<form class="form" @submit=${submit}>
        <input
          name="text"
          aria-label=${this.placeholder}
          placeholder=${this.placeholder}
          .value=${this.value ?? ''}
          @input=${() => emit(this, 'ck-form-input')}
        />
        <button class="button primary" type="submit" ?disabled=${this.busy}>${this.label}</button>
        <button class="button" type="button" @click=${() => emit(this, 'ck-form-close')}>
          ${t.cancel}
        </button>
      </form>
      ${
        this.error === undefined ? nothing : html`<p class="error" role="alert">${this.error}</p>`
      }`;
  }
}
