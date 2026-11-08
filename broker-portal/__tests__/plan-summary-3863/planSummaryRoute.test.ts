/**
 * @jest-environment node
 *
 * GET /api/billing/plan-summary — BACKLOG-3863 PR-2 (SR R4).
 *
 * billing_subscriptions rows are mirrorState() of the real TEST re-fetch
 * fixtures/stripe/p3847/sub-C-keep.json (as __tests__/lib/billing/agentPlan.test.ts),
 * plus the columns the webhook writes beside it (user_id, stripe_mode, Stripe ids).
 * Only the auth helper and the service client are mocked; getAgentPlanView and
 * the shared state rule run for real against the PostgREST emulator.
 */

import fs from 'fs';
import path from 'path';
import {
  FIXTURE_OTHER_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

const mockEmulator = createPostgrestEmulator();
const mockVerify = jest.fn();

jest.mock('@/lib/stripe', () => ({ verifyBearerUser: (...a: unknown[]) => mockVerify(...a) }));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: (table: string) => mockEmulator.from(table) }),
}));

import { GET } from '@/app/api/billing/plan-summary/route';
import { toPlanSummary } from '@/lib/billing/planSummary';
import type { AgentPlanView } from '@/lib/billing/agentPlan';
import { AGENT_PLAN_STATES } from '@keepr/shared';
import { mirrorState } from '@/lib/billing/sync';

const ORIGIN = 'http://localhost:3000';
const FIELDS = [
  'cancel_at_period_end',
  'current_period_end',
  'interval',
  'paymentIncomplete',
  'state',
  'subscriptionTrialEndsOn',
  'supportGrantEffective',
  'trialEndsOn',
];

type Obj = Record<string, any>;
const fx = (n: string): Obj =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/stripe/p3847', `${n}.json`), 'utf8'));

function subRow(userId: string, mode: 'test' | 'live', sub: Obj): Row {
  return {
    ...mirrorState(sub as never),
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer,
    user_id: userId,
    stripe_mode: mode,
  };
}

const KEEP = fx('sub-C-keep');
const ENDING = fx('sub-C-cancel-at-period-end');

function given(rows: Row[], extra: Record<string, Row[]> = {}): void {
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organizations: [{ id: FIXTURE_PERSONAL_ORG_ID, is_test: false, personal_owner_user_id: FIXTURE_USER_ID }],
      billing_subscriptions: rows,
      licenses: [{ user_id: FIXTURE_USER_ID, status: 'active' }],
      ...extra,
    },
  });
}

async function call(query = ''): Promise<{ status: number; body: Obj }> {
  const res = await GET(new Request(`${ORIGIN}/api/billing/plan-summary${query}`, { headers: { authorization: 'Bearer fixture-jwt' } }));
  return { status: res.status, body: await res.json() };
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  process.env.BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  mockVerify.mockResolvedValue({ userId: FIXTURE_USER_ID, email: 'agent-3863@fixture.example.test' });
});
afterAll(() => {
  process.env = ENV;
});

describe('flag and auth', () => {
  it('BILLING_ENABLED off -> 404, before auth or any read', async () => {
    process.env.BILLING_ENABLED = 'false';
    delete process.env.STRIPE_SECRET_KEY;
    const { status } = await call();
    expect(status).toBe(404);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockEmulator.state.selects).toHaveLength(0);
  });

  it('no verified user -> 401, no read', async () => {
    mockVerify.mockResolvedValue(null);
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
    expect(mockEmulator.state.selects).toHaveLength(0);
  });
});

