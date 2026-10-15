/**
 * BACKLOG-3859 — the shared plan rule, as the admin portal imports it.
 *
 * The rule lives in packages/shared/src/billing/planRule.ts and is the same
 * code the broker portal's Billing page runs (broker-portal re-exports it).
 * Tests sit here, not under packages/shared, because CI runs nothing under
 * packages/shared (SR R2).
 *
 * `@keepr/shared` resolves through vitest.config.ts's alias to this checkout's
 * packages/shared/src (SR R3). Without the alias it would follow
 * node_modules/@keepr/shared, which in a worktree is the main checkout's copy.
 *
 * Input shapes:
 *   - overrides: the two feature_overrides.unlimited_transactions shapes seen
 *     in production — { enabled } (support grant, no source) and
 *     { enabled, paid_through, source: 'stripe' }; values invented.
 *   - membership rows: PostgREST's object embed for organizations(*), as in
 *     supabase/tests/backlog-3364/fixtures/; ids invented.
 */

import { describe, expect, it } from 'vitest';
import {
  ROW_PRIORITY,
  agentPlanState,
  classifyPortalAccess,
  isNonStripeOverride,
  modeAllowsTestFlag,
  overrideEffective,
  pickAgentRow,
  pickBrokerageMembership,
  type PortalMembershipRow,
} from '@keepr/shared';

const USER = '00000000-0000-4000-8000-000000385901'; // pii-allow-uuid: invented fixture id
const OTHER = '00000000-0000-4000-8000-000000385902'; // pii-allow-uuid: invented fixture id
const NOW = new Date('2026-10-14T12:00:00Z');

const SUPPORT_GRANT = { enabled: true };
const STRIPE_GRANT = { enabled: true, paid_through: '2026-11-14T00:00:00+00:00', source: 'stripe' };

describe('agentPlanState: literal table', () => {
  it.each([
    ['active', false, undefined, 'active'],
    ['trialing', false, undefined, 'active'],
    ['active', true, undefined, 'cancel_pending'],
    ['trialing', true, undefined, 'cancel_pending'],
    ['past_due', false, undefined, 'payment_failed'],
    ['unpaid', true, undefined, 'payment_failed'],
    ['incomplete', false, undefined, 'none'],
    ['incomplete_expired', false, SUPPORT_GRANT, 'support_grant'],
    ['canceled', false, STRIPE_GRANT, 'none'],
    ['active', false, SUPPORT_GRANT, 'active'],
  ] as const)('%s, cancel_at_period_end %s, override %j -> %s', (status, cape, override, state) => {
    expect(agentPlanState({ status, cancel_at_period_end: cape }, override)).toBe(state);
  });

  it('no row: support grant, stripe grant, null override, absent key', () => {
    expect(agentPlanState(null, SUPPORT_GRANT)).toBe('support_grant');
    expect(agentPlanState(null, STRIPE_GRANT)).toBe('none');
    expect(agentPlanState(null, null)).toBe('support_grant');
    expect(agentPlanState(null, undefined)).toBe('none');
  });
});

describe('pickAgentRow: highest priority wins, whatever the order', () => {
  it('priority order is active, trialing, past_due, unpaid', () => {
    expect([...ROW_PRIORITY]).toEqual(['active', 'trialing', 'past_due', 'unpaid']);
  });

  it.each([
    ['active', 'unpaid'],
    ['trialing', 'unpaid'],
    ['past_due', 'unpaid'],
  ])('%s beats %s', (winner, loser) => {
    const rows = [{ id: 'loser', status: loser }, { id: 'winner', status: winner }];
    expect(pickAgentRow(rows)?.id).toBe('winner');
    expect(pickAgentRow([...rows].reverse())?.id).toBe('winner');
  });

  it('closed and half-made rows are never picked', () => {
    expect(pickAgentRow([{ status: 'incomplete' }, { status: 'incomplete_expired' }, { status: 'canceled' }])).toBeNull();
    expect(pickAgentRow([])).toBeNull();
  });
});

describe('support grant helpers', () => {
  it('isNonStripeOverride', () => {
    expect(isNonStripeOverride(undefined)).toBe(false);
    expect(isNonStripeOverride(null)).toBe(true);
    expect(isNonStripeOverride(SUPPORT_GRANT)).toBe(true);
    expect(isNonStripeOverride(STRIPE_GRANT)).toBe(false);
  });

  it('overrideEffective', () => {
    expect(overrideEffective(SUPPORT_GRANT, NOW)).toBe(true);
    expect(overrideEffective({ paid_through: '2026-10-15T00:00:00Z' }, NOW)).toBe(true);
    expect(overrideEffective({ paid_through: '2026-10-13T00:00:00Z' }, NOW)).toBe(false);
    expect(overrideEffective({ paid_through: '2026-10-20' }, NOW)).toBe(false);
  });
});

describe('modeAllowsTestFlag', () => {
  it('live shows non-test orgs only; test shows test orgs only', () => {
    expect(modeAllowsTestFlag('live', false)).toBe(true);
    expect(modeAllowsTestFlag('live', true)).toBe(false);
    expect(modeAllowsTestFlag('test', true)).toBe(true);
    expect(modeAllowsTestFlag('test', false)).toBe(false);
  });
});

function member(role: string, org: string, owner: string | null, status = 'active'): PortalMembershipRow {
  return {
    role,
    organization_id: org,
    license_status: status,
    organizations: { personal_owner_user_id: owner },
  };
}

describe('brokerage vs personal', () => {
  const personal = member('admin', 'org-personal', USER);
  const brokerage = member('agent', 'org-brokerage', null);

  it('the first non-personal row is the brokerage, whatever comes first', () => {
    expect(pickBrokerageMembership([personal, brokerage])?.organization_id).toBe('org-brokerage');
    expect(pickBrokerageMembership([personal])).toBeNull();
    expect(pickBrokerageMembership(null)).toBeNull();
  });

  it('classifyPortalAccess', () => {
    expect(classifyPortalAccess(null, USER)).toEqual({ kind: 'unknown' });
    expect(classifyPortalAccess([], USER)).toEqual({ kind: 'none' });
    expect(classifyPortalAccess([personal], USER)).toMatchObject({ kind: 'floor', via: 'personal_owner' });
    expect(classifyPortalAccess([member('admin', 'org-x', OTHER)], USER)).toEqual({ kind: 'none' });
    expect(classifyPortalAccess([personal, brokerage], USER)).toMatchObject({ kind: 'floor', via: 'brokerage' });
    expect(classifyPortalAccess([member('broker', 'org-b', null)], USER)).toMatchObject({ kind: 'full' });
    expect(classifyPortalAccess([member('broker', 'org-b', null, 'pending'), personal], USER)).toMatchObject({
      kind: 'floor',
      via: 'deactivated',
    });
  });
});
