/**
 * @jest-environment node
 *
 * BACKLOG-3854 — billing_outbox kind `notify_seats_added` (lib/billing/seatsAddedNotify.ts),
 * founder d0c22cef #2: the billing contact gets a short email when a Broker or Admin adds seats.
 *
 * Row shape transcribed from broker_add_seats (supabase/migrations/20261021020000_backlog_3854_seats.sql
 * §3) and the keepr-test control S5_two_notify_rows (supabase/tests/backlog-3854):
 *   dedupe_key 'notify_seats_added:<mode>:<org>:v<version>'
 *   payload {organization_id, seats_from, seats_to, version, trialing, added_by}.
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendSeatsAddedEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleNotifySeatsAddedRow } from '@/lib/billing/seatsAddedNotify';
import { seatsAddedLines } from '@/lib/email/templates/seats-added';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-3854-SA';
let fake: BrokerageFake;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-sa1',
    stripe_mode: 'test',
    kind: 'notify_seats_added',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_seats_added:test:${ORG}:v2`,
    run_after: '2026-10-21T00:00:00Z',
    payload: { organization_id: ORG, seats_from: 8, seats_to: 10, version: 2, trialing: false, added_by: 'P3854 Admin' },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-21T00:00:00Z',
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

beforeEach(() => {
  jest.clearAllMocks();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3854 SA', is_test: true }],
    org_deals: [dealRow(ORG, { version: 2, seats: 10 })],
    email_delivery_log: [],
  });
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'seats_added', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
});

describe('notify_seats_added', () => {
  it('C-SA1: one email to the deal billing contact with the counts and who added them', async () => {
    await handleNotifySeatsAddedRow(row(), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toEqual({
      recipientEmail: 'billing-3853@example.test',
      brokerageName: 'Brokerage 3854 SA',
      seatsFrom: 8,
      seatsTo: 10,
      trialing: false,
      addedBy: 'P3854 Admin',
      outboxKey: row().dedupe_key,
      organizationId: ORG,
    });
  });

  it('C-SA2: converges: the same row run twice sends once', async () => {
    await handleNotifySeatsAddedRow(row(), ctx());
    await handleNotifySeatsAddedRow(row({ attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C-SA3: two adds (two versions) -> two emails', async () => {
    await handleNotifySeatsAddedRow(row(), ctx());
    await handleNotifySeatsAddedRow(row({ id: 'outbox-sa2', dedupe_key: `notify_seats_added:test:${ORG}:v3` }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('C-SA4: no billing contact email -> nothing sent, no error', async () => {
    fake.db.rows('org_deals')[0].billing_contact_email = null;
    await expect(handleNotifySeatsAddedRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C-SA5: a payload without the counts is NonRetryable', async () => {
    await expect(handleNotifySeatsAddedRow(row({ payload: { organization_id: ORG } }), ctx())).rejects.toThrow('bad_payload');
  });

  it('C-SA6: three sentences; prorated outside a trial, no charge promised during one', () => {
    const base = { brokerageName: 'Brokerage 3854 SA', seatsFrom: 8, seatsTo: 10, addedBy: 'P3854 Admin' };
    const paid = seatsAddedLines({ ...base, trialing: false });
    const trial = seatsAddedLines({ ...base, trialing: true });
    expect(paid).toHaveLength(3);
    expect(trial).toHaveLength(3);
    expect(paid.join(' ')).toMatch(/8 to 10/);
    expect(paid.join(' ')).toMatch(/prorated charge/);
    expect(trial.join(' ')).not.toMatch(/charge/);
    expect(trial.join(' ')).toMatch(/end of your trial/);
  });
});
