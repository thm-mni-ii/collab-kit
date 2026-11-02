/** <ck-fold>: a long list shows its first entries and unfolds on request. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';

/** Takes the entries as they are drawn, so what looks like a row there looks like one here. */
export class CkFold extends LitElement {
  static override properties = {
    t: { attribute: false },
    items: { attribute: false },
    limit: { attribute: false },
    open: { state: true },
  };

  static override styles = [
    base,
    css`
      .more {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .more .hint {
        padding: 0;
      }
    `,
  ];

  declare t: Texts;
  declare items: readonly unknown[];
  /** How many entries show while it is folded. */
  declare limit: number;
  /** Whether all entries show. */
  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  protected override render(): TemplateResult {
    const { t, items, limit, open } = this;
    const long = items.length > limit;

    return html`${long && !open ? items.slice(0, limit) : items}
    ${
      long
        ? html`<div class="more">
            <button class="link" aria-expanded=${open} @click=${() => (this.open = !open)}>
              ${open ? `${t.foldLess} ▴` : `${t.foldAll.replace('{n}', `${items.length}`)} ▾`}
            </button>
            ${
              open
                ? nothing
                : html`<span class="hint">
                    ${t.foldHidden.replace('{n}', `${items.length - limit}`)}
                  </span>`
            }
          </div>`
        : nothing
    }`;
  }
}
