/** <ck-access-card>: one grant, its rights as switches, how the members appear, and what it all means. */

import { LitElement, css, html, type TemplateResult } from 'lit';

import type { Grant, Right } from '../../api.ts';
import { person, pseudonym } from '../look/icons.ts';
import type { Texts } from '../look/texts.ts';
import { base } from '../look/theme.ts';
import { RIGHTS } from '../store.ts';
import { emit } from './events.ts';
import { wording } from './wording.ts';

/** Puts what is given where the template has {name}, the rest of the text stays as it is. */
function fill(template: string, given: Readonly<Record<string, unknown>>): unknown[] {
  return template
    .split(/(\{\w+\})/)
    .map((piece) => given[/^\{(\w+)\}$/.exec(piece)?.[1] ?? ''] ?? piece);
}

/** Shows what the grant means and asks to switch it; nothing is kept here. */
export class CkAccessCard extends LitElement {
  static override properties = {
    t: { attribute: false },
    heading: { attribute: false },
    subject: { attribute: false },
    where: { attribute: false },
    grant: { attribute: false },
    busy: { attribute: false },
  };

  static override styles = [
    base,
    css`
      :host {
        padding: 10px 12px;
        margin-bottom: 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
      }
      .top {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .name {
        flex: 1;
        font-weight: 500;
      }
      .tag {
        padding: 0 8px;
        font-size: 12px;
        color: var(--text-muted);
        background: var(--surface-alt);
        border-radius: 10px;
      }
      .chips {
        margin: 8px 0;
      }
      .chip[aria-pressed='true'] {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--on-accent);
      }
      .shown {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
        font-size: 13px;
      }
      .shown .ask {
        flex: 1;
        min-width: 140px;
        color: var(--text-muted);
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 2px);
        overflow: hidden;
      }
      .seg button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 12px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .seg button[aria-pressed='true'] {
        background: var(--accent);
        color: var(--on-accent);
      }
      .summary {
        margin-top: 8px;
        padding: 8px 10px;
        font-size: 13px;
        line-height: 1.9;
        color: var(--text-muted);
        background: var(--surface-alt);
        border-radius: calc(var(--radius) - 2px);
      }
      .who,
      .how {
        font-weight: 500;
        color: var(--text);
      }
      .what {
        display: inline-block;
        padding: 0 7px;
        font-size: 12px;
        line-height: 1.4;
        color: var(--text);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 5px;
      }
    `,
  ];

  declare t: Texts;
  /** What the grant is about: the group in a room, the place in a group. */
  declare heading: string;
  /** Who the sentence is about, and where it holds. */
  declare subject: string;
  declare where: string;
  declare grant: Grant;
  declare busy: boolean;

  protected override render(): TemplateResult {
    const { t, grant } = this;
    const words = wording(t);
    const rights = RIGHTS.filter((right) => grant.rights.includes(right));
    const hidden = grant.anonymous === true;

    // The verbs as a list in the language of the element, each one marked.
    const verbs = new Intl.ListFormat(t.locale, { style: 'long', type: 'conjunction' })
      .formatToParts(rights.map((right) => words[right].verb))
      .map((part) =>
        part.type === 'element' ? html`<span class="what">${part.value}</span>` : part.value,
      );
    const meaning = fill(t.summary, {
      who: html`<span class="who">${this.subject}</span>`,
      where: this.where,
      list: verbs,
    });
    const members = fill(t.summaryMembers, {
      how: html`<span class="how">${hidden ? t.howHidden : t.howShown}</span>`,
    });

    return html`<div class="top">
        <span class="name">${this.heading}</span>
        <span class="tag">${t.rightsCount.replace('{n}', `${rights.length}`)}</span>
      </div>
      <div class="chips">${RIGHTS.map((right) => this.chip(right, words))}</div>
      <div class="shown">
        <span class="ask">${t.askShown}</span>
        <span class="seg">
          ${this.mode(false, person, t.withName)} ${this.mode(true, pseudonym, t.pseudonym)}
        </span>
      </div>
      <p class="summary">${meaning} ${members}</p>`;
  }

  /** One right as a switch; what it means is in its tooltip and in the legend. */
  private chip(right: Right, words: ReturnType<typeof wording>): TemplateResult {
    return html`<button
      class="chip"
      aria-pressed=${this.grant.rights.includes(right)}
      title=${words[right].hint}
      ?disabled=${this.busy}
      @click=${() => emit(this, 'ck-grant-toggle', { grant: this.grant, chip: right })}
    >
      ${words[right].name}
    </button>`;
  }

  /** One of the two ways the members appear; the one already chosen asks for nothing. */
  private mode(hide: boolean, icon: TemplateResult, label: string): TemplateResult {
    const chosen = (this.grant.anonymous === true) === hide;

    return html`<button
      aria-pressed=${chosen}
      ?disabled=${this.busy}
      @click=${() =>
        chosen
          ? undefined
          : emit(this, 'ck-grant-toggle', { grant: this.grant, chip: 'anonymous' })}
    >
      ${icon} ${label}
    </button>`;
  }
}
