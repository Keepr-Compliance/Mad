/**
 * Data-Source Floor (BACKLOG-1821)
 *
 * Pure predicates that enforce the onboarding "integrity floor": a user must
 * NOT be able to finish onboarding with ZERO connected data sources. The floor
 * is satisfied by at least ONE of:
 *   - a connected mailbox (email), OR
 *   - a text-message source (iPhone via macOS Full Disk Access, iPhone via the
 *     Windows/macOS Apple driver, or an Android companion).
 *
 * IMPORTANT — texts-only is a VALID, non-degraded completion state. This module
 * is deliberately fail-OPEN for the paths where "texts connected" is not cleanly
 * observable from `OnboardingContext` (see rules below). Over-blocking a user who
 * legitimately has a source is a worse regression than the narrow gap this closes,
 * so the floor blocks ONLY the affirmative "skip everything" dead-end.
 *
 * Why per-platform, not a single boolean:
 *   - macOS: `permissionsGranted === true` (Full Disk Access) drives the Messages
 *     import, so it is a reliable "texts capability" signal.
 *   - Windows iPhone: there is no FDA step; the only signal is the Apple driver
 *     (`driverSetupComplete`). Driver-installed is a capability, not proof of a
 *     completed sync, but it is the best (and only) available signal.
 *   - Android: companion pairing is tracked in component-local state
 *     (AndroidComingSoonStep), NOT in `OnboardingContext`. So `phoneType ===
 *     'android'` alone satisfies the floor (fail-open) to avoid false-blocking a
 *     genuinely-paired Android user. Tightening this needs a pairing signal
 *     surfaced into context — tracked as a follow-up (see BACKLOG-1821 notes).
 *
 * This is a pure function of context (mirrors the queue's pure-function design in
 * buildQueue.ts). It performs NO IPC / no window.api access.
 *
 * @module onboarding/queue/dataSourceFloor
 */

import type { OnboardingContext } from "../types";

/**
 * Discriminates WHICH source satisfies the floor (or none). Returned by
 * {@link getSatisfyingSource} so callers/tests can assert on identity, not just
 * a boolean.
 */
export type DataSourceKind =
  | "email"
  | "texts-macos-fda"
  | "texts-iphone-driver"
  | "texts-android"
  | null;

/**
 * Returns true when the given platform is a macOS-family desktop where Full Disk
 * Access grants the Messages (texts) source. Linux reuses the macOS flow, so it
 * is grouped here for consistency with the flow registry (flows/index.ts).
 */
function isMacOsFamily(context: OnboardingContext): boolean {
  return context.platform === "macos" || context.platform === "linux";
}

/**
 * Determines which data source (if any) currently satisfies the integrity floor.
 *
 * Evaluated in priority order so the return value is stable and testable:
 *   1. email        — a mailbox is connected (`emailConnected === true`)
 *   2. texts-macos-fda      — macOS/linux + Full Disk Access granted
 *   3. texts-iphone-driver  — iPhone + Apple driver installed
 *   4. texts-android        — Android selected (companion path; fail-open)
 *
 * Note on the loading window: `emailConnected` and `permissionsGranted` are
 * `boolean | undefined` in `OnboardingContext`. The strict `=== true` checks
 * below intentionally treat `undefined` (unknown-during-load) as "not
 * connected", so a half-loaded context never spuriously satisfies the floor.
 * The queue's active-step ordering (buildQueue.ts) keeps the floor step from
 * rendering until it is genuinely last, so this does not flash mid-onboarding.
 *
 * @param context - The current onboarding context
 * @returns the satisfying {@link DataSourceKind}, or `null` if the floor is unmet
 */
export function getSatisfyingSource(context: OnboardingContext): DataSourceKind {
  // 1. Connected mailbox — the primary, platform-agnostic source.
  if (context.emailConnected === true) {
    return "email";
  }

  // 2. macOS/linux: Full Disk Access grants the Messages (texts) source.
  if (isMacOsFamily(context) && context.permissionsGranted === true) {
    return "texts-macos-fda";
  }

  // 3. iPhone: the Apple driver is the texts capability on Windows (and a
  //    secondary path on macOS). driverSetupComplete === true means installed;
  //    an explicitly *skipped* driver (driverSkipped) does NOT satisfy the floor.
  if (context.phoneType === "iphone" && context.driverSetupComplete === true) {
    return "texts-iphone-driver";
  }

  // 4. Android: companion pairing is not observable in context (component-local
  //    state). Fail-open on phoneType to avoid false-blocking a paired user.
  if (context.phoneType === "android") {
    return "texts-android";
  }

  return null;
}

/**
 * Whether the onboarding integrity floor is satisfied — i.e. the user has at
 * least one connected data source (texts OR email).
 *
 * When this returns false, the user is in the "zero sources" dead-end and must
 * not be allowed to complete onboarding.
 *
 * @param context - The current onboarding context
 * @returns true if at least one data source satisfies the floor
 */
export function hasMinimumDataSource(context: OnboardingContext): boolean {
  return getSatisfyingSource(context) !== null;
}
