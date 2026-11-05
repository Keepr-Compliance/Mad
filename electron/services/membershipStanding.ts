/**
 * BACKLOG-3951 — where the signed-in user stands with their brokerage.
 *
 * The desktop's only other membership read
 * (`supabaseService.getActiveOrganizationMembershipOutcome`) filters on
 * `license_status = 'active'`, so a member the brokerage has not assigned a
 * license to, or has deactivated, reads exactly like a solo user. This module
 * reads ALL of the user's own rows and says which of those states applies.
 *
 * Founder rule (2026-10-17, confirmed 2026-11-04):
 *   - unlicensed  (brokerage row 'unassigned'): already-unlocked deals still
 *     export; NO new unlock on any app path (credit, per-deal card, saved card,
 *     Subscribe); message "Your brokerage hasn't assigned you a license.
 *     Contact your admin."
 *   - left_brokerage (brokerage row 'suspended' / 'expired'): solo paths work.
 *   - everyone else: unchanged.
 *
 * Mirror of `classifyPortalAccess` (packages/shared/src/billing/planRule.ts)
 * with one deliberate divergence (SR plan review R2): ANY active brokerage row
 * makes the user licensed, so an older unassigned row at brokerage A does not
 * block a member licensed at brokerage B. Electron cannot import
 * packages/shared, so the status lists are copied; the parity test reads that
 * file and compares them.
 *
 * Every read here is bounded (R1). A timeout, a throw, an error result or a
 * shape this code cannot read is `error` — never `none`, never `licensed`.
 */

import supabaseService, { type MembershipStandingRow } from "./supabaseService";
import logService from "./logService";

const MODULE = "MembershipStanding";

/** Same bound as the unlimited-entitlement read (entitlementService ENTITLEMENT_READ_TIMEOUT_MS). */
export const MEMBERSHIP_STANDING_READ_TIMEOUT_MS = 5_000;

/** Copied from planRule.ts MEMBER_UNASSIGNED_STATUS (parity-tested). */
export const MEMBER_UNASSIGNED_STATUS = "unassigned";
/** Copied from planRule.ts MEMBER_DEACTIVATED_STATUSES (parity-tested). */
export const MEMBER_DEACTIVATED_STATUSES: readonly string[] = ["suspended", "expired"];
/** Copied from planRule.ts PORTAL_GRANTING_LICENSE_STATUSES (parity-tested). */
export const MEMBER_GRANTING_STATUSES: readonly string[] = ["active"];

/** Fallback when a deactivated member's brokerage has no readable name. */
export const UNNAMED_BROKERAGE = "your brokerage";

export type MembershipStandingKind =
  | "licensed"
  | "unlicensed"
  | "left_brokerage"
  | "unknown"
  | "none"
  | "error";

export interface MembershipStanding {
  standing: MembershipStandingKind;
  /** The deciding brokerage's name. Set for `left_brokerage` (fallback {@link UNNAMED_BROKERAGE}). */
  organizationName?: string;
}

function embedOf(row: MembershipStandingRow): { name?: string | null; personal_owner_user_id?: string | null } | null {
  const embed = row.organizations;
  if (!embed) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/** A personal organization (anyone's) is not a brokerage — same test as planRule's pickBrokerageMembership. */
function isBrokerageRow(row: MembershipStandingRow): boolean {
  return !embedOf(row)?.personal_owner_user_id;
}

/**
 * Classify the user's own membership rows, in the order the query returned
 * them (created_at, id). Pure.
 *
 * In order:
 *   1. not an array → error
 *   2. any brokerage row with a granting status → licensed (R2)
 *   3. the FIRST brokerage row decides:
 *        'unassigned'          → unlicensed
 *        'suspended'/'expired' → left_brokerage (+ name)
 *        anything else         → unknown (pending, null, a status never seen)
 *   4. no brokerage row (only personal rows, or none) → none
 */
export function classifyMembershipStanding(rows: unknown, userId: string): MembershipStanding {
  if (!Array.isArray(rows)) return { standing: "error" };

  const own = (rows as MembershipStandingRow[]).filter(
    (row) => row && typeof row === "object" && (row.user_id === undefined || row.user_id === userId),
  );
  const brokerage = own.filter(isBrokerageRow);

  if (brokerage.some((row) => MEMBER_GRANTING_STATUSES.includes(row.license_status ?? ""))) {
    return { standing: "licensed" };
  }

  const first = brokerage[0];
  if (!first) return { standing: "none" };

  if (first.license_status === MEMBER_UNASSIGNED_STATUS) {
    return { standing: "unlicensed" };
  }
  if (MEMBER_DEACTIVATED_STATUSES.includes(first.license_status ?? "")) {
    const name = embedOf(first)?.name;
    return {
      standing: "left_brokerage",
      organizationName: typeof name === "string" && name.trim() !== "" ? name : UNNAMED_BROKERAGE,
    };
  }
  return { standing: "unknown" };
}

class MembershipStandingTimeoutError extends Error {
  constructor() {
    super("membership standing read timed out");
    this.name = "MembershipStandingTimeoutError";
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MembershipStandingTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read and classify the user's standing. Bounded by
 * {@link MEMBERSHIP_STANDING_READ_TIMEOUT_MS}. Never throws; any failure is
 * `{ standing: "error" }`.
 */
export async function readMembershipStanding(userId: string): Promise<MembershipStanding> {
  try {
    const result = await withTimeout(
      supabaseService.getMembershipStandingRows(userId),
      MEMBERSHIP_STANDING_READ_TIMEOUT_MS,
    );
    if (result.status !== "rows") return { standing: "error" };
    const standing = classifyMembershipStanding(result.rows, userId);
    if (standing.standing === "unknown") {
      logService.warn("[Membership] Brokerage row in a status this build does not act on", MODULE);
    }
    return standing;
  } catch (error) {
    logService.warn("[Membership] Standing read failed", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { standing: "error" };
  }
}
