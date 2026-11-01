/** What the parts tell <ck-management>; each event travels up through the shadow roots to it. */

import type { ActorName, Grant, Workpiece } from '../../api.ts';
import type { FormKind, Switch } from '../store.ts';

/** The events of the parts with what each carries; undefined carries nothing. */
export interface PartEvents {
  'ck-form-open': { readonly kind: FormKind };
  'ck-form-close': undefined;
  'ck-form-input': undefined;
  'ck-form-submit': { readonly kind: FormKind; readonly text: string };
  'ck-remove': undefined;
  'ck-grant-toggle': { readonly grant: Grant; readonly chip: Switch };
  'ck-grant-give': { readonly groupId: string };
  'ck-workpiece-open': { readonly workpiece: Workpiece };
  'ck-workpiece-take-out': { readonly roomId: string; readonly workpieceId: string };
  'ck-workpiece-put-in': { readonly roomId: string; readonly workpieceId: string };
  'ck-member-pick': { readonly person: ActorName };
  'ck-member-dismiss': { readonly actorId: string };
}

type PartEventMap = { readonly [Name in keyof PartEvents]: CustomEvent<PartEvents[Name]> };

declare global {
  interface HTMLElementEventMap extends PartEventMap {}
}

/** Tells <ck-management> from any depth; it stops the event, so the tool never sees it. */
export function emit<Name extends keyof PartEvents>(
  host: HTMLElement,
  name: Name,
  ...detail: PartEvents[Name] extends undefined ? [] : [PartEvents[Name]]
): void {
  host.dispatchEvent(new CustomEvent(name, { detail: detail[0], bubbles: true, composed: true }));
}
