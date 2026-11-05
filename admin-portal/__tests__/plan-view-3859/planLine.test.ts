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
    ['active', false, 'agent_unlimited', 'Agent Unlimited, paid by Stripe, renews Nov 12, 2026'],
    ['trialing', false, 'agent_unlimited', 'Agent Unlimited, paid by Stripe, renews Nov 12, 2026'],
    ['active', true, 'agent_ending', 'Agent Unlimited, paid by Stripe, ends Nov 12, 2026'],
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

  it('an active plan says "renews <period end>"; the date is current_period_end, not created_at', () => {
    const out = planLine(input({ rows: [{ ...row('active'), created_at: '2026-01-02T03:04:05+00:00' } as AgentSubscriptionRow] }));
    expect(out.text).toBe('Agent Unlimited, paid by Stripe, renews Nov 12, 2026');
    expect(out.text).not.toContain('Jan 2, 2026');
  });

  it('the date is UTC: 23:30 UTC on Nov 12 stays Nov 12', () => {
    const r = { ...row('active'), current_period_end: '2026-11-12T23:30:00+00:00' };
    expect(planLine(input({ rows: [r] })).text).toBe('Agent Unlimited, paid by Stripe, renews Nov 12, 2026');
  });

  it('no subscription row -> no date; row with no period end -> no renews', () => {
    expect(planLine(input({ rows: [] })).text).not.toMatch(/renews|ends/);
    const r = { ...row('active'), current_period_end: null };
    expect(planLine(input({ rows: [r] })).text).toBe('Agent Unlimited, paid by Stripe');
  });

  it('no price, no currency sign on any subscription line', () => {
    for (const st of ['active', 'trialing', 'past_due']) {
      expect(planLine(input({ rows: [row(st)] })).text).not.toMatch(/[$€£]|month|charge/i);
    }
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
      text: 'Unlimited support grant until Dec 1, 2026',
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
    // BACKLOG-3851
    expect(b('unassigned').text).toBe('Brokerage Demo Realty, no license assigned');
  });

  it('BACKLOG-3851: deactivatedFrom warns on the personal line, and combines with the Q4 warning', () => {
    expect(planLine(input({ deactivatedFrom: 'Demo Realty', rows: [row('active')] })).warning).toBe('Deactivated from Demo Realty');
    expect(planLine(input({ deactivatedFrom: '' })).warning).toBe('Deactivated from unnamed organization');
    const stripeOn = { source: 'stripe', enabled: true, paid_through: '2026-11-13T00:13:44+00:00' };
    expect(planLine(input({ deactivatedFrom: 'Demo Realty', override: stripeOn })).warning).toBe(
      'Deactivated from Demo Realty; Unlimited is on, but no open subscription was found'
    );
    expect(planLine(input({ deactivatedFrom: null })).warning).toBeNull();
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
    expect(planLine(input({ suspended: true, rows: [row('active')] })).text).toBe('Suspended — Agent Unlimited, paid by Stripe, renews Nov 12, 2026');
    expect(planLine(input({ hasPersonalOrganization: false }))).toMatchObject({ kind: 'no_organization', text: 'No plan (no organization)' });
  });
});

// BACKLOG-3860 T11b (SR C7). Override shape: migration 20261031140000:235-238, with
// paid_through as keepr-test renders to_jsonb(timestamptz). [EDITED: dates around NOW.]
describe('BACKLOG-3860 T11b: the free trial on the admin plan line', () => {
  const trial = (offsetDays: number) => ({
    enabled: true,
    source: 'trial',
    paid_through: new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().replace('Z', '973+00:00'), // e.g. 2026-10-28T12:00:00.000973+00:00
  });

  it('live trial -> kind trial, "Free trial until <date>", no warning', () => {
    const o = trial(14);
    const out = planLine(input({ override: o }));
    expect(out.kind).toBe('trial');
    expect(out.text).toMatch(/^Free trial until [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(out.warning).toBeNull();
    expect(out.text).not.toMatch(/Pay as you go/);
  });

  it('ended trial -> kind trial_ended, "Free trial (ended)", no "Unlimited is on" warning', () => {
    const out = planLine(input({ override: trial(-1), credits: 2 }));
    expect(out).toMatchObject({ kind: 'trial_ended', text: 'Free trial (ended), Solo Pay as you go, 2 credits', warning: null });
  });

  it('the line follows input.now, not the wall clock', () => {
    const o = trial(1);
    expect(planLine(input({ override: o })).kind).toBe('trial');
    expect(planLine(input({ override: o, now: new Date(NOW.getTime() + 2 * 86_400_000) })).kind).toBe('trial_ended');
  });

  it('control: an ended support grant is still "support grant (expired)", not a trial', () => {
    const out = planLine(input({ override: { ...trial(-1), source: 'support' } }));
    expect(out.kind).toBe('support_grant_expired');
  });

  it('control: an EXPIRED Stripe override with no open row stays plain pay as you go (the ended-trial line needs source trial)', () => {
    const out = planLine(input({ override: { enabled: true, source: 'stripe', paid_through: '2026-10-01T00:00:00+00:00' } }));
    expect(out).toMatchObject({ kind: 'pay_as_you_go', text: 'Solo Pay as you go', warning: null });
  });

  it('an open subscription beats a live trial', () => {
    expect(planLine(input({ rows: [row('active')], override: trial(14) })).kind).toBe('agent_unlimited');
  });
});
