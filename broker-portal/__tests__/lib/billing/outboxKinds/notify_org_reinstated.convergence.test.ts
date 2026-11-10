/**
 * @jest-environment node
 *
 * BACKLOG-4209 — billing_outbox kind `notify_org_reinstated` (lib/billing/orgReinstatedNotify.ts):
 * the billing contact is told the account is usable again, after a staff or automatic reinstate.
 *
 * Row shapes transcribed from _billing_reinstate_org
 * (supabase/migrations/20261108180000_backlog_4209_org_reinstated_notify.sql) and the keepr-test
 * controls R1 / A1 (supabase/tests/backlog-4200-4209), e.g. detail
 *   {"via": "staff", "note": "p4209 R1 reinstate", "notified": true, "was_reason": "other", "suspended_at_epoch": 1794081916}
 *   outbox dedupe_key 'notify_org_reinstated:<mode>:<org>:<epoch>', payload {organization_id, suspended_at_epoch, via}
 *   'suspended' rows (20261018230000): detail {reason, note}.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendOrgReinstatedEmail: (...a: unknown[]) => mockSend('staff', ...a),
  sendOrgAutoReinstatedEmail: (...a: unknown[]) => mockSend('auto', ...a),
}));

import { handleNotifyOrgReinstatedRow } from '@/lib/billing/orgReinstatedNotify';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-4209-RE';
const STAFF = 'USER-4209-STAFF';
const EPOCH = 1794081916;
const FUTURE = '2099-11-27T20:00:00+00:00';
const T1 = '2026-11-07T10:00:00.000+00:00';
const T2 = '2026-11-07T11:00:00.000+00:00';
const T3 = '2026-11-07T12:00:00.000+00:00';
let fake: BrokerageFake;

function row(via: 'staff' | 'auto' = 'staff', epoch = EPOCH, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `outbox-re-${epoch}`,
    stripe_mode: 'test',
    kind: 'notify_org_reinstated',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_org_reinstated:test:${ORG}:${epoch}`,
    run_after: '2026-11-07T00:00:00Z',
    payload: { organization_id: ORG, suspended_at_epoch: epoch, via },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: T2,
    processed_at: null,
    ...over,
  };
}
const suspendedRow = (at: string): Obj => ({ organization_id: ORG, actor_id: STAFF, action: 'suspended', created_at: at, detail: { reason: 'other', note: 'p4209' } });
const reinstatedRow = (at: string, epoch = EPOCH, via = 'staff'): Obj => ({
  organization_id: ORG,
  actor_id: via === 'staff' ? STAFF : null,
  action: 'reinstated',
  created_at: at,
  detail: { via, note: 'p4209 R1 reinstate', notified: true, was_reason: 'other', suspended_at_epoch: epoch },
});
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });
const sent = () => mockSend.mock.calls.map((c) => ({ via: c[0], ...c[1] }));

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 4209 RE', is_test: true }],
    org_deals: [dealRow(ORG, { version: 3, status: 'active' })],
    org_billing_stripe: [{ organization_id: ORG, stripe_mode: 'test', status: 'active', stripe_subscription_id: 'sub_4209', current_period_end: FUTURE, cancel_at_period_end: false }],
    billing_change_log: [suspendedRow(T1), reinstatedRow(T2)],
    email_delivery_log: [],
  });
  mockSend.mockImplementation(async (_via: string, p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'org_reinstated', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_org_reinstated', () => {
  it('J1: staff reinstate, auto-renew on -> one staff email with the renew line', async () => {
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()).toEqual([
      {
        via: 'staff',
        recipientEmail: 'billing-3853@example.test',
        brokerageName: 'Brokerage 4209 RE',
        billing: { kind: 'renews' },
        outboxKey: row().dedupe_key,
        organizationId: ORG,
      },
    ]);
  });

  it('J2: via auto -> the automatic template', async () => {
    fake.db.rows('billing_change_log')[1] = reinstatedRow(T2, EPOCH, 'auto');
    await handleNotifyOrgReinstatedRow(row('auto'), ctx());
    expect(sent().map((s) => s.via)).toEqual(['auto']);
  });

  it('J3: suspended again at run time -> nothing sent', async () => {
    fake.db.rows('org_deals')[0].status = 'suspended';
    await expect(handleNotifyOrgReinstatedRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('J4: superseded by a later suspension -> nothing sent', async () => {
    fake.db.rows('billing_change_log').push(suspendedRow(T3));
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('J5: rows sharing created_at with the reinstated row are not later -> sends', async () => {
    fake.db.rows('billing_change_log').push(suspendedRow(T2));
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('J6: no reinstated row with this epoch -> nothing sent', async () => {
    await handleNotifyOrgReinstatedRow(row('staff', EPOCH + 1), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('J7: canceling with a future period end -> the ends line with the date', async () => {
    fake.db.rows('org_deals')[0].status = 'canceling';
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()[0].billing).toEqual({ kind: 'ends', endsOn: 'Nov 27, 2099' });
  });

  it('J8 (RC1): canceling with a past period end -> the fallback, never a past date', async () => {
    fake.db.rows('org_deals')[0].status = 'canceling';
    fake.db.rows('org_billing_stripe')[0].current_period_end = '2020-01-15T00:00:00+00:00';
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()[0].billing).toEqual({ kind: 'ends', endsOn: null });
  });

  it('J9 (D1): active deal + canceled subscription -> sends without the billing line', async () => {
    fake.db.rows('org_billing_stripe')[0].status = 'canceled';
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()).toHaveLength(1);
    expect(sent()[0].billing).toEqual({ kind: 'none' });
  });

  it('J10 (D1): no subscription row -> sends without the billing line', async () => {
    fake.db.rows('org_billing_stripe').length = 0;
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()[0].billing).toEqual({ kind: 'none' });
  });

  it('J10b (D1): customer row with no subscription yet (NULL subscription id and status) -> sends without the billing line', async () => {
    Object.assign(fake.db.rows('org_billing_stripe')[0], { stripe_subscription_id: null, status: null });
    await handleNotifyOrgReinstatedRow(row(), ctx());
    expect(sent()).toHaveLength(1);
    expect(sent()[0].billing).toEqual({ kind: 'none' });
  });

  it('J11: converges: the same row run twice sends once', async () => {
    await handleNotifyOrgReinstatedRow(row(), ctx());
    await handleNotifyOrgReinstatedRow(row('staff', EPOCH, { attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('J12: no billing contact email -> nothing sent, no error', async () => {
    fake.db.rows('org_deals')[0].billing_contact_email = '  ';
    await expect(handleNotifyOrgReinstatedRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('J13: bad payloads are NonRetryable (no epoch, unknown via)', async () => {
    await expect(handleNotifyOrgReinstatedRow(row('staff', EPOCH, { payload: { organization_id: ORG, via: 'staff' } }), ctx())).rejects.toThrow('bad_payload');
    await expect(handleNotifyOrgReinstatedRow(row('staff', EPOCH, { payload: { organization_id: ORG, suspended_at_epoch: EPOCH, via: 'x' } }), ctx())).rejects.toThrow('bad_payload');
  });

  it('J14: email not configured -> NonRetryable; a failed send retries', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleNotifyOrgReinstatedRow(row(), ctx())).rejects.toThrow('email_not_configured');
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    await expect(handleNotifyOrgReinstatedRow(row(), ctx())).rejects.toThrow('email send failed');
  });
});
