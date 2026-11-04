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

/**
 * The personal Agent plan as billing_subscriptions reports it (3847).
 * 'trial' (BACKLOG-3860): a live solo free trial, an override with source 'trial'
 * whose paid_through is still ahead. An ended trial reads as 'none'.
 */
export type AgentPlanState = 'none' | 'active' | 'cancel_pending' | 'payment_failed' | 'support_grant' | 'trial';

/** Every AgentPlanState, for sweeps (BACKLOG-3860 T10). */
export const AGENT_PLAN_STATES: readonly AgentPlanState[] = [
  'none',
  'active',
  'cancel_pending',
  'payment_failed',
  'support_grant',
  'trial',
];

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

/**
 * The grant RPC's non_stripe_override rule: key present and source is neither
 * 'stripe' nor 'trial' (BACKLOG-3860: a Stripe grant replaces a trial, live or
 * ended). A missing source counts as null, so a sourceless override is refused.
 */
export function isNonStripeOverride(override: UnlimitedOverride | undefined): boolean {
  if (override === undefined) return false;
  const source = override?.source ?? null;
  return source !== 'stripe' && source !== 'trial';
}

/** BACKLOG-3860: the override was written by the solo free trial (live or ended). */
export function isTrialOverride(override: UnlimitedOverride | undefined): boolean {
  return override !== undefined && override !== null && override.source === 'trial';
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
 *     trial override, paid_through ahead        -> trial      (BACKLOG-3860)
 *     trial override, paid_through passed       -> none       (BACKLOG-3860)
 *     non-stripe override present               -> support_grant
 *     otherwise                                 -> none
 *
 * `now` decides whether a trial has ended. Callers that hold a clock pass it.
 */
export function agentPlanState(
  row: Pick<AgentSubscriptionRow, 'status' | 'cancel_at_period_end'> | null,
  override: UnlimitedOverride | undefined,
  now: Date = new Date()
): AgentPlanState {
  if (row) {
    if (row.status === 'active' || row.status === 'trialing') {
      return row.cancel_at_period_end === true ? 'cancel_pending' : 'active';
    }
    if (row.status === 'past_due' || row.status === 'unpaid') return 'payment_failed';
  }
  if (isTrialOverride(override)) return overrideEffective(override ?? null, now) ? 'trial' : 'none';
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

/**
 * BACKLOG-3851: the database's other membership predicates (M1,
 * 20261015152446), as TS twins. Each set is the IN-list of the SQL helper named
 * beside it, and the parity test (broker-portal
 * __tests__/license-model-3851/parity.test.ts) reads the migration and compares.
 */
/** member_status_is_deactivated(text): suspended or expired. A deactivated member reverts to pay-as-you-go. */
export const MEMBER_DEACTIVATED_STATUSES = ['suspended', 'expired'] as const;
/** member_status_holds_seat(text). */
export const MEMBER_SEAT_STATUSES = ['active', 'pending'] as const;
/** member_origin_is_idp(text): rows the identity provider owns. */
export const MEMBER_IDP_ORIGINS = ['jit', 'scim', 'directory_sync'] as const;
/** A member placed in the brokerage with no license assigned (BACKLOG-3851). */
export const MEMBER_UNASSIGNED_STATUS = 'unassigned';

function inList(list: readonly string[], value: string | null | undefined): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** member_status_is_deactivated: missing / null / unknown = no. */
export function memberStatusIsDeactivated(status: string | null | undefined): boolean {
  return inList(MEMBER_DEACTIVATED_STATUSES, status);
}

/** member_status_holds_seat: missing / null / unknown = no. */
export function memberStatusHoldsSeat(status: string | null | undefined): boolean {
  return inList(MEMBER_SEAT_STATUSES, status);
}

/** member_origin_is_idp: missing / null / unknown = no. */
export function memberOriginIsIdp(provisionedBy: string | null | undefined): boolean {
  return inList(MEMBER_IDP_ORIGINS, provisionedBy);
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
       * does not grant access, and the member does not own a personal
       * organization row to revert to.
       * unlicensed (BACKLOG-3851): the first brokerage row is 'unassigned' —
       * placed in the brokerage, no license yet. Same floor as deactivated.
       * personal_owner is also returned for a DEACTIVATED (suspended/expired)
       * brokerage member who holds their own personal row (BACKLOG-3851: back
       * to individual pay-as-you-go). Any other non-granting status never
       * falls through.
       */
      via: 'brokerage' | 'personal_owner' | 'deactivated' | 'unlicensed';
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
 *   2. The first brokerage row decides. A status that does not grant access:
 *      - deactivated (suspended / expired) AND the user owns a personal row ->
 *        floor/personal_owner on that row (BACKLOG-3851: pay-as-you-go);
 *      - 'unassigned' -> floor/unlicensed (BACKLOG-3851);
 *      - anything else (pending, null, unknown), or deactivated with no
 *        personal row -> floor/deactivated (BACKLOG-3917). No fall-through.
 *      A granting status: a full role -> full; ANY other role -> floor. An
 *      unrecognised role or status therefore fails closed.
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
      if (memberStatusIsDeactivated(brokerage.license_status)) {
        const own = ownPersonalRow(rows, userId);
        if (own) {
          return { kind: 'floor', via: 'personal_owner', role: own.role, organizationId: own.organization_id };
        }
      }
      if (brokerage.license_status === MEMBER_UNASSIGNED_STATUS) {
        return {
          kind: 'floor',
          via: 'unlicensed',
          role: brokerage.role,
          organizationId: brokerage.organization_id,
        };
      }
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

  const own = ownPersonalRow(rows, userId);
  if (own) {
    return {
      kind: 'floor',
      via: 'personal_owner',
      role: own.role,
      organizationId: own.organization_id,
    };
  }

  return { kind: 'none' };
}

/**
 * The row of the personal organization `userId` OWNS, or null. Equality with
 * the session user, never mere presence of the owner key: a member of somebody
 * else's personal organization is not its owner.
 */
function ownPersonalRow(rows: readonly PortalMembershipRow[], userId: string): PortalMembershipRow | null {
  for (const row of rows) {
    const owner = embeddedOrganization(row)?.personal_owner_user_id;
    if (owner && owner === userId) return row;
  }
  return null;
}

// ===========================================================================
// The one-line plan summary — BACKLOG-3859 (admin portal).
// ===========================================================================
//
// Built ONLY from the functions above, so the admin portal shows exactly the
// state the broker portal's Billing page computes. It carries the period-end date
// (renews / ends) and no price: no price is stored anywhere
// (price_book_price_id is NULL on every row; the price lives only in Stripe).
// BACKLOG-3852 adds the amount behind a billing.view permission.

export type PlanLineKind =
  | 'brokerage'
  | 'agent_unlimited'
  | 'agent_ending'
  | 'payment_failed'
  | 'support_grant'
  | 'support_grant_expired'
  | 'trial'
  | 'trial_ended'
  | 'pay_as_you_go'
  | 'no_organization';

export interface PlanLine {
  kind: PlanLineKind;
  text: string;
  /** The line was read from a TEST-mode subscription row (only possible for a test-org user). */
  test: boolean;
  /** Set when the plan and Unlimited disagree, e.g. Unlimited on with no open subscription row. */
  warning: string | null;
}

export interface PlanLineInput {
  /**
   * pickBrokerageMembership's row with its organization name, or null. Null
   * also for a deactivated member routed on their own personal row (pass the
   * brokerage name in `deactivatedFrom` instead) — the classifier's answer.
   */
  brokerage: { orgName: string | null; licenseStatus: string | null | undefined } | null;
  /**
   * BACKLOG-3851: the brokerage a member was deactivated from, when
   * classifyPortalAccess routes them on their own personal organization.
   * Shown as the line's warning.
   */
  deactivatedFrom?: string | null;
  /** organizations.personal_owner_user_id = user (getPersonalOrganization's read). */
  hasPersonalOrganization: boolean;
  /** The user's Stripe mode: modeAllowsTestFlag on the personal organization's is_test. */
  mode: StripeMode;
  /** The user's billing_subscriptions rows IN `mode` (any status). */
  rows: readonly AgentSubscriptionRow[];
  /** feature_overrides.unlimited_transactions on the personal organization; undefined = key absent. */
  override: UnlimitedOverride | undefined;
  /** ANY licenses row of the user with status 'suspended'. */
  suspended: boolean;
  /** Credit balance, when the caller has it (detail page only). */
  credits?: number;
  now: Date;
}

/**
 * "Nov 12, 2026" of an ISO date-time, in UTC (so server and browser agree), or
 * null. Same format and timezone as broker-portal formatDay (PlanBlock.tsx).
 */
function longDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/**
 * Is Unlimited ON from this override, the way check_feature_access /
 * get_org_features read it: present, _override_effective, and
 * COALESCE(enabled, true). (The tier ceiling, _override_above_tier, is not
 * mirrored: it needs the plan tier and only ever turns Unlimited OFF.)
 */
function overrideTurnsUnlimitedOn(override: UnlimitedOverride | undefined, now: Date): boolean {
  if (override === undefined || override === null) return false;
  if (!overrideEffective(override, now)) return false;
  return override.enabled !== false;
}

export function planLine(input: PlanLineInput): PlanLine {
  const prefix = input.suspended ? 'Suspended — ' : '';
  const deactivated =
    input.brokerage === null && typeof input.deactivatedFrom === 'string'
      ? `Deactivated from ${input.deactivatedFrom || 'unnamed organization'}`
      : null;
  const line = (kind: PlanLineKind, text: string, test = false, warning: string | null = null): PlanLine => ({
    kind,
    text: prefix + text,
    test,
    warning: deactivated && warning ? `${deactivated}; ${warning}` : (deactivated ?? warning),
  });

  if (input.brokerage) {
    const org = input.brokerage.orgName ?? 'unnamed organization';
    const status = input.brokerage.licenseStatus ?? 'unknown';
    if (memberStatusGrantsAccess(status)) return line('brokerage', `Brokerage ${org}, license assigned`);
    if (status === 'pending') return line('brokerage', `Brokerage ${org}, invite pending`);
    if (status === MEMBER_UNASSIGNED_STATUS) return line('brokerage', `Brokerage ${org}, no license assigned`);
    return line('brokerage', `Brokerage ${org}, no license (${status})`);
  }

  const row = pickAgentRow(input.rows);
  const state = agentPlanState(row, input.override, input.now);
  const fromTestRow = row !== null && input.mode === 'test';

  switch (state) {
    case 'active': {
      const renews = longDay(row?.current_period_end);
      return line('agent_unlimited', `Agent Unlimited, paid by Stripe${renews ? `, renews ${renews}` : ''}`, fromTestRow);
    }
    case 'cancel_pending': {
      const day = longDay(row?.current_period_end);
      return line('agent_ending', `Agent Unlimited, paid by Stripe, ends ${day ?? 'at period end'}`, fromTestRow);
    }
    case 'payment_failed':
      return line('payment_failed', 'Agent Unlimited, payment failed', fromTestRow);
    case 'support_grant': {
      if (!overrideEffective(input.override ?? null, input.now)) {
        return line('support_grant_expired', 'Unlimited support grant (expired)');
      }
      const until = longDay(input.override?.paid_through);
      return line('support_grant', until ? `Unlimited support grant until ${until}` : 'Unlimited support grant');
    }
    case 'trial': {
      // BACKLOG-3860: a live trial always carries paid_through (the start function refuses without one).
      const until = longDay(input.override?.paid_through);
      return line('trial', until ? `Free trial until ${until}` : 'Free trial');
    }
    case 'none':
    default: {
      if (!input.hasPersonalOrganization && input.rows.length === 0) {
        return line('no_organization', 'No plan (no organization)');
      }
      const credits = typeof input.credits === 'number' ? `, ${input.credits} credits` : '';
      // BACKLOG-3860: an ended trial reads as none; say so, and never warn "Unlimited is on".
      if (isTrialOverride(input.override) && !overrideEffective(input.override ?? null, input.now)) {
        return line('trial_ended', `Free trial (ended), Solo Pay as you go${credits}`);
      }
      const warning = overrideTurnsUnlimitedOn(input.override, input.now)
        ? 'Unlimited is on, but no open subscription was found'
        : null;
      return line('pay_as_you_go', `Solo Pay as you go${credits}`, false, warning);
    }
  }
}
