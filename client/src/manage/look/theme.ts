/** How the elements look: the colors as --ck-* variables the tool may set, a base every part shares, the frame. */

import { css } from 'lit';

// Each value holds only while the tool sets no --ck-* of its own.
const light = css`
  --surface: var(--ck-surface, #ffffff);
  --surface-alt: var(--ck-surface-alt, #f1efe8);
  --text: var(--ck-text, #2c2c2a);
  --text-muted: var(--ck-text-muted, #5f5e5a);
  --border: var(--ck-border, #d3d1c7);
  --accent: var(--ck-accent, #534ab7);
  --on-accent: var(--ck-on-accent, #ffffff);
  --danger: var(--ck-danger, #a32d2d);
  color-scheme: light;
`;

const dark = css`
  --surface: var(--ck-surface, #1f1e1d);
  --surface-alt: var(--ck-surface-alt, #2c2c2a);
  --text: var(--ck-text, #f1efe8);
  --text-muted: var(--ck-text-muted, #b4b2a9);
  --border: var(--ck-border, #444441);
  --accent: var(--ck-accent, #afa9ec);
  --on-accent: var(--ck-on-accent, #26215c);
  --danger: var(--ck-danger, #f09595);
  color-scheme: dark;
`;

/** The variables of <ck-management>; its parts inherit them through the shadow roots. */
export const tokens = css`
  :host {
    ${light}
    --radius: var(--ck-radius, 8px);
    display: block;
    container-type: inline-size;
    color: var(--text);
  }
  :host([theme='dark']) {
    ${dark}
  }
  @media (prefers-color-scheme: dark) {
    :host(:not([theme='light'])) {
      ${dark}
    }
  }
`;

/** What every part shares: reset, text, buttons, fields, rows and chips. */
export const base = css`
  :host {
    display: block;
  }
  * {
    box-sizing: border-box;
  }
  h2 {
    font-size: 16px;
    font-weight: 500;
    margin: 0;
  }
  h3 {
    font-size: 14px;
    font-weight: 500;
    margin: 20px 0 2px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  p {
    margin: 0;
  }
  .lead {
    padding: 0 0 8px;
    font-size: 13px;
    color: var(--text-muted);
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  input,
  select {
    font: inherit;
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    padding: 4px 8px;
    min-width: 0;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .head,
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .actions,
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
  }
  .chips {
    gap: 4px;
  }
  .chip {
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    color: var(--text-muted);
  }
  .chip.held {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
  }
  .row + .link,
  .empty + .link {
    margin-top: 8px;
  }
  .link.icon {
    padding: 3px 7px;
  }
  .danger {
    color: var(--danger);
  }
  .link.danger {
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 8px;
    margin: 20px 0 2px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .section h3 {
    flex: 1;
    margin: 0;
    padding: 0;
    border: none;
  }
  .section .lead {
    flex-basis: 100%;
    order: 1;
    padding-top: 2px;
  }
  .button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
  }
  .button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .form input,
  .form select {
    flex: 1;
  }
  .key {
    margin-left: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .empty,
  .hint {
    padding: 6px 0;
    font-size: 13px;
    color: var(--text-muted);
  }
  .empty {
    padding: 12px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
  }
  .hint {
    padding: 4px 0 0;
    font-size: 12px;
  }
  .error {
    margin-top: 6px;
    font-size: 13px;
    color: var(--danger);
  }
`;

/** The frame of <ck-management>: its own surface, a fixed height, title and tabs on top, two boxes that scroll on their own. */
export const frame = css`
  .frame {
    display: flex;
    flex-direction: column;
    height: var(--ck-height, 560px);
    padding: 16px;
    background: var(--surface);
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.5;
  }
  .title {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
  }
  h1 {
    flex: 1;
    margin: 0;
    font-size: 20px;
    font-weight: 500;
  }
  .info {
    display: inline-flex;
    padding: 4px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 50%;
  }
  .info[aria-expanded='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .info svg {
    width: 18px;
    height: 18px;
  }
  .subtitle {
    flex: none;
    margin: 2px 0 12px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .more {
    flex: none;
    margin-bottom: 12px;
    padding: 10px 14px;
    font-size: 13px;
    background: var(--surface-alt);
    border-radius: var(--radius);
  }
  .more p + p {
    margin-top: 4px;
  }
  .bar {
    display: flex;
    flex: none;
    gap: 4px;
    margin-bottom: 12px;
  }
  .banner {
    flex: none;
    margin: 0 0 8px;
    padding: 0;
  }
  .body {
    display: grid;
    flex: 1;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 12px;
    min-height: 0;
  }
  .list,
  .detail {
    min-height: 0;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 8px;
  }
  .list .link {
    align-self: flex-start;
    margin-top: 6px;
  }
  .detail {
    padding: 12px 16px;
  }
  @container (max-width: 520px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 40%) minmax(0, 1fr);
    }
  }
  .tab,
  .item {
    padding: 4px 12px;
    border-radius: calc(var(--radius) - 2px);
    color: var(--text-muted);
  }
  .tab {
    padding: 6px 14px;
  }
  .tab[aria-selected='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }
  .item {
    text-align: left;
    padding: 6px 10px;
  }
  .item[aria-current='true'] {
    background: var(--surface-alt);
    color: var(--text);
  }
  .item.fork {
    padding-left: 24px;
  }
  .sub {
    display: block;
    font-size: 12px;
    color: var(--text-muted);
  }
`;
