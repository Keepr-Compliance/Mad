/**
 * Feature Gate Types
 * SPRINT-122: Plan Admin + Feature Gate Enforcement
 *
 * Canonical type definitions for feature gate access.
 * All feature gate consumers import from this single location.
 */

export interface FeatureAccess {
  allowed: boolean;
  value: string;
  source: "plan" | "override" | "default";
}

// ---------------------------------------------------------------------------
// Strict (fail-closed) feature keys — BACKLOG-3349
// ---------------------------------------------------------------------------

/**
 * The keys that FAIL CLOSED. Every other feature key keeps the fail-open
 * behaviour it has today, deliberately.
 *
 * Why per-key and not global: making every key fail closed was measured twice
 * against the export suites — it turns 7 of 19 red, because `text_export`,
 * `desktop_email_attachments` and friends are all read through
 * `useFeatureGate().isAllowed`, whose `?? true` is what lets an offline user
 * keep exporting. Strictness is a property of the key, not of the reader.
 *
 * **This union is the single list.** Both runtime records — the main-process
 * one in `electron/handlers/featureGateHandlers.ts` and the renderer one in
 * `src/hooks/useFeatureGate.ts` — are declared `Record<StrictFeatureKey, true>`,
 * so adding a member here fails `npm run type-check` until both records name
 * it, and an entry in either record that is not a member fails too. That is the
 * parity guard: a compile error, not a test that has to remember.
 *
 * The file is type-only, which is what lets the renderer import from it. A
 * VALUE in `electron/` cannot be imported by `src/` — Vite parses it as
 * JavaScript — so the two records are separate values by necessity.
 *
 * BACKLOG-3365 added `desktop_hide_from_export` here and to both records.
 *
 * `desktop_hide_from_export` gates ONLY the ability to HIDE a text from an
 * export. The export itself never reads it, and neither does unhide: a user
 * whose plan later loses the feature must still be able to put a text back into
 * their own export. `electron/handlers/hiddenTextHandlers.ts` is where that
 * lives — the hide channel calls the gate, the unhide channel does not import
 * it at all.
 */
export type StrictFeatureKey =
  | "email_contact_inference"
  | "desktop_hide_from_export"
  | "transaction_checklists";

/**
 * What a strict read concluded.
 *
 * Three values, not a boolean, because "your plan does not include this" and "I
 * could not find out" are different sentences to put in front of a user. An
 * offline but entitled user told "not in your plan" has been told something
 * false about what he bought. Consumers that only ACT (rather than explain) use
 * the boolean helper, which treats everything but `allowed` as no.
 */
export type StrictFeatureState = "allowed" | "blocked" | "unknown";

/** A strict state as the renderer sees it, before the first answer arrives. */
export type StrictFeatureStateOrPending = "pending" | StrictFeatureState;
