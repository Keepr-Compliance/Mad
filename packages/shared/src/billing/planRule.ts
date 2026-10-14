/**
 * The plan rule — BACKLOG-3859.
 *
 * ONE copy of the pure rule that decides which plan a user is on, shared by
 * the broker portal (Billing page, billing actions, routing) and the admin
 * portal (the plan a user is on, for support). Moved verbatim from
 *   - broker-portal/lib/billing/agentPlan.ts   (BACKLOG-3847)
 *   - broker-portal/lib/billing/customers.ts   (modeAllowsTestFlag, BACKLOG-3845)
 *   - broker-portal/lib/billing/capabilities.ts (AgentPlanState)
 *   - broker-portal/lib/auth/membership.ts     (BACKLOG-3364 / 3080 / 3917)
 * Those files re-export from here, so their importers did not change.
 *
 * Everything here is pure: no I/O, no clock, no environment. Callers read the
 * rows and pass them in.
 *
 * ---------------------------------------------------------------------------
 * No imports, deliberately.
 * ---------------------------------------------------------------------------
 * broker-portal's middleware.ts runs in the Edge runtime and reaches this file
 * through lib/auth/membership.ts. Anything imported here would be bundled into
 * the Edge middleware, and anything that pulls a Node-only or `next/headers`
 * module fails the Edge build — which no local test would report. The guard is
 * broker-portal/__tests__/agentFloor-3080/classify.test.ts.
 *
 * Tests for this file live in the portal suites (broker-portal jest and
 * admin-portal vitest). Nothing under packages/shared is run by CI.
 */

// ===========================================================================
// Stripe mode
// ===========================================================================

export type StripeMode = 'test' | 'live';

/** The mode-guard rule of isModeAllowedForUser, on an is_test flag already read (no personal org = false). */
export function modeAllowsTestFlag(mode: StripeMode, isTest: boolean): boolean {
  return mode === 'live' ? !isTest : isTest;
}

// ===========================================================================
// The personal Agent plan — BACKLOG-3847.
// ===========================================================================
//
// Refusal predicates are the grant RPC's, verbatim (SR R4,
// grant_unlimited_from_subscription in 20261011230913):
//   - support grant: an unlimited_transactions override EXISTS whose `source`
//     is not 'stripe' (any `enabled`, any `paid_through`);
//   - suspended: ANY licenses row of the user with status 'suspended'.
//
// "Ending" is read from cancel_at_period_end only: Stripe sets canceled_at as
// soon as a period-end cancel is requested, while the plan is still active (F5).

/** The personal Agent plan as billing_subscriptions reports it (3847). */
export type AgentPlanState = 'none' | 'active' | 'cancel_pending' | 'payment_failed' | 'support_grant';

export interface AgentSubscriptionRow {
  stripe_subscription_id: string;
  status: string;
  interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
}

export type UnlimitedOverride = Record<string, unknown> | null;

/** Rows the page can act on, best first. Closed and half-made rows are "no plan". */
export const ROW_PRIORITY = ['active', 'trialing', 'past_due', 'unpaid'] as const;

/**
 * The row the plan is read from: the first status of ROW_PRIORITY that any row
 * has. Rows with any other status are never picked. Pass rows of ONE user and
 * ONE Stripe mode.
 */
export function pickAgentRow<R extends Pick<AgentSubscriptionRow, 'status'>>(rows: readonly R[]): R | null {
  return ROW_PRIORITY.map((st) => rows.find((r) => r.status === st)).find((r): r is R => !!r) ?? null;
}

/** The grant RPC's non_stripe_override rule: key present and source is not 'stripe'. */
export function isNonStripeOverride(override: UnlimitedOverride | undefined): boolean {
  if (override === undefined) return false;
  return (override?.source ?? null) !== 'stripe';
}

