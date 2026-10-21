/**
 * @jest-environment node
 *
 * BACKLOG-3853 PR-2 — billing_outbox kind `notify_account_manager` (lib/billing/brokerageNotify.ts).
 *
 * Rows have the shape lib/billing/brokerage.ts enqueues (organization subject, payload
 * {organization_id, reason, stripe_object_id}). The account manager's sign-in email comes from
 * auth.admin.getUserById (mocked). The sender is mocked and logs like send-email.ts.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendAccountSuspendedEmail: jest.fn(),
  sendAccountManagerAlertEmail: (...a: unknown[]) => mockSend(...a),
}));

import { handleNotifyAccountManagerRow } from '@/lib/billing/brokerageNotify';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-3853-M';
const INVOICE = 'in_1URdzABg3cyTef3dyKhMzjZn'; // fixtures/stripe/p3853/inv-paid.json id
let fake: BrokerageFake;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-m1',
    stripe_mode: 'test',
    kind: 'notify_account_manager',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_account_manager:test:${ORG}:overdue:${INVOICE}`,
    run_after: '2026-10-19T00:00:00Z',
    payload: { organization_id: ORG, reason: 'overdue', stripe_object_id: INVOICE },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-19T00:00:00Z',
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3853 M', is_test: true }],
    org_deals: [dealRow(ORG)],
    email_delivery_log: [],
  });
  fake.service.auth.admin.getUserById.mockResolvedValue({ data: { user: { email: 'am-3853@example.test' } }, error: null });
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({
      email_type: 'other',
      status: 'sent',
      metadata: { kind: 'brokerage_account_manager_alert', outboxKey: p.outboxKey },
    });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_account_manager', () => {
  it('sends one alert to the account manager sign-in email with the reason and Stripe reference', async () => {
    await handleNotifyAccountManagerRow(row(), ctx());
    expect(fake.service.auth.admin.getUserById).toHaveBeenCalledWith('AM-3853');
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'am-3853@example.test',
      brokerageName: 'Brokerage 3853 M',
      reason: 'overdue',
      stripeObjectId: INVOICE,
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('convergence: the same row run twice sends once', async () => {
    await handleNotifyAccountManagerRow(row(), ctx());
    await handleNotifyAccountManagerRow(row({ attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('no account manager -> alert brokerage_no_account_manager, no email, no error', async () => {
    fake.db.rows('org_deals')[0].account_manager_id = null;
    await handleNotifyAccountManagerRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith('billing alert: brokerage_no_account_manager', expect.anything());
  });

  // BACKLOG-3854: the row broker_add_seats enqueues (migration 20261021020000 §3; keepr-test control
  // S5_two_notify_rows asserted this key and detail shape).
  it('seats_added (BACKLOG-3854) is an accepted reason: one alert with the detail line', async () => {
    const detail = 'Added by P3854 Admin (Admin): 8 to 10 seats. A prorated charge for the rest of this period appears on the next invoice.';
    await handleNotifyAccountManagerRow(
      row({
        dedupe_key: `notify_account_manager:test:${ORG}:seats_added:v2`,
        payload: { organization_id: ORG, reason: 'seats_added', detail },
      }),
      ctx()
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ reason: 'seats_added', detail, stripeObjectId: null });
  });

  it('an unknown reason -> NonRetryable bad_payload', async () => {
    await expect(handleNotifyAccountManagerRow(row({ payload: { organization_id: ORG, reason: 'nope' } }), ctx())).rejects.toMatchObject({
      code: 'bad_payload',
    });
  });
});
