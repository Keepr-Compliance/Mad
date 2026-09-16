/**
 * useHideFromExportState — BACKLOG-3365
 *
 * The strict plan state for "may this user hide a text from their export",
 * read from the main process over BACKLOG-3349's shared strict-state channel.
 *
 * Three states and not a boolean, because the conversation view has to say
 * something: "pending" is the half-second before the plan has been read and
 * must not read as "not in your plan", and "unknown" is a plan that could not
 * be read at all. Only "allowed" renders the Hide control
 * (`ConversationViewModal`), and **the renderer is not the authority** — the
 * write is refused in main whatever this says
 * (`electron/handlers/hiddenTextHandlers.ts`).
 *
 * Unhide is never gated and renders in every state, including after a plan
 * loses the feature.
 *
 * The key literal is written here rather than imported: `src/` may import a
 * TYPE from `electron/types/featureGate.ts` but never a value, because Vite
 * parses `electron/` as JavaScript. `useStrictFeatureState` takes a
 * `StrictFeatureKey`, so a mistyped literal here is a compile error — the same
 * guarantee `as const satisfies` would give, without a second name for the key.
 */

import { useStrictFeatureState } from "./useStrictFeatureState";
import type { StrictFeatureStateOrPending } from "./useStrictFeatureState";

/**
 * Kept as an alias rather than renamed at the four call sites that import it
 * (`MessageThreadCard`, `ConversationViewModal` and their two 3366 suites).
 * The union is character-for-character what the stand-in declared, so nothing
 * downstream changes shape.
 */
export type HideFromExportState = StrictFeatureStateOrPending;

export function useHideFromExportState(): HideFromExportState {
  return useStrictFeatureState("desktop_hide_from_export");
}

export default useHideFromExportState;
