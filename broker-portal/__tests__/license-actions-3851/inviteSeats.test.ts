/**
 * BACKLOG-3851 PR-2b: the out-of-licenses outcome on invite and resend.
 *
 * Error objects transcribed from the database, provoked once each on the test
 * project as an authenticated admin inside a rolled-back block (2026-10-16):
 *   invite insert, organization full    -> code 42501, message 'Organization has reached maximum seats'
 *   invite insert, malformed row        -> code 42501, message 'Only a pending invitation can be added from a client session'
 *   resend (renew an expired invite) in a full organization
 *                                        -> code P0001, message 'seat_limit_reached', details 'organization_id=<uuid>'
 * The seat trigger's P0001 on an invite INSERT (a race loser) is the same
 * RAISE as the resend one. The row-level-security shape is Postgres's own text.
 * PostgREST forwards SQLSTATE as `code` and the message unchanged.
 *
 * C3  invite: both seat refusals -> outOfSeats, not reported; every other 42501
 *     and any other error -> 'Failed to create invitation' + Sentry.
 * C4  invite: no portal seat count — an organization "full" only of expired
 *     invites reaches the insert; the database decides.
 * C12 resend: P0001 seat_limit_reached -> outOfSeats, not reported.
 */

const mockBlock = jest.fn();
const mockCreateClient = jest.fn();
const mockCaptureException = jest.fn();
const mockSendInviteEmail = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  blockWriteDuringImpersonation: () => mockBlock(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock('@/lib/email', () => ({
  sendInviteEmail: (...a: unknown[]) => mockSendInviteEmail(...a),
}));

import { inviteUser } from '@/lib/actions/inviteUser';
import { resendInvite } from '@/lib/actions/resendInvite';

const CALLER = 'user-admin';
const ORG = 'org-1';
const INVITE = 'member-invite';

const SEAT_GUARD = {
  code: '42501',
  message: 'Organization has reached maximum seats',
  details: null,
  hint: null,
};
const SEAT_TRIGGER = {
  code: 'P0001',
  message: 'seat_limit_reached',
  details: 'organization_id=<the organization id>',
  hint: null,
};
const GUARD_SHAPE = {
  code: '42501',
  message: 'Only a pending invitation can be added from a client session',
  details: null,
  hint: null,
};
const RLS = {
  code: '42501',
  message: 'new row violates row-level security policy for table "organization_members"',
  details: null,
  hint: null,
};

interface World {
  writeError?: unknown;
}

function makeClient(world: World) {
  const writes: { table: string; op: string; payload: unknown }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: CALLER } } }) },
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      let op: 'select' | 'insert' | 'update' = 'select';
      let countQuery = false;
      const answer = () => {
        if (op !== 'select') return { data: null, error: world.writeError ?? null };
        if (countQuery) return { data: null, count: 1, error: null };
        if (table === 'licenses') return { data: { status: 'active' }, error: null };
        if (table === 'users') return { data: 'email' in eqs ? null : { email: 'admin@fixture.invalid', display_name: 'Admin' }, error: null };
        if (table === 'organizations') return { data: { name: 'Fixture Org', max_seats: 1 }, error: null };
        if (table === 'organization_members' && 'user_id' in eqs) {
          return { data: { role: 'admin', license_status: 'active' }, error: null };
        }
        if (table === 'organization_members' && 'id' in eqs) {
          return { data: { id: INVITE, invited_email: 'old@fixture.invalid', role: 'agent', organization_id: ORG, user_id: null }, error: null };
        }
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: (_cols: string, opts?: { count?: string }) => {
          if (opts?.count) countQuery = true;
          return builder;
        },
        insert: (payload: unknown) => {
          op = 'insert';
          writes.push({ table, op, payload });
          return builder;
        },
        update: (payload: unknown) => {
          op = 'update';
          writes.push({ table, op, payload });
          return builder;
        },
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return builder;
        },
        in: () => builder,
        single: async () => answer(),
        maybeSingle: async () => answer(),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad),
      };
      return builder;
    },
  };
  return { client, writes };
}

function given(world: World) {
  const c = makeClient(world);
  mockCreateClient.mockResolvedValue(c.client);
  return c;
}

const invite = () => inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG });
const resend = () => resendInvite({ memberId: INVITE, organizationId: ORG });

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCaptureException.mockReset();
  mockSendInviteEmail.mockReset().mockResolvedValue({ success: true, outcome: 'sent' });
});

describe('C3: invite, the database refuses', () => {
  it.each([
    ['insert guard 42501 seat message', SEAT_GUARD],
    ['seat trigger P0001 (race loser)', SEAT_TRIGGER],
  ])('%s -> outOfSeats, not reported', async (_name, err) => {
    given({ writeError: err });
    expect(await invite()).toEqual({ success: false, outOfSeats: true });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['42501 malformed-row guard', GUARD_SHAPE],
    ['42501 row-level security', RLS],
    ['P0001 with another message', { ...SEAT_TRIGGER, message: 'something else' }],
    ['transport error', { code: '', message: 'fetch failed', details: null, hint: null }],
  ])('%s -> Failed to create invitation, reported', async (_name, err) => {
    given({ writeError: err });
    expect(await invite()).toEqual({ success: false, error: 'Failed to create invitation' });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe('C4: invite, no portal seat count', () => {
  it('an organization whose one held "seat" is an expired invite reaches the insert', async () => {
    // organizations reads max_seats 1 and any count query answers 1: a portal
    // pre-count would refuse here. The database counts an expired, unclaimed
    // invite as holding no seat, so the insert must be attempted.
    const { writes } = given({});
    const res = await invite();
    expect(res).toEqual(expect.objectContaining({ success: true }));
    expect(writes.filter((w) => w.op === 'insert')).toHaveLength(1);
  });
});

describe('C12: resend', () => {
  it('P0001 seat_limit_reached -> outOfSeats, not reported, no email', async () => {
    given({ writeError: SEAT_TRIGGER });
    expect(await resend()).toEqual({ success: false, outOfSeats: true });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('42501 (any message) is NOT the prompt on resend -> generic error, reported', async () => {
    given({ writeError: SEAT_GUARD });
    expect(await resend()).toEqual({ success: false, error: 'Failed to regenerate invitation' });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('success still resends', async () => {
    given({});
    expect(await resend()).toEqual({ success: true });
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
  });
});
