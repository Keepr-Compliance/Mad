/**
 * TrialStatusBanner Component
 * SPRINT-062: Trial Days Remaining Banner
 *
 * BACKLOG-2180 (2026-07-21): RETIRED.
 *
 * Individual accounts are provisioned ACTIVE under the pay-per-deal credit
 * model — they are NOT on a 14-day trial and have no expiry countdown. The
 * "N days left in your free trial / Upgrade now" banner was:
 *   - misleading (there is no trial and no "Upgrade" flow — access is
 *     credit/transaction_unlocks-based, gated by entitlementService, not the
 *     license), and
 *   - part of the same day-14 failure family as the false "Trial Expired"
 *     gate (BACKLOG-2148).
 *
 * The banner is now suppressed unconditionally. The component is retained
 * (rather than deleted) so its single mount site in App.tsx and its tests
 * stay valid; it simply renders nothing. Remove the component + mount point
 * entirely if/when the licensing→plans+credits unification lands
 * (BACKLOG-2020).
 */

import React from "react";

export function TrialStatusBanner(): React.ReactElement | null {
  // Retired for the individuals=active pay-per-deal model — never render a
  // trial countdown / upgrade prompt. See file header (BACKLOG-2180).
  return null;
}