describe('the caller only', () => {
  it("returns the caller's plan, not another user's, and ignores a user id in the query", async () => {
    given([subRow(FIXTURE_OTHER_USER_ID, 'test', ENDING), subRow(FIXTURE_USER_ID, 'test', KEEP)]);
    const { status, body } = await call(`?userId=${FIXTURE_OTHER_USER_ID}&user_id=${FIXTURE_OTHER_USER_ID}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      state: 'active',
      interval: 'month',
      current_period_end: mirrorState(KEEP as never).current_period_end,
      cancel_at_period_end: false,
      paymentIncomplete: false,
      supportGrantEffective: false,
      trialEndsOn: null,
      subscriptionTrialEndsOn: null,
    });
  });

  it('a user with only another user\'s row -> none', async () => {
    given([subRow(FIXTURE_OTHER_USER_ID, 'test', KEEP)]);
    const { body } = await call();
    expect(body.state).toBe('none');
    expect(body.current_period_end).toBeNull();
  });
});

describe('mode is this deployment\'s', () => {
  const rows = () => [subRow(FIXTURE_USER_ID, 'test', KEEP), subRow(FIXTURE_USER_ID, 'live', ENDING)];

  it('test key -> the test row only', async () => {
    given(rows());
    const { body } = await call();
    expect([body.state, body.cancel_at_period_end]).toEqual(['active', false]);
  });

  it('live key -> the live row only', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    given(rows());
    const { body } = await call();
    expect([body.state, body.cancel_at_period_end]).toEqual(['cancel_pending', true]);
  });

  it('live key, test row only -> none', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    given([subRow(FIXTURE_USER_ID, 'test', KEEP)]);
    expect((await call()).body.state).toBe('none');
  });

  it.each(['?mode=live', '?stripe_mode=live&livemode=true', '?mode=LIVE'])(
    'test key + %s in the query -> still the test row',
    async (qs) => {
      given(rows());
      const { body } = await call(qs);
      expect([body.state, body.cancel_at_period_end]).toEqual(['active', false]);
    },
  );

  it('live key + ?mode=test in the query -> still the live row', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    given(rows());
    const { body } = await call('?mode=test');
    expect([body.state, body.cancel_at_period_end]).toEqual(['cancel_pending', true]);
  });

  it('the response names no mode', async () => {
    given(rows());
    const text = JSON.stringify((await call()).body);
    expect(text).not.toMatch(/mode|livemode|"test"|"live"/);
  });
});

describe('DTO', () => {
  it('exactly the eight fields (six + BACKLOG-4088 trialEndsOn, subscriptionTrialEndsOn), no Stripe or customer ids', async () => {
    given([subRow(FIXTURE_USER_ID, 'test', KEEP)]);
    const { body } = await call();
    expect(Object.keys(body).sort()).toEqual(FIELDS);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/sub_|cus_|pm_|card|stripe|customer|canceled_at/i);
  });

  it('support grant, no row -> support_grant, effective', async () => {
    given([], { organization_plans: [{ organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true } } }] });
    const { body } = await call();
    expect(Object.keys(body).sort()).toEqual(FIELDS);
    expect([body.state, body.supportGrantEffective, body.interval]).toEqual(['support_grant', true, null]);
  });

  it('a read failure -> 503 with no detail', async () => {
    given([subRow(FIXTURE_USER_ID, 'test', KEEP)]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(mockEmulator, 'from').mockImplementation(() => {
      throw new Error('boom');
    });
    const { status, body } = await call();
    spy.mockRestore();
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'unavailable' });
  });
});

// ---- BACKLOG-3860 T10: the desktop never receives a state it rejects --------------

/** The desktop's own list, read from its source (electron cannot be imported here). */
function desktopStates(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '../../../electron/types/billing.ts'), 'utf8');
  const m = src.match(/export const AGENT_PLAN_STATES[^=]*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('fixture: AGENT_PLAN_STATES not found in electron/types/billing.ts');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe('BACKLOG-3860 T10: plan-summary maps every website state to a desktop state', () => {
  it('the desktop list is the five known states (positive control on the parse)', () => {
    expect(desktopStates()).toEqual(['none', 'active', 'cancel_pending', 'payment_failed', 'support_grant']);
  });

  it.each(AGENT_PLAN_STATES.map((s) => [s]))('state %s -> one of the desktop states', (state) => {
    const view = { state, row: null, paymentIncomplete: false, supportGrantEffective: false } as unknown as AgentPlanView;
    expect(desktopStates()).toContain(toPlanSummary(view).state);
  });

  const TRIAL = (paidThrough: string) => ({
    organization_plans: [
      { organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true, source: 'trial', paid_through: paidThrough } } },
    ],
  });

  it('live trial (no subscription row) -> support_grant, effective (desktop: "Unlimited exports", Active)', async () => {
    given([], TRIAL('2099-11-14T05:51:51.123973+00:00'));
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(FIELDS);
    expect([body.state, body.supportGrantEffective, body.interval, body.current_period_end]).toEqual(['support_grant', true, null, null]);
  });

  it('ended trial -> none, not effective', async () => {
    given([], TRIAL('2025-11-14T05:51:51.123973+00:00'));
    const { body } = await call();
    expect([body.state, body.supportGrantEffective]).toEqual(['none', false]);
  });
});

// ---- BACKLOG-4088: the trial dates the desktop card shows ------------------------

describe('BACKLOG-4088: trialEndsOn and subscriptionTrialEndsOn', () => {
  const TRIAL = (paidThrough: string) => ({
    organization_plans: [
      { organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true, source: 'trial', paid_through: paidThrough } } },
    ],
  });
  const LIVE_END = '2099-11-14T05:51:51.123973+00:00';

  it('live trial -> state support_grant (never trial) and trialEndsOn = the override paid_through', async () => {
    given([], TRIAL(LIVE_END));
    const { body } = await call();
    expect([body.state, body.trialEndsOn, body.subscriptionTrialEndsOn]).toEqual(['support_grant', LIVE_END, null]);
  });

  it('ended trial -> none, trialEndsOn null', async () => {
    given([], TRIAL('2025-11-14T05:51:51.123973+00:00'));
    const { body } = await call();
    expect([body.state, body.trialEndsOn]).toEqual(['none', null]);
  });

  it('a non-trial support grant -> trialEndsOn null (the desktop shows no Subscribe)', async () => {
    given([], { organization_plans: [{ organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true, source: 'support', paid_through: LIVE_END } } }] });
    const { body } = await call();
    expect([body.state, body.trialEndsOn]).toEqual(['support_grant', null]);
  });

  it('subscribed during the trial: row trialing + the trial override -> active, subscriptionTrialEndsOn = current_period_end [EDITED: sub-C-keep status trialing]', async () => {
    given([{ ...subRow(FIXTURE_USER_ID, 'test', KEEP), status: 'trialing' }], TRIAL(LIVE_END));
    const { body } = await call();
    const end = mirrorState(KEEP as never).current_period_end;
    expect(end).toEqual(expect.any(String));
    expect([body.state, body.trialEndsOn, body.subscriptionTrialEndsOn, body.current_period_end]).toEqual(['active', null, end, end]);
  });

  it('an active (not trialing) row -> subscriptionTrialEndsOn null', async () => {
    given([subRow(FIXTURE_USER_ID, 'test', KEEP)]);
    const { body } = await call();
    expect([body.state, body.subscriptionTrialEndsOn]).toEqual(['active', null]);
  });
});
