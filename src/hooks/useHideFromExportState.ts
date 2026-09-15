/**
 * STAND-IN for the hide-from-export entitlement state — BACKLOG-3366.
 *
 * The real hook is built by BACKLOG-3365 (on BACKLOG-3349's strict feature
 * state). Until then this always returns "blocked", so the "Hide from export"
 * control never renders. "Unhide" is never gated and renders in every state.
 *
 * BACKLOG-3365 replaces this body and turns the type below into an import;
 * the call site in `TransactionMessagesTab` does not change. There is
 * deliberately no override, flag or setting that makes this return "allowed":
 * tests that need the allowed path mock this module.
 */
export type HideFromExportState = "pending" | "allowed" | "blocked" | "unknown";

export function useHideFromExportState(): HideFromExportState {
  return "blocked";
}
