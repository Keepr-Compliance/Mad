/**
 * BACKLOG-3966 U1 — the one sentence about template checklists and the plan.
 *
 * The Checklist tab and the Dashboard's Todo panel both say it, so both read
 * it from here and can never disagree (PR-3 review, carry-forward C: on an
 * "unknown" plan the tab said "We couldn't confirm your plan just now" while
 * the Dashboard said nothing).
 *
 *   allowed  -> null (nothing to say)
 *   blocked  -> the plan has no template checklists
 *   unknown  -> the plan could not be read
 *   pending  -> null (not known yet; nothing is shown until it is)
 */
import type { StrictFeatureStateOrPending } from "../hooks/useStrictFeatureState";

export const TEMPLATE_CHECKLISTS_NOT_ON_PLAN = "Template checklists aren’t on your plan.";
export const PLAN_NOT_CONFIRMED = "We couldn’t confirm your plan just now.";

export function templateChecklistHint(gate: StrictFeatureStateOrPending): string | null {
  switch (gate) {
    case "blocked":
      return TEMPLATE_CHECKLISTS_NOT_ON_PLAN;
    case "unknown":
      return PLAN_NOT_CONFIRMED;
    default:
      return null;
  }
}
