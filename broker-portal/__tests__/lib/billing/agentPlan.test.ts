/**
 * @jest-environment node
 *
 * BACKLOG-3847 — the Agent plan state table, the grant RPC's refusal
 * predicates, and the Checkout return base. Mirror rows are mirrorState() of
 * real TEST re-fetches (fixtures/stripe/p3847); edited fields say so.
 */

import fs from 'fs';
import path from 'path';
import { agentPlanState, isNonStripeOverride, overrideEffective } from '@/lib/billing/agentPlan';
import { chooseReturnBase, isAgentSession } from '@/lib/billing/agentCheckoutParams';
import { mirrorState } from '@/lib/billing/sync';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

type Obj = Record<string, any>;
const fx = (n: string): Obj =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/stripe/p3847', `${n}.json`), 'utf8'));
const row = (sub: Obj) => mirrorState(sub as never) as { status: string; cancel_at_period_end: boolean };

describe('C-STATE: agentPlanState, literal table (step 0 §2.4)', () => {
  const C = fx('sub-C-keep');
  it.each([
    ['active, not ending (sub-C-keep)', row(C), undefined, 'active'],
    ['active, ending: canceled_at set, cancel_at_period_end true (sub-C-cancel-at-period-end)', row(fx('sub-C-cancel-at-period-end')), undefined, 'cancel_pending'],
    ['trialing [EDITED status]', row({ ...C, status: 'trialing' }), undefined, 'active'],
    ['past_due [EDITED status]', row({ ...C, status: 'past_due' }), undefined, 'payment_failed'],
    ['unpaid [EDITED status]', row({ ...C, status: 'unpaid' }), undefined, 'payment_failed'],
    ['incomplete (sub-A-incomplete)', row(fx('sub-A-incomplete')), undefined, 'none'],
    ['incomplete_expired (sub-A-after-void)', row(fx('sub-A-after-void')), undefined, 'none'],
    ['canceled [EDITED status]', row({ ...C, status: 'canceled' }), undefined, 'none'],
    ['no row', null, undefined, 'none'],
    ['no row, support grant {enabled:true}', null, { enabled: true }, 'support_grant'],
    ['no row, stripe-sourced override', null, { enabled: true, source: 'stripe' }, 'none'],
    ['active row wins over a support grant', row(C), { enabled: true }, 'active'],
  ])('%s -> %s', (_n, r, override, state) => {
    expect(agentPlanState(r, override as never)).toBe(state);
  });

  it('F5 guard: the ending fixture really is active with canceled_at set', () => {
    const s = fx('sub-C-cancel-at-period-end');
    expect([s.status, s.cancel_at_period_end, s.canceled_at !== null]).toEqual(['active', true, true]);
  });
});

describe('R4: the grant RPC\'s non_stripe_override rule', () => {
  it.each([
    ['key absent', undefined, false],
    ['JSON null (key present)', null, true],
    ['{enabled:true} (prod shape)', { enabled: true }, true],
    ['{enabled:false}', { enabled: false }, true],
    ['past paid_through, no source', { enabled: true, paid_through: '2026-01-01T00:00:00Z' }, true],
    ['source support', { source: 'support' }, true],
    ['source stripe', { enabled: true, source: 'stripe' }, false],
  ])('%s -> %s', (_n, o, expected) => {
    expect(isNonStripeOverride(o as never)).toBe(expected);
  });

  it.each([
    ['no paid_through', { enabled: true }, true],
    ['future', { paid_through: '2099-01-01T00:00:00Z' }, true],
    ['past', { paid_through: '2026-01-01T00:00:00Z' }, false],
    ['not a date-time', { paid_through: '2099-01-01' }, false],
    ['not a string', { paid_through: 4102444800 }, false],
  ])('_override_effective: %s -> %s', (_n, o, expected) => {
    expect(overrideEffective(o, new Date('2026-10-12T00:00:00Z'))).toBe(expected);
  });
});

describe('Q6: which sessions are Agent sessions', () => {
  it('real TEST sessions: Agent (helper-made) yes, pay-per-export (route params) no', () => {
    expect(isAgentSession(fx('cs-S1-open') as never)).toBe(true);
    expect(isAgentSession(fx('cs-payg-open') as never)).toBe(false);
    expect(isAgentSession({ ...fx('cs-S1-open'), mode: 'payment' } as never)).toBe(false);
  });
});

describe('C-URL (R5): return base by exact-host allowlist', () => {
  const env = {
    NEXT_PUBLIC_APP_URL: 'https://app.keeprcompliance.com',
    VERCEL_URL: 'keepr-abc123.vercel.app',
    VERCEL_BRANCH_URL: 'keepr-git-feat-x.vercel.app',
  };
  it.each([
    ['app host', 'app.keeprcompliance.com', 'https://app.keeprcompliance.com', 'request'],
    ['deployment host', 'keepr-abc123.vercel.app', 'https://keepr-abc123.vercel.app', 'request'],
    ['branch host', 'keepr-git-feat-x.vercel.app', 'https://keepr-git-feat-x.vercel.app', 'request'],
    ['another Vercel project', 'evil.vercel.app', 'https://app.keeprcompliance.com', 'fallback'],
    ['suffix lookalike', 'x.keepr-git-feat-x.vercel.app', 'https://app.keeprcompliance.com', 'fallback'],
    ['prefix lookalike', 'app.keeprcompliance.com.evil.test', 'https://app.keeprcompliance.com', 'fallback'],
    ['missing host', null, 'https://app.keeprcompliance.com', 'fallback'],
    ['comma list, first wins', 'evil.vercel.app, app.keeprcompliance.com', 'https://app.keeprcompliance.com', 'fallback'],
    ['case', 'APP.KeeprCompliance.com', 'https://app.keeprcompliance.com', 'request'],
  ])('%s', (_n, host, base, source) => {
    expect(chooseReturnBase(host, env)).toEqual({ base, source });
  });

  it('dev: localhost keeps http when NEXT_PUBLIC_APP_URL is localhost', () => {
    expect(chooseReturnBase('localhost:3001', { NEXT_PUBLIC_APP_URL: 'http://localhost:3001' })).toEqual({
      base: 'http://localhost:3001',
      source: 'request',
    });
  });

  it('no NEXT_PUBLIC_APP_URL -> the production portal', () => {
    expect(chooseReturnBase('evil.vercel.app', {})).toEqual({ base: 'https://app.keeprcompliance.com', source: 'fallback' });
  });
});
