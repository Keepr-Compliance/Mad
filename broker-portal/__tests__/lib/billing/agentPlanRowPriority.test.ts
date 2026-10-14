/**
 * @jest-environment node
 *
 * BACKLOG-3859 R1 — which billing_subscriptions row the plan view reads when a
 * user has more than one row it could act on.
 *
 * getAgentPlanView picks by ROW_PRIORITY (active, trialing, past_due, unpaid).
 * Before this file, reversing that order left every billing suite green, so the
 * selection was unguarded. It is pinned here before it moves to
 * packages/shared (BACKLOG-3859), and it must stay green after the move.
 *
 * Reachable pairs only. The partial unique index
 * billing_subscriptions_one_open_per_user_mode (user_id, stripe_mode) WHERE
 * status IN (active, trialing, past_due, incomplete) — 20261011230913, mirrored
 * in helpers/billingDb.ts — allows at most ONE of active/trialing/past_due per
 * user and mode. `unpaid` is outside the index, so the pairs a user can hold are
 * {active|trialing|past_due} + unpaid. A pair like past_due + active cannot be
 * written, and is not used. The test asserts its own seed obeys the index.
 *
 * Rows: mirrorState() of the captured TEST subscription sub-C-keep
 * (fixtures/stripe/p3847), with the status EDITED per case and a second
 * subscription id. Ids are the invented fixture ids.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, type Row } from '../../helpers/billingDb';
import { FIXTURE_PERSONAL_ORG_ID, FIXTURE_USER_ID } from '../../helpers/postgrestEmulator';
import { getAgentPlanView } from '@/lib/billing/agentPlan';
import { mirrorState } from '@/lib/billing/sync';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

type Obj = Record<string, any>;
const FX = path.join(__dirname, '../../fixtures/stripe/p3847');
const C_KEEP: Obj = JSON.parse(fs.readFileSync(path.join(FX, 'sub-C-keep.json'), 'utf8'));
const CUS: string = JSON.parse(fs.readFileSync(path.join(FX, 'cus.json'), 'utf8')).id;

const OPEN_INDEX_STATUSES = ['active', 'trialing', 'past_due', 'incomplete'];

function mirrorRow(subId: string, status: string): Row {
  return {
    id: `row-${subId}`,
    stripe_mode: 'test',
    user_id: FIXTURE_USER_ID,
    organization_id: FIXTURE_PERSONAL_ORG_ID,
    stripe_customer_id: CUS,
    stripe_subscription_id: subId,
    ...mirrorState(C_KEEP as never),
    status, // [EDITED status of sub-C-keep]
    last_event_created: 1791000000,
  };
}

function service(rows: Row[]): any {
  const d = new BillingDb({
    organizations: [{ id: FIXTURE_PERSONAL_ORG_ID, personal_owner_user_id: FIXTURE_USER_ID, is_test: true }],
    organization_plans: [{ organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: {} }],
    licenses: [],
    billing_subscriptions: rows,
  });
  return { from: d.from };
}

describe('R1: the plan view reads the highest-priority open row', () => {
  it.each([
    // [case, winner status, loser status, expected state]
    ['active beats unpaid', 'active', 'unpaid', 'active'],
    ['trialing beats unpaid', 'trialing', 'unpaid', 'active'],
    ['past_due beats unpaid', 'past_due', 'unpaid', 'payment_failed'],
  ])('%s', async (_name, winner, loser, state) => {
    // Loser first, so "first row returned" cannot pass for "highest priority".
    const rows = [mirrorRow('sub_r1_loser', loser), mirrorRow('sub_r1_winner', winner)];
    expect(rows.filter((r) => OPEN_INDEX_STATUSES.includes(r.status as string)).length).toBeLessThanOrEqual(1);

    const view = await getAgentPlanView(service(rows), FIXTURE_USER_ID, 'test');
    expect(view.row?.stripe_subscription_id).toBe('sub_r1_winner');
    expect(view.row?.status).toBe(winner);
    expect(view.state).toBe(state);
  });

  it('only rows of the requested mode count', async () => {
    const live = { ...mirrorRow('sub_r1_live', 'active'), stripe_mode: 'live' };
    const view = await getAgentPlanView(
      service([live, mirrorRow('sub_r1_test', 'unpaid')]),
      FIXTURE_USER_ID,
      'test'
    );
    expect(view.row?.stripe_subscription_id).toBe('sub_r1_test');
    expect(view.state).toBe('payment_failed');
  });
});
