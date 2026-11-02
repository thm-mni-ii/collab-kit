/** The few icons of <ck-management>, drawn in the color of the text around them. */

import { html, svg, type SVGTemplateResult, type TemplateResult } from 'lit';

/** One stroke icon of 16 by 16; hidden from screen readers, its button says what it does. */
function icon(path: SVGTemplateResult): TemplateResult {
  return html`<svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${path}
  </svg>`;
}

export const plus = icon(svg`<path d="M8 3v10M3 8h10" />`);
export const cross = icon(svg`<path d="M4 4l8 8M12 4l-8 8" />`);
export const info = icon(svg`<circle cx="8" cy="8" r="6" /><path d="M8 7.5V11M8 5.2v.1" />`);
export const person = icon(
  svg`<circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4" />`,
);
export const pseudonym = icon(
  svg`<circle cx="8" cy="5.5" r="2.5" stroke-dasharray="2 2" /><path d="M3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4" stroke-dasharray="2 2" />`,
);
export const forward = icon(svg`<path d="M3 8h10M9 4l4 4-4 4" />`);
