/** The name, the verb and the explanation of every right in the words of the element. */

import type { Right } from '../../api.ts';
import type { Texts } from '../look/texts.ts';

export function wording(
  t: Texts,
): Record<Right, { readonly name: string; readonly verb: string; readonly hint: string }> {
  return {
    see: { name: t.rightSee, verb: t.verbSee, hint: t.hintSee },
    speak: { name: t.rightSpeak, verb: t.verbSpeak, hint: t.hintSpeak },
    edit: { name: t.rightEdit, verb: t.verbEdit, hint: t.hintEdit },
    plan: { name: t.rightPlan, verb: t.verbPlan, hint: t.hintPlan },
    decide: { name: t.rightDecide, verb: t.verbDecide, hint: t.hintDecide },
    manage: { name: t.rightManage, verb: t.verbManage, hint: t.hintManage },
  };
}
