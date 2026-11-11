/**
 * @jest-environment node
 *
 * BACKLOG-4045 — billing_outbox kind `notify_auto_renew_on` (lib/billing/autoRenewOnNotify.ts):
 * the billing contact gets a short email when Keepr staff turn the brokerage's auto-renew back on.
 *
 * Row shapes transcribed from _billing_set_auto_renew
 * (supabase/migrations/20261107140000_backlog_4045_auto_renew_on_notify.sql) and the keepr-test
 * control C1_staff_on_one_row (supabase/tests/backlog-4045):
 *   outbox dedupe_key 'notify_auto_renew_on:<mode>:<org>:v<version>', payload {organization_id, version}
 *   billing_change_log (20261020220000:471-474): {organization_id, actor_id, action
 *     'auto_renew_on'|'auto_renew_off', detail {note, ends_on, version, by}}.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendAutoRenewOnEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleNotifyAutoRenewOnRow } from '@/lib/billing/autoRenewOnNotify';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-4045-AR';
const STAFF = 'USER-4045-STAFF';
let fake: BrokerageFake;

function row(version = 3, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `outbox-ar-v${version}`,
    stripe_mode: 'test',
    kind: 'notify_auto_renew_on',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_auto_renew_on:test:${ORG}:v${version}`,
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
    detail: { note: 'p4045 note', ends_on: action === 'auto_renew_off' ? '2026-11-27T00:00:00Z' : null, version, by },
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 4045 AR', is_test: true }],
    org_deals: [dealRow(ORG, { version: 3, status: 'active' })],
    // staff off at v2, staff on at v3
    billing_change_log: [changeLog('auto_renew_off', 2), changeLog('auto_renew_on', 3)],
    email_delivery_log: [],
  });
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'auto_renew_on', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_auto_renew_on', () => {
  it('C8a: one email to the deal billing contact', async () => {
    await handleNotifyAutoRenewOnRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'billing-3853@example.test',
      brokerageName: 'Brokerage 4045 AR',
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('C8b: the deal is canceling again at run time -> nothing sent', async () => {
    fake.db.rows('org_deals')[0].status = 'canceling';
    await expect(handleNotifyAutoRenewOnRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C8c: superseded (off then on again before the drain) -> only the latest row sends', async () => {
    fake.db.rows('billing_change_log').push(changeLog('auto_renew_off', 4), changeLog('auto_renew_on', 5));
    fake.db.rows('org_deals')[0].version = 5;
    await handleNotifyAutoRenewOnRow(row(3), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    await handleNotifyAutoRenewOnRow(row(5), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].outboxKey).toBe(row(5).dedupe_key);
  });

  it('C8d: a deal-version bump by another writer (seats) does not suppress the email', async () => {
    fake.db.rows('org_deals')[0].version = 4;
    await handleNotifyAutoRenewOnRow(row(3), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C8e: no auto-renew change in the log -> nothing sent', async () => {
    fake.db.rows('billing_change_log').length = 0;
    await handleNotifyAutoRenewOnRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C8f: converges: the same row run twice sends once', async () => {
    await handleNotifyAutoRenewOnRow(row(), ctx());
    await handleNotifyAutoRenewOnRow(row(3, { attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C8g: no billing contact email -> nothing sent, no error', async () => {
    fake.db.rows('org_deals')[0].billing_contact_email = null;
    await expect(handleNotifyAutoRenewOnRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C8h: a payload without the version is NonRetryable', async () => {
    await expect(handleNotifyAutoRenewOnRow(row(3, { payload: { organization_id: ORG } }), ctx())).rejects.toThrow('bad_payload');
  });

  it('C8i: email not configured -> NonRetryable; a failed send retries', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleNotifyAutoRenewOnRow(row(), ctx())).rejects.toThrow('email_not_configured');
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    await expect(handleNotifyAutoRenewOnRow(row(), ctx())).rejects.toThrow('email send failed');
  });
});
