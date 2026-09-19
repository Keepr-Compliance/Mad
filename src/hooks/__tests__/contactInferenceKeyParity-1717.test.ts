/**
 * The two provider -> plan-key maps must name the SAME key (BACKLOG-1717).
 *
 * ===========================================================================
 * WHY THERE ARE TWO MAPS AT ALL
 * ===========================================================================
 * `src/` cannot value-import from `electron/` — Vite parses that as JavaScript
 * — so only the TYPE crosses the boundary. The main-process map decides what
 * the gate actually reads; the renderer map decides which row Settings greys.
 * They are separate values by necessity.
 *
 * ===========================================================================
 * WHY `satisfies` IS NOT ENOUGH, AND THIS TEST IS
 * ===========================================================================
 * Both maps are declared `satisfies Record<string, StrictFeatureKey>`, so the
 * compiler proves each value is *a* valid strict key. It cannot prove the two
 * sides name *the same* key, because nothing relates them.
 *
 * Drift is therefore a compile-clean, test-clean defect with a user-visible
 * symptom in one of two directions: a Settings row that says "not in your
 * plan" while the feature works, or a row that looks live and available while
 * main refuses every read. Both are the app lying about what the customer
 * bought.
 *
 * A TEST can import both, because jest compiles `electron/` and `src/`
 * together — which is precisely the thing the Vite boundary forbids at
 * runtime, and precisely why this check has to live here rather than in a type.
 *
 * Mutation: change either side's `gmail` entry to a different strict key ->
 * this reddens.
 */

import { CONTACT_INFERENCE_FEATURE_KEYS as MAIN_KEYS } from "../../../electron/handlers/featureGateHandlers";
import { CONTACT_INFERENCE_FEATURE_KEYS as RENDERER_KEYS } from "../useContactInferenceState";

describe("BACKLOG-1717 — the main and renderer plan-key maps agree", () => {
  it("covers the same providers on both sides", () => {
    const main = Object.keys(MAIN_KEYS).sort();
    const renderer = Object.keys(RENDERER_KEYS).sort();

    // Named explicitly as well as compared, so that a map which loses BOTH
    // entries cannot pass this by being equally empty.
    expect(main).toEqual(["gmail", "outlook"]);
    expect(renderer).toEqual(main);
  });

  it("names the identical plan key for every provider", () => {
    for (const provider of Object.keys(MAIN_KEYS) as Array<keyof typeof MAIN_KEYS>) {
      expect(RENDERER_KEYS[provider as keyof typeof RENDERER_KEYS]).toBe(
        MAIN_KEYS[provider],
      );
    }
  });

  /**
   * The founder's answer, 2026-09-16, pinned as a value.
   *
   * People found in Gmail are part of the SAME paid feature as people found in
   * Outlook. If someone later splits them, this reddens and they have to say
   * so — a split needs a second plan row created and switched on per customer,
   * which is not something to discover from a merged diff.
   */
  it("puts both mailboxes on one shared paid feature", () => {
    expect(MAIN_KEYS.outlook).toBe(MAIN_KEYS.gmail);
    expect(new Set(Object.values(MAIN_KEYS)).size).toBe(1);
  });
});
