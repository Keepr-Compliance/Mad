/**
 * useStrictFeatureState — BACKLOG-3349
 *
 * Asks the main process for the strict (fail-closed) state of one feature key.
 *
 * The renderer NEVER derives this itself. Two reasons, both measured:
 *
 *   1. `useFeatureGate().isAllowed` reads `feature?.allowed ?? true`, and the
 *      no-org payload from `feature-gate:get-all` carries only the four
 *      team-only keys — so a strict key derived in the renderer would read
 *      ALLOWED for exactly the users who have no resolvable organization. A
 *      probe against the real hook with that exact payload failed 3 of 4.
 *   2. Main is the authority. Whatever the renderer concludes, the gate that
 *      decides whether anything is actually built runs in main, so the renderer
 *      can never grant what main denies. This hook exists to make the two agree
 *      on screen, not to decide anything.
 *
 * "pending" is the state before the first answer, and it is not "blocked": a
 * row that says "not in your plan" for the half-second before the plan is read
 * has told the user something that may well be false.
 */

import { useEffect, useState } from "react";
import type {
  StrictFeatureKey,
  StrictFeatureStateOrPending,
} from "../../electron/types/featureGate";

export type {
  StrictFeatureKey,
  StrictFeatureState,
  StrictFeatureStateOrPending,
} from "../../electron/types/featureGate";

export function useStrictFeatureState(
  featureKey: StrictFeatureKey
): StrictFeatureStateOrPending {
  const [state, setState] = useState<StrictFeatureStateOrPending>("pending");

  useEffect(() => {
    let cancelled = false;

    // The invoke is AWAITED INSIDE the try, not assigned outside it. A suite —
    // or a renderer that loaded before the bridge — can leave
    // `window.api.featureGate` without this method, and reaching through it
    // then throws synchronously. Catching only a rejected promise would let
    // that throw escape and take the whole render down, when the honest answer
    // is simply that the plan could not be read.
    const run = async (): Promise<void> => {
      try {
        const result = await window.api.featureGate.strictState(featureKey);
        if (!cancelled) {
          setState(result);
        }
      } catch {
        if (!cancelled) {
          setState("unknown");
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [featureKey]);

  return state;
}

export default useStrictFeatureState;
