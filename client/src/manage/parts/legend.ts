/** <ck-legend>: what each right means, folded away until someone asks. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import { RIGHTS } from '../store.ts';
import { wording } from './wording.ts';

/** A link that unfolds the six rights with one sentence each. */
export class CkLegend extends LitElement {
  static override properties = {
    t: { attribute: false },
    open: { state: true },
  };

  static override styles = [
    base,
    css`
      :host {
        display: contents;
      }
      .legend {
        flex-basis: 100%;
        order: 2;
        margin: 4px 0 10px;
        padding: 8px 12px;
        font-size: 13px;
        background: var(--surface-alt);
        border-radius: calc(var(--radius) - 2px);
      }
      .legend p + p {
        margin-top: 2px;
      }
    `,
  ];

  declare t: Texts;
  /** Whether the explanation is shown. */
  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  protected override render(): TemplateResult {
    const words = wording(this.t);

    return html`<button
        class="link"
        aria-expanded=${this.open}
        @click=${() => (this.open = !this.open)}
      >
        ${this.t.legendToggle} ${this.open ? '▴' : '▾'}
      </button>
      ${
        this.open
          ? html`<div class="legend">
              ${RIGHTS.map(
                (right) => html`<p><b>${words[right].name}</b> ${words[right].hint}</p>`,
              )}
            </div>`
          : nothing
      }`;
  }
}
