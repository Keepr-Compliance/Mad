/**
 * The plan a user is on, for support — BACKLOG-3859.
 *
 * Reads the same facts the broker portal's Billing page reads and hands them to
 * the ONE shared rule (packages/shared/src/billing/planRule.ts → planLine). No
 * part of the rule is re-implemented here: this file only reads rows and groups
 * them by user.
 *
 * Reads are BATCHED: five queries whatever the number of users (the users list
 * asks for up to 100 at once). Never add a per-user query here.
 *
 * Service client only. billing_subscriptions has one RLS policy,
 * billing_subscriptions_select_own (authenticated, SELECT,
 * `(SELECT auth.uid()) = user_id`), so a staff session reads 0 rows for another
 * user. The CALLER must gate on the staff member's own session first:
 *   - users list: lib/actions/planLines.ts (has_permission users.view);
 *   - user page: app/dashboard/users/[id]/page.tsx (same gate, before its
 *     service client is created).
 *
 * Not a 'use server' module on purpose: such a module may export only async
 * functions, and this one is also called directly by the user page.
 */

import {
  ROW_PRIORITY,
  modeAllowsTestFlag,
  pickBrokerageMembership,
  classifyPortalAccess,
  planLine,
  type AgentSubscriptionRow,
  type PlanLine,
  type PortalMembershipRow,
  type StripeMode,
  type UnlimitedOverride,
} from '@keepr/shared';
import type { createServiceClient } from '@/lib/supabase/server';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const PLAN_LINES_MAX_IDS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A list of 1..100 uuids, or null. */
export function validPlanLineIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > PLAN_LINES_MAX_IDS) return null;
  if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null;
  return [...new Set(ids as string[])];
}

interface MemberRow extends PortalMembershipRow {
  user_id: string;
  organizations?: { name?: string | null; personal_owner_user_id?: string | null } | { name?: string | null; personal_owner_user_id?: string | null }[] | null;
}

interface SubscriptionRow extends AgentSubscriptionRow {
  user_id: string;
  stripe_mode: string;
}

function orgName(row: MemberRow): string | null {
  const embed = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
  return embed?.name ?? null;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Plan lines for `ids`, keyed by user id. Throws on any read error (the caller
 * shows "Plan unavailable"). `ids` must already be validated.
 */
export async function readPlanLines(
  service: ServiceClient,
  ids: string[],
  now: Date = new Date(),
  credits?: Record<string, number>
): Promise<Record<string, PlanLine>> {
  return (await readPlanLinesWithOrgs(service, ids, now, credits)).lines;
}

/**
 * readPlanLines plus, per user, the brokerage organization the line was decided from
 * (BACKLOG-3852). A user with no brokerage line has no entry. `PlanLine` is unchanged.
 */
export async function readPlanLinesWithOrgs(
  service: ServiceClient,
  ids: string[],
  now: Date = new Date(),
  credits?: Record<string, number>
): Promise<{ lines: Record<string, PlanLine>; brokerageOrgIds: Record<string, string> }> {
  const [membersRes, personalRes, subsRes, suspendedRes] = await Promise.all([
    // Same order as broker-portal's portal-access read (created_at, then id):
    // pickBrokerageMembership takes the FIRST brokerage row.
    service
      .from('organization_members')
      .select('user_id, role, organization_id, license_status, created_at, id, organizations(name, personal_owner_user_id)')
      .in('user_id', ids)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    // R5: the personal organization exactly as getPersonalOrganization finds it.
    service.from('organizations').select('id, personal_owner_user_id, is_test').in('personal_owner_user_id', ids),
    service
      .from('billing_subscriptions')
      .select('user_id, stripe_mode, stripe_subscription_id, status, interval, current_period_end, cancel_at_period_end, canceled_at')
      .in('user_id', ids)
      .in('status', [...ROW_PRIORITY, 'incomplete']),
    service.from('licenses').select('user_id').in('user_id', ids).eq('status', 'suspended'),
  ]);
  for (const [name, res] of [
    ['organization_members', membersRes],
    ['organizations', personalRes],
    ['billing_subscriptions', subsRes],
    ['licenses', suspendedRes],
  ] as const) {
    if (res.error) throw new Error(`${name} read failed: ${res.error.message}`);
  }

  const personalOrgs = (personalRes.data ?? []) as { id: string; personal_owner_user_id: string; is_test: boolean | null }[];
  const personalByUser = new Map(personalOrgs.map((o) => [o.personal_owner_user_id, o]));

  const overrides = new Map<string, UnlimitedOverride | undefined>();
  if (personalOrgs.length > 0) {
    const plansRes = await service
      .from('organization_plans')
      .select('organization_id, feature_overrides')
      .in(
        'organization_id',
        personalOrgs.map((o) => o.id)
      );
    if (plansRes.error) throw new Error(`organization_plans read failed: ${plansRes.error.message}`);
    for (const p of (plansRes.data ?? []) as { organization_id: string; feature_overrides: Record<string, unknown> | null }[]) {
      const fo = p.feature_overrides;
      if (fo && Object.prototype.hasOwnProperty.call(fo, 'unlimited_transactions')) {
        overrides.set(p.organization_id, (fo.unlimited_transactions as UnlimitedOverride) ?? null);
      }
    }
  }

  const membersByUser = groupBy((membersRes.data ?? []) as MemberRow[], (r) => r.user_id);
  const subsByUser = groupBy((subsRes.data ?? []) as SubscriptionRow[], (r) => r.user_id);
  const suspended = new Set(((suspendedRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id));

  const out: Record<string, PlanLine> = {};
  const brokerageOrgIds: Record<string, string> = {};
  for (const id of ids) {
    const memberRows = membersByUser.get(id) ?? [];
    const brokerageRow = pickBrokerageMembership(memberRows) as MemberRow | null;
    // BACKLOG-3851: a deactivated member the broker portal routes on their own
    // personal organization (pay-as-you-go) gets the personal line, with the
    // brokerage named in the warning. Same classifier as the broker portal.
    const access = classifyPortalAccess(memberRows, id);
    const reverted = brokerageRow !== null && access.kind === 'floor' && access.via === 'personal_owner';
    const brokerage = reverted ? null : brokerageRow;
    if (brokerage) brokerageOrgIds[id] = brokerage.organization_id;
    const personal = personalByUser.get(id) ?? null;
    // isModeAllowedForUser's rule: a test-org user's rows are test mode, everyone else's live.
    const mode: StripeMode = modeAllowsTestFlag('test', personal?.is_test === true) ? 'test' : 'live';
    out[id] = planLine({
      brokerage: brokerage ? { orgName: orgName(brokerage), licenseStatus: brokerage.license_status } : null,
      deactivatedFrom: reverted && brokerageRow ? (orgName(brokerageRow) ?? '') : null,
      hasPersonalOrganization: personal !== null,
      mode,
      rows: (subsByUser.get(id) ?? []).filter((r) => r.stripe_mode === mode),
      override: personal ? overrides.get(personal.id) : undefined,
      suspended: suspended.has(id),
      credits: credits?.[id],
      now,
    });
  }
  return { lines: out, brokerageOrgIds };
}