/** _override_effective: absent/null paid_through -> effective; otherwise an ISO date-time in the future. */
export function overrideEffective(override: UnlimitedOverride, now: Date): boolean {
  const raw = override?.paid_through;
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Literal truth table (step 0 §2.4):
 *   active/trialing, cancel_at_period_end false -> active
 *   active/trialing, cancel_at_period_end true  -> cancel_pending
 *   past_due / unpaid                           -> payment_failed
 *   none (incl. incomplete, incomplete_expired, canceled):
 *     non-stripe override present               -> support_grant
 *     otherwise                                 -> none
 */
export function agentPlanState(
  row: Pick<AgentSubscriptionRow, 'status' | 'cancel_at_period_end'> | null,
  override: UnlimitedOverride | undefined
): AgentPlanState {
  if (row) {
    if (row.status === 'active' || row.status === 'trialing') {
      return row.cancel_at_period_end === true ? 'cancel_pending' : 'active';
    }
    if (row.status === 'past_due' || row.status === 'unpaid') return 'payment_failed';
  }
  return isNonStripeOverride(override) ? 'support_grant' : 'none';
}

// ===========================================================================
// Brokerage membership vs personal organization — BACKLOG-3364.
// ===========================================================================
//
// A solo user holds an `organization_members` row in an organization of their
// own. A personal organization is not a placement: the question every caller
// asks is "does this user belong to a BROKERAGE?", which
// `pickBrokerageMembership` answers (null for a solo user).
//
// The personal flag is computed from the WHOLE embedded organization record
// (`organizations(*)`), from a key that is absent before the 3364 migration.
// Absent key -> not personal -> the pre-migration behaviour. See
// broker-portal/lib/auth/membership.ts for why the column is never named in a
// query.

/**
 * BACKLOG-3917: the membership `license_status` values that grant anything.
 *
 * An ALLOW-list, so a status this file has never heard of grants nothing.
 * The database's `member_status_grants_access(text)` holds the same list;
 * the two change together (BACKLOG-3851).
 */
export const PORTAL_GRANTING_LICENSE_STATUSES = ['active'] as const;

/** Does this membership `license_status` grant portal rights? Missing / null = no. */
export function memberStatusGrantsAccess(status: string | null | undefined): boolean {
  return typeof status === 'string' && (PORTAL_GRANTING_LICENSE_STATUSES as readonly string[]).includes(status);
}

/** The embedded organization record, of which only one key is read here. */
export interface EmbeddedOrganization {
  /** Present only once BACKLOG-3364's migration has been applied. */
  personal_owner_user_id?: string | null;
}

/**
 * One row of broker-portal's PORTAL_MEMBERSHIP_SELECT
 * ('role, organization_id, license_status, organizations(*)').
 *
 * `role` and `organization_id` are NOT NULL columns, so they are declared
 * required. The embed is optional because it is what the pre-migration
 * database omits.
 */
export interface PortalMembershipRow {
  role: string;
  organization_id: string;
  /**
   * BACKLOG-3917. A base column (NOT NULL, CHECK pending|active|suspended|expired),
   * so it is present in every response to PORTAL_MEMBERSHIP_SELECT.
   * Optional in the type only so a row missing it reads as NOT granting.
   */
  license_status?: string | null;
  /**
   * Object on the wire; ARRAY in the type.
   *
   * PostgREST returns a single object for this embed — a many-to-one
   * relationship — and that is what the transcribed responses in
   * supabase/tests/backlog-3364/fixtures/ contain. But the portals' Supabase
   * clients are built without a generated `Database` type, so supabase-js
   * cannot know the cardinality and infers `any[]` from the select string.
   *
   * Both are declared, and `embeddedOrganization` below takes either. Narrowing
   * this to the object alone is what `npm run build` rejects; narrowing it to
   * the array alone would compile and then read `undefined` at runtime, which
   * silently makes every organization non-personal.
   */
  organizations?: EmbeddedOrganization | EmbeddedOrganization[] | null;
}

/** The embedded record, whichever of the two shapes it arrived in. */
function embeddedOrganization(row: PortalMembershipRow | null | undefined): EmbeddedOrganization | null {
  const embed = row?.organizations;
  if (!embed) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/**
 * Is this membership row the user's own personal organization?
 *
 * A null, empty or missing embed reads as NOT personal. That is the
 * pre-migration answer and the safe one.
 */
export function isPersonalMembership(row: PortalMembershipRow | null | undefined): boolean {
  return !!embeddedOrganization(row)?.personal_owner_user_id;
}

/**
 * The brokerage membership this user should be routed on, or null.
 *
 * Takes the first non-personal row in the order the query returned them, so the
 * caller must order deterministically (`created_at`, then `id`). SCIM and
 * directory sync can both write, so "two brokerage rows" is reachable and must
 * not resolve arbitrarily.
 *
 * Anything that is not an array — `null` from an error result included — is no
 * membership.
 */
export function pickBrokerageMembership(
  rows: PortalMembershipRow[] | null | undefined
): PortalMembershipRow | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row && !isPersonalMembership(row)) return row;
  }
  return null;
}

