/**
 * routeAccount — the ONE place that decides where a signed-in account lands
 * after loading (BACKLOG-3673).
 *
 * Input is the server-side per-account record `users.onboarding_completed_at`,
 * projected by main (`user:get-account-setup`) into three states:
 *
 * - `"finished"`     — the record is set (or its offline cache says so)
 * - `"not-finished"` — the record is empty
 * - `"unknown"`      — the server could not be read and there is no cache
 *
 * Rules:
 * - Only `"finished"` goes to the dashboard. `"unknown"` fails CLOSED to setup.
 * - Device state (mailbox token, Full Disk Access, Apple driver, the email-step
 *   answer) is NOT an input. It is checked at point of use, never here.
 * - Terms are NOT an input. The terms screen is AuthContext's
 *   `needsTermsAcceptance` and is shown over whichever destination this returns.
 *
 * @module appCore/state/machine/routing/routeAccount
 */

/** The per-account "setup finished" record, as main reports it. */
export type AccountSetup = "finished" | "not-finished" | "unknown";

/** Where a signed-in account lands after loading. */
export type AccountDestination = "dashboard" | "setup";

export interface RouteAccountInput {
  setup: AccountSetup;
}

export interface RouteAccountResult {
  destination: AccountDestination;
}

/**
 * Decide the landing for a signed-in account.
 *
 * Any value other than the literal `"finished"` (including a malformed value
 * arriving over IPC at runtime) routes to setup.
 */
export function routeAccount(input: RouteAccountInput): RouteAccountResult {
  if (input.setup === "finished") {
    return { destination: "dashboard" };
  }
  return { destination: "setup" };
}
