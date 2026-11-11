/**
 * @jest-environment node
 *
 * BACKLOG-4200 — billing_outbox kind `notify_auto_renew_off` (lib/billing/autoRenewOffNotify.ts):
 * the billing contact gets a short email when Keepr staff turn the brokerage's auto-renew off.
 *
 * Row shapes transcribed from _billing_set_auto_renew
 * (supabase/migrations/20261108170000_backlog_4200_auto_renew_off_notify.sql) and the keepr-test
 * control F1_staff_off_one_row (supabase/tests/backlog-4200-4209):
 *   outbox dedupe_key 'notify_auto_renew_off:<mode>:<org>:v<version>', payload {organization_id, version}
 *   billing_change_log: {organization_id, actor_id, action 'auto_renew_on'|'auto_renew_off',
 *     detail {note, ends_on, version, by, notified (staff rows)}}.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendAutoRenewOffEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleNotifyAutoRenewOffRow } from '@/lib/billing/autoRenewOffNotify';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-4200-AR';
const STAFF = 'USER-4200-STAFF';
const FUTURE = '2099-11-27T20:00:00+00:00';
let fake: BrokerageFake;

function row(version = 3, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `outbox-off-v${version}`,
    stripe_mode: 'test',
    kind: 'notify_auto_renew_off',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_auto_renew_off:test:${ORG}:v${version}`,
    run_after: '2026-11-07T00:00:00Z',
    payload: { organization_id: ORG, version },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-11-07T00:00:00Z',
    processed_at: null,
    ...over,
  };
}
function changeLog(action: 'auto_renew_on' | 'auto_renew_off', version: number, by = 'staff'): Obj {
  return {
    organization_id: ORG,
    actor_id: STAFF,
    action,
    detail: { note: 'p4200 note', ends_on: action === 'auto_renew_off' ? FUTURE : null, version, by, notified: true },
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 4200 AR', is_test: true }],
    org_deals: [dealRow(ORG, { version: 3, status: 'canceling' })],
    org_billing_stripe: [{ organization_id: ORG, stripe_mode: 'test', status: 'active', current_period_end: FUTURE, cancel_at_period_end: true }],
    // staff on at v2, staff off at v3
    billing_change_log: [changeLog('auto_renew_on', 2), changeLog('auto_renew_off', 3)],
    email_delivery_log: [],
  });
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'auto_renew_off', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_auto_renew_off', () => {
  it('H1: one email to the deal billing contact, with the period end', async () => {
    await handleNotifyAutoRenewOffRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'billing-3853@example.test',
      brokerageName: 'Brokerage 4200 AR',
      endsOn: 'Nov 27, 2099',
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('H2: the deal is active again at run time -> nothing sent', async () => {
    fake.db.rows('org_deals')[0].status = 'active';
    await expect(handleNotifyAutoRenewOffRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('H3: superseded (off, on, off again before the drain) -> only the latest row sends', async () => {
    fake.db.rows('billing_change_log').push(changeLog('auto_renew_on', 4), changeLog('auto_renew_off', 5));
    fake.db.rows('org_deals')[0].version = 5;
    await handleNotifyAutoRenewOffRow(row(3), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    await handleNotifyAutoRenewOffRow(row(5), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].outboxKey).toBe(row(5).dedupe_key);
  });

  it('H4: a deal-version bump by another writer (seats) does not suppress the email', async () => {
    fake.db.rows('org_deals')[0].version = 4;
    await handleNotifyAutoRenewOffRow(row(3), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('H5: converges: the same row run twice sends once', async () => {
    await handleNotifyAutoRenewOffRow(row(), ctx());
    await handleNotifyAutoRenewOffRow(row(3, { attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('H6: no billing contact email -> nothing sent, no error', async () => {
    fake.db.rows('org_deals')[0].billing_contact_email = null;
    await expect(handleNotifyAutoRenewOffRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('H7: no current_period_end -> endsOn null (fallback wording)', async () => {
    fake.db.rows('org_billing_stripe')[0].current_period_end = null;
    await handleNotifyAutoRenewOffRow(row(), ctx());
    expect(mockSend.mock.calls[0][0].endsOn).toBeNull();
  });

  it('H8 (SR C3): current_period_end already past -> endsOn null, never a past date', async () => {
    fake.db.rows('org_billing_stripe')[0].current_period_end = '2020-01-15T00:00:00+00:00';
    await handleNotifyAutoRenewOffRow(row(), ctx());
    expect(mockSend.mock.calls[0][0].endsOn).toBeNull();
  });

  it('H9: a payload without the version is NonRetryable', async () => {
    await expect(handleNotifyAutoRenewOffRow(row(3, { payload: { organization_id: ORG } }), ctx())).rejects.toThrow('bad_payload');
  });

  it('H10: email not configured -> NonRetryable; a failed send retries', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleNotifyAutoRenewOffRow(row(), ctx())).rejects.toThrow('email_not_configured');
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    await expect(handleNotifyAutoRenewOffRow(row(), ctx())).rejects.toThrow('email send failed');
  });
});
