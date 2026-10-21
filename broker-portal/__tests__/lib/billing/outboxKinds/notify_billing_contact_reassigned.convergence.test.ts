/**
 * @jest-environment node
 *
 * BACKLOG-4007 People v2 — billing_outbox kind `notify_billing_contact_reassigned`
 * (lib/billing/billingContactReassigned.ts), founder R9 refinement.
 *
 * Row shape transcribed from _org_billing_contact_reassign
 * (supabase/migrations/20261020200000_backlog_4007_people_v2.sql §8) and the keepr-test control
 * R9_deprovision_queues_email (supabase/tests/backlog-4007-people-v2):
 *   dedupe_key 'notify_billing_contact_reassigned:<mode>:<org>:<contact id>'
 *   payload {organization_id, member_id, contact_id, reason: 'idp_deprovisioned'}.
 * org_contacts after People v2: {organization_id, role, member_id, removed_at}.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendBillingContactReassignedEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleNotifyBillingContactReassignedRow } from '@/lib/billing/billingContactReassigned';
import { billingContactReassignedLines } from '@/lib/email/templates/billing-contact-reassigned';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-4007-BC';
const ADMIN_MEMBER = 'MEMBER-4007-ADMIN';
const ADMIN_USER = 'USER-4007-ADMIN';
const CONTACT = 'CONTACT-4007-NEW';
let fake: BrokerageFake;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-bc1',
    stripe_mode: 'test',
    kind: 'notify_billing_contact_reassigned',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_billing_contact_reassigned:test:${ORG}:${CONTACT}`,
    run_after: '2026-10-20T18:00:00Z',
    payload: { organization_id: ORG, member_id: ADMIN_MEMBER, contact_id: CONTACT, reason: 'idp_deprovisioned' },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-20T18:00:00Z',
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

function seed(contacts: Obj[]) {
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 4007 BC', is_test: true }],
    org_deals: [dealRow(ORG, { status: 'active' })],
    organization_members: [
      { id: ADMIN_MEMBER, organization_id: ORG, user_id: ADMIN_USER, role: 'admin', license_status: 'active' },
    ],
    org_contacts: contacts,
    billing_outbox: [],
    email_delivery_log: [],
  });
  fake.service.auth.admin.getUserById.mockImplementation(async () => ({
    data: { user: { email: 'admin-4007@example.test' } },
    error: null,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'https://portal.example.test';
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'billing_contact_reassigned', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
  seed([{ id: CONTACT, organization_id: ORG, role: 'billing', member_id: ADMIN_MEMBER, removed_at: null }]);
});

describe('notify_billing_contact_reassigned', () => {
  it('C-BC1: the account admin is the live billing contact -> one email to their sign-in email, People link', async () => {
    await handleNotifyBillingContactReassignedRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      recipientEmail: 'admin-4007@example.test',
      brokerageName: 'Brokerage 4007 BC',
      url: 'https://portal.example.test/dashboard/settings',
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('C-BC2: converges: a second run after the send sends nothing', async () => {
    await handleNotifyBillingContactReassignedRow(row(), ctx());
    await handleNotifyBillingContactReassignedRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C-BC3: the billing contact changed since -> nothing', async () => {
    seed([
      { id: CONTACT, organization_id: ORG, role: 'billing', member_id: ADMIN_MEMBER, removed_at: '2026-10-20T19:00:00Z' },
      { id: 'CONTACT-LATER', organization_id: ORG, role: 'billing', member_id: 'MEMBER-OTHER', removed_at: null },
    ]);
    await handleNotifyBillingContactReassignedRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C-BC4: a payload without the member is NonRetryable', async () => {
    await expect(handleNotifyBillingContactReassignedRow(row({ payload: { organization_id: ORG } }), ctx())).rejects.toThrow('bad_payload');
  });

  it('the email is at most three sentences and says what to do', () => {
    const lines = billingContactReassignedLines('Brokerage 4007 BC');
    expect(lines).toHaveLength(3);
    expect(lines.join(' ')).toMatch(/billing contact for Brokerage 4007 BC/);
    expect(lines.join(' ')).toMatch(/Invoices/);
    expect(lines.join(' ')).toMatch(/change the billing contact in People/);
  });
});
