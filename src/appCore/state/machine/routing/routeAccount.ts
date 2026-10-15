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
 * Rules (allowlist):
 * - `"finished"` goes to the dashboard.
 * - `"not-finished"` goes to setup. Setup needs this positive answer.
 * - Anything else (`"unknown"`, or a malformed runtime value) goes to
 *   `"unavailable"`: the "Couldn't load your account settings" screen with
 *   Retry and Sign out. A failed read never means a new account.
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
export type AccountDestination = "dashboard" | "setup" | "unavailable";

export interface RouteAccountInput {
  setup: AccountSetup;
}

export interface RouteAccountResult {
  destination: AccountDestination;
}

/**
 * Decide the landing for a signed-in account.
 *
 * Only the literal `"finished"` reaches the dashboard and only the literal
 * `"not-finished"` reaches setup. Every other value (including a malformed
 * value arriving at runtime) is `"unavailable"`.
 */
export function routeAccount(input: RouteAccountInput): RouteAccountResult {
  if (input.setup === "finished") {
    return { destination: "dashboard" };
  }
  if (input.setup === "not-finished") {
    return { destination: "setup" };
  }
  return { destination: "unavailable" };
}
