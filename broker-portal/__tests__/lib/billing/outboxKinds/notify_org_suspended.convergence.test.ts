/**
 * @jest-environment node
 *
 * BACKLOG-3853 PR-2 — billing_outbox kind `notify_org_suspended` (lib/billing/brokerageNotify.ts).
 *
 * Rows have the shape the org_deals trigger writes (20261019090000: dedupe key
 * notify_org_suspended:<mode>:<org>:<epoch>, payload {organization_id, suspended_at_epoch},
 * organization subject, no user). The sender is mocked; it logs to email_delivery_log the way
 * send-email.ts does (email_type 'other', metadata = logMetadata). No Stripe call, no network.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendAccountSuspendedEmail: (...a: unknown[]) => mockSend(...a),
  sendAccountManagerAlertEmail: jest.fn(),
}));

import { handleNotifyOrgSuspendedRow } from '@/lib/billing/brokerageNotify';
import { NonRetryableOutboxError, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-3853-N';
const SUSPENDED_AT = '2026-10-19T12:00:00.000Z';
const EPOCH = Date.parse(SUSPENDED_AT) / 1000;
let fake: BrokerageFake;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-n1',
    stripe_mode: 'test',
    kind: 'notify_org_suspended',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_org_suspended:test:${ORG}:${EPOCH}`,
    run_after: SUSPENDED_AT,
    payload: { organization_id: ORG, suspended_at_epoch: EPOCH },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: SUSPENDED_AT,
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });
const deal = () => fake.db.rows('org_deals')[0];

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3853 N', is_test: true }],
    org_deals: [dealRow(ORG, { status: 'suspended', suspended_reason: 'non_payment', suspended_at: SUSPENDED_AT })],
    email_delivery_log: [],
  });
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({
      email_type: 'other',
      recipient_email: p.recipientEmail,
      status: 'sent',
      metadata: { kind: 'account_suspended', outboxKey: p.outboxKey, organizationId: p.organizationId, reason: p.reason },
    });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_org_suspended', () => {
  it('sends one email to the billing contact, reason-aware', async () => {
    await handleNotifyOrgSuspendedRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'billing-3853@example.test',
      brokerageName: 'Brokerage 3853 N',
      reason: 'non_payment',
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('convergence: the same row run twice sends once', async () => {
    await handleNotifyOrgSuspendedRow(row(), ctx());
    await handleNotifyOrgSuspendedRow(row({ attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C-N: reinstated before the row ran -> no email (no reinstated email either, B4)', async () => {
    Object.assign(deal(), { status: 'active', suspended_reason: null, suspended_at: null });
    await handleNotifyOrgSuspendedRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C-N2: suspended again later -> the old row sends nothing (the new suspension has its own row)', async () => {
    deal().suspended_at = '2026-10-20T08:00:00.000Z';
    await handleNotifyOrgSuspendedRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('"other" suspension -> reason other', async () => {
    deal().suspended_reason = 'other';
    await handleNotifyOrgSuspendedRow(row(), ctx());
    expect(mockSend.mock.calls[0][0].reason).toBe('other');
  });

  it('no billing contact -> NonRetryable no_recipient (parked + outbox alert)', async () => {
    deal().billing_contact_email = null;
    await expect(handleNotifyOrgSuspendedRow(row(), ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('email service not configured -> NonRetryable; a failed send -> retryable', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleNotifyOrgSuspendedRow(row(), ctx())).rejects.toMatchObject({ code: 'email_not_configured' });
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    await expect(handleNotifyOrgSuspendedRow(row(), ctx())).rejects.not.toBeInstanceOf(NonRetryableOutboxError);
  });
});
