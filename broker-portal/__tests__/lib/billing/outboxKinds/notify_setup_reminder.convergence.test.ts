/**
 * @jest-environment node
 *
 * BACKLOG-4007 PR-3 — billing_outbox kind `notify_setup_reminder` (lib/billing/setupReminder.ts).
 *
 * Row shape transcribed from _billing_enqueue_setup_reminders
 * (supabase/migrations/20261020100000_backlog_4007_onboarding_billing_setup.sql §12):
 *   dedupe_key 'notify_setup_reminder:<mode>:<org>:<member id>:<16 hex of md5(token)>:d<day>'
 *   payload {organization_id, member_id, invite_sent_at, day}, run_after = send + day days.
 * organization_members columns as the broker-portal invite insert writes them
 * (lib/actions/inviteUser.ts). Sign-in emails come from auth.admin.getUserById (mocked).
 */

import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendSetupReminderEmail: (...a: unknown[]) => mockSend(...a),
  sendAccountSuspendedEmail: jest.fn(),
  sendAccountManagerAlertEmail: jest.fn(),
}));

import { handleNotifySetupReminderRow } from '@/lib/billing/setupReminder';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG = 'ORG-4007-R';
const MEMBER = 'MEMBER-4007-INV';
const NOW = Date.parse('2026-10-23T18:00:00Z');
let fake: BrokerageFake;

function row(day: number, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `outbox-r${day}`,
    stripe_mode: 'test',
    kind: 'notify_setup_reminder',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_setup_reminder:test:${ORG}:${MEMBER}:0123456789abcdef:d${day}`,
    run_after: '2026-10-23T18:00:00Z',
    payload: { organization_id: ORG, member_id: MEMBER, invite_sent_at: '2026-10-20T18:00:00Z', day },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-20T18:00:00Z',
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: {} as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(NOW + 60_000) });

function invite(over: Obj = {}): Obj {
  return {
    id: MEMBER,
    organization_id: ORG,
    user_id: null,
    invited_email: 'broker-4007@example.test',
    role: 'admin',
    license_status: 'pending',
    invitation_token: 'tok-4007',
    invitation_expires_at: '2026-10-27T18:00:00Z',
    provisioned_by: 'invite',
    created_at: '2026-10-20T18:00:00Z',
    ...over,
  };
}
const amRows = () => fake.db.rows('billing_outbox').filter((r) => r.kind === 'notify_account_manager') as Obj[];
const sentTo = () => mockSend.mock.calls.map((c) => [c[0].variant, c[0].recipientEmail, c[0].url]);

function seed(members: Obj[], deal: Obj = { status: 'draft' }) {
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 4007 R', is_test: true }],
    org_deals: [dealRow(ORG, deal)],
    organization_members: members,
    billing_outbox: [],
    email_delivery_log: [],
  });
  fake.service.auth.admin.getUserById.mockImplementation(async (id: string) => ({
    data: { user: { email: `${id.toLowerCase()}@example.test` } },
    error: null,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  process.env.NEXT_PUBLIC_APP_URL = 'https://portal.example.test';
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: 'setup_reminder', outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
  seed([invite()]);
});
afterEach(() => jest.restoreAllMocks());

describe('notify_setup_reminder', () => {
  it('C-R1: the deal is no longer waiting -> no email and no account-manager row', async () => {
    seed([invite()], { status: 'active' });
    await handleNotifySetupReminderRow(row(7), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    expect(amRows()).toEqual([]);
  });

  it('C-R2: an unclaimed, unexpired invite -> "accept" email with its own link; day 3 has no account-manager row', async () => {
    await handleNotifySetupReminderRow(row(3), ctx());
    expect(sentTo()).toEqual([['accept', 'broker-4007@example.test', 'https://portal.example.test/invite/tok-4007']]);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ outboxKey: row(3).dedupe_key, brokerageName: 'Brokerage 4007 R', day: 3 });
    expect(amRows()).toEqual([]);
  });

  it('C-R3: a broker/admin with an account -> "finish" email to the sign-in email, the setup guide link', async () => {
    seed([invite({ user_id: 'ADMIN-1', license_status: 'active' })]);
    await handleNotifySetupReminderRow(row(3), ctx());
    expect(sentTo()).toEqual([['finish', 'admin-1@example.test', 'https://portal.example.test/dashboard/setup']]);
  });

  it('C-R4: the invite expired and nobody claimed -> no broker email, one account-manager row "setup_no_recipient"', async () => {
    seed([invite({ invitation_expires_at: '2026-10-23T17:59:59Z' })]);
    await handleNotifySetupReminderRow(row(3), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    expect(amRows().map((r) => r.payload.reason)).toEqual(['setup_no_recipient']);
  });

  it('C-R5: day 7 -> reminder AND account-manager "setup_not_completed"; the same row again sends nothing new', async () => {
    seed([invite({ user_id: 'ADMIN-1', license_status: 'active' })]);
    await handleNotifySetupReminderRow(row(7), ctx());
    await handleNotifySetupReminderRow(row(7, { attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(amRows().map((r) => [r.payload.reason, r.dedupe_key])).toEqual([['setup_not_completed', `${row(7).dedupe_key}:am`]]);
  });

  it('C-R6: two invites (two rows) on the same day -> one "finish" email per brokerage per day', async () => {
    seed([invite({ user_id: 'ADMIN-1', license_status: 'active' }), invite({ id: 'MEMBER-2', invited_email: 'b2@example.test' })]);
    await handleNotifySetupReminderRow(row(3), ctx());
    await handleNotifySetupReminderRow(
      row(3, { id: 'outbox-r3b', dedupe_key: `notify_setup_reminder:test:${ORG}:MEMBER-2:fedcba9876543210:d3`, payload: { organization_id: ORG, member_id: 'MEMBER-2', day: 3 } }),
      ctx()
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('C-R7: an agent or an unlicensed admin with an account is not who finishes setup', async () => {
    seed([
      { ...invite({ id: 'AGENT', user_id: 'AGENT-1', role: 'agent', license_status: 'active', invitation_token: null }) },
      { ...invite({ id: 'UNLIC', user_id: 'ADMIN-U', role: 'admin', license_status: 'unassigned', invitation_token: null }) },
      invite(),
    ]);
    await handleNotifySetupReminderRow(row(3), ctx());
    expect(sentTo()).toEqual([['accept', 'broker-4007@example.test', 'https://portal.example.test/invite/tok-4007']]);
  });

  it('bad payload -> NonRetryable', async () => {
    await expect(handleNotifySetupReminderRow(row(3, { payload: { organization_id: ORG } }), ctx())).rejects.toMatchObject({ code: 'bad_payload' });
  });
});
