/**
 * useContactInferenceState — BACKLOG-3349
 *
 * The strict plan state for "may this mailbox's email be used to infer
 * contacts", per provider, for the Settings rows that have to explain
 * themselves.
 *
 * Why a provider-keyed object rather than a bare state: BACKLOG-1717 adds
 * Gmail. Returning `{ outlook }` today means that row's props do not change
 * shape when `gmail` joins it, and every fixture that already states the prop
 * keeps compiling.
 */

import { useMemo } from "react";
import { useStrictFeatureState } from "./useStrictFeatureState";
import type {
  StrictFeatureKey,
  StrictFeatureStateOrPending,
} from "../../electron/types/featureGate";

/**
 * The renderer's provider → plan-key map.
 *
 * It is a SECOND copy of the map in `electron/handlers/featureGateHandlers.ts`,
 * and it has to be: `src/` cannot value-import from `electron/` — Vite parses
 * that as JavaScript — so only the TYPE crosses. `satisfies` therefore proves
 * each value is *a* strict key, never that it is *the same* key main gates on.
 *
 * Drift here shows up as a row that says "not in your plan" while the feature
 * works, or the reverse. BACKLOG-1717 adds a parity control over the two maps
 * when it adds the second provider (its SR delta, required change D4).
 */
export const CONTACT_INFERENCE_FEATURE_KEYS = {
  outlook: "email_contact_inference",
} as const satisfies Record<string, StrictFeatureKey>;

export type ContactInferenceProvider = keyof typeof CONTACT_INFERENCE_FEATURE_KEYS;

export type ContactInferenceStates = Record<
  ContactInferenceProvider,
  StrictFeatureStateOrPending
>;

export function useContactInferenceState(): ContactInferenceStates {
  const outlook = useStrictFeatureState(CONTACT_INFERENCE_FEATURE_KEYS.outlook);

  return useMemo(() => ({ outlook }), [outlook]);
}

export default useContactInferenceState;
