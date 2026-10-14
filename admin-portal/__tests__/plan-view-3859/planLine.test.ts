/**
 * BACKLOG-3859 — planLine, the one-line summary in the shared plan rule
 * (packages/shared/src/billing/planRule.ts). Tests sit in the admin suite
 * because CI runs nothing under packages/shared (SR R2).
 *
 * Row shapes: the TEST-mode subscription mirror (see fixtures.ts provenance).
 */

import { describe, expect, it } from 'vitest';
import { planLine, type AgentSubscriptionRow, type PlanLineInput } from '@keepr/shared';
import { NOW } from './fixtures';

function row(status: string, cape = false): AgentSubscriptionRow {
  return {
    stripe_subscription_id: 'sub_fx',
    status,
    interval: 'month',
    current_period_end: '2026-11-12T19:45:47+00:00',
    cancel_at_period_end: cape,
    canceled_at: cape ? '2026-10-12T19:46:23+00:00' : null,
  };
}

function input(over: Partial<PlanLineInput>): PlanLineInput {
  return {
    brokerage: null,
    hasPersonalOrganization: true,
    mode: 'test',
    rows: [],
    override: undefined,
    suspended: false,
    now: NOW,
    ...over,
  };
}

describe('planLine: literal table', () => {
  it.each([
    ['active', false, 'agent_unlimited', 'Agent Unlimited, paid by Stripe'],
    ['trialing', false, 'agent_unlimited', 'Agent Unlimited, paid by Stripe'],
    ['active', true, 'agent_ending', 'Agent Unlimited, paid by Stripe, ends 2026-11-12'],
    ['past_due', false, 'payment_failed', 'Agent Unlimited, payment failed'],
    ['unpaid', false, 'payment_failed', 'Agent Unlimited, payment failed'],
    ['incomplete', false, 'pay_as_you_go', 'Solo Pay as you go'],
    ['incomplete_expired', false, 'pay_as_you_go', 'Solo Pay as you go'],
  ] as const)('row %s (cancel_at_period_end %s) -> %s', (status, cape, kind, text) => {
    expect(planLine(input({ rows: [row(status, cape)] }))).toMatchObject({ kind, text });
  });

  it('C5: a cancelled-at-period-end plan never says "renews"', () => {
    const out = planLine(input({ rows: [row('active', true)] }));
    expect(out.text).toContain('ends');
    expect(out.text).not.toMatch(/renew/i);
  });

  it('an active plan shows no date at all (no next-charge date, Q1 open)', () => {
    const out = planLine(input({ rows: [row('active')] }));
    expect(out.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('TEST tag only when the line came from a test-mode row', () => {
    expect(planLine(input({ rows: [row('active')], mode: 'test' })).test).toBe(true);
    expect(planLine(input({ rows: [row('active')], mode: 'live' })).test).toBe(false);
    expect(planLine(input({ rows: [], mode: 'test' })).test).toBe(false);
  });

  it('support grant: open-ended, dated, expired', () => {
    expect(planLine(input({ override: { enabled: true } }))).toMatchObject({ kind: 'support_grant', text: 'Unlimited support grant' });
    expect(planLine(input({ override: { enabled: true, paid_through: '2026-12-01T00:00:00+00:00' } }))).toMatchObject({
      kind: 'support_grant',
      text: 'Unlimited support grant until 2026-12-01',
    });
    expect(planLine(input({ override: { enabled: true, paid_through: '2026-01-01T00:00:00+00:00' } }))).toMatchObject({
      kind: 'support_grant_expired',
      text: 'Unlimited support grant (expired)',
    });
  });

  it('brokerage: assigned, pending, other status', () => {
    const b = (licenseStatus: string) => planLine(input({ brokerage: { orgName: 'Demo Realty', licenseStatus }, rows: [row('active')] }));
    expect(b('active')).toMatchObject({ kind: 'brokerage', text: 'Brokerage Demo Realty, license assigned', test: false });
    expect(b('pending').text).toBe('Brokerage Demo Realty, invite pending');
    expect(b('expired').text).toBe('Brokerage Demo Realty, no license (expired)');
  });

  it('Pay as you go with credits', () => {
    expect(planLine(input({ credits: 3 })).text).toBe('Solo Pay as you go, 3 credits');
    expect(planLine(input({ credits: 0 })).text).toBe('Solo Pay as you go, 0 credits');
  });

  it('Q4 warning: Unlimited on (stripe source, effective, enabled not false) with no open row', () => {
    const stripeOn = { source: 'stripe', enabled: true, paid_through: '2026-11-13T00:13:44+00:00' };
    expect(planLine(input({ override: stripeOn })).warning).toBe('Unlimited is on, but no open subscription was found');
    expect(planLine(input({ override: { ...stripeOn, enabled: false } })).warning).toBeNull();
    expect(planLine(input({ override: { ...stripeOn, paid_through: '2026-01-01T00:00:00+00:00' } })).warning).toBeNull();
    expect(planLine(input({ override: stripeOn, rows: [row('active')] })).warning).toBeNull();
    expect(planLine(input({})).warning).toBeNull();
  });

  it('suspended prefix and no organization', () => {
    expect(planLine(input({ suspended: true, rows: [row('active')] })).text).toBe('Suspended — Agent Unlimited, paid by Stripe');
    expect(planLine(input({ hasPersonalOrganization: false }))).toMatchObject({ kind: 'no_organization', text: 'No plan (no organization)' });
  });
});