// ---- Portal access — BACKLOG-3080 ----------------------------------------------
//
// ONE classifier, used by every place that decides what a signed-in person may
// open in the broker portal.

/** Roles that open the whole portal. Everything else gets the floor. */
export const FULL_PORTAL_ROLES = ['broker', 'admin', 'it_admin'] as const;

/**
 * What a signed-in person may open.
 *
 *   full    - a brokerage broker / admin / it_admin: the whole portal.
 *   floor   - a brokerage member with any other role (agent, or a role this
 *             file has never heard of), or the OWNER of a personal
 *             organization: welcome dashboard, own support tickets, My Account.
 *   unknown - the membership read failed. Floor for this request, and never a
 *             sign-out: a transient read error must not sign every broker out.
 *   none    - no brokerage membership and no personal organization of their
 *             own. Not a portal user.
 */
export type PortalAccess =
  | { kind: 'full'; role: string; organizationId: string }
  | {
      kind: 'floor';
      /**
       * deactivated (BACKLOG-3917): the first brokerage row's `license_status`
       * does not grant access. Never falls through to a personal organization.
       */
      via: 'brokerage' | 'personal_owner' | 'deactivated';
      role: string;
      organizationId: string;
    }
  | { kind: 'unknown' }
  | { kind: 'none' };

/**
 * Classify the membership rows for `userId`.
 *
 * In order:
 *   1. Not an array (an error result) -> unknown.
 *   2. The first brokerage row decides: a status that does not grant access
 *      -> floor/deactivated (BACKLOG-3917; no fall-through to step 3); else a
 *      full role -> full; ANY other role -> floor. An unrecognised role or
 *      status therefore fails closed.
 *   3. Otherwise a personal organization whose owner IS this user -> floor.
 *      Equality with the session user, never mere presence of the owner key:
 *      a member of somebody else's personal organization is not its owner.
 *   4. Otherwise -> none.
 */
export function classifyPortalAccess(
  rows: PortalMembershipRow[] | null | undefined,
  userId: string
): PortalAccess {
  if (!Array.isArray(rows)) return { kind: 'unknown' };

  const brokerage = pickBrokerageMembership(rows);
  if (brokerage) {
    if (!memberStatusGrantsAccess(brokerage.license_status)) {
      return {
        kind: 'floor',
        via: 'deactivated',
        role: brokerage.role,
        organizationId: brokerage.organization_id,
      };
    }
    if ((FULL_PORTAL_ROLES as readonly string[]).includes(brokerage.role)) {
      return { kind: 'full', role: brokerage.role, organizationId: brokerage.organization_id };
    }
    return {
      kind: 'floor',
      via: 'brokerage',
      role: brokerage.role,
      organizationId: brokerage.organization_id,
    };
  }

  for (const row of rows) {
    const owner = embeddedOrganization(row)?.personal_owner_user_id;
    if (owner && owner === userId) {
      return {
        kind: 'floor',
        via: 'personal_owner',
        role: row.role,
        organizationId: row.organization_id,
      };
    }
  }

  return { kind: 'none' };
}
