/**
 * BACKLOG-3851 PR-2f: invite without a license and invite names — server side.
 *
 * C7  inviteUser: withoutLicense -> insert license_status 'unassigned'; default ->
 *     'pending'; names trimmed, empty -> null, > 100 characters refused.
 * C8  inviteUser: the guard's SHAPE refusal on an UNLICENSED insert (= database without
 *     M4) -> "not available yet", not reported; on a licensed insert it stays an error;
 *     the seat refusals are unchanged.
 * C14 release switch: NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED AND the Assign/Unassign
 *     switch; off -> an unlicensed invite is refused before any write.
 * C12 email: the "without a license" line iff withoutLicense, "Hi <first>," iff a first
 *     name; resend follows the row. Validator mapping: a missing 'licensed' is licensed.
 *
 * Database error objects as in license-actions-3851/inviteSeats.test.ts (transcribed from
 * keepr-test); the SHAPE refusal for an unlicensed insert was provoked on keepr-test before
 * M4 (planning probe P0, pm_comments 5f519ddb).
 *
 * @jest-environment node
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
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockCreateClient() }));
jest.mock('@/lib/email', () => ({ sendInviteEmail: (...a: unknown[]) => mockSendInviteEmail(...a) }));

type InviteFn = typeof import('@/lib/actions/inviteUser').inviteUser;
type ResendFn = typeof import('@/lib/actions/resendInvite').resendInvite;

/** Load the actions with the per-environment switch set (it is read at module load). */
function loadActions(switchValue: string | undefined): { inviteUser: InviteFn; resendInvite: ResendFn } {
  let mod!: { inviteUser: InviteFn; resendInvite: ResendFn };
  const prev = process.env.NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED;
  if (switchValue === undefined) delete process.env.NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED;
  else process.env.NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED = switchValue;
  jest.isolateModules(() => {
    mod = {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      inviteUser: require('@/lib/actions/inviteUser').inviteUser,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resendInvite: require('@/lib/actions/resendInvite').resendInvite,
    };
  });
  if (prev === undefined) delete process.env.NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED;
  else process.env.NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED = prev;
  return mod;
}

const CALLER = 'user-admin';
const ORG = 'org-1';
const INVITE = 'member-invite';
const SEAT_GUARD = { code: '42501', message: 'Organization has reached maximum seats', details: null, hint: null };
const SEAT_TRIGGER = { code: 'P0001', message: 'seat_limit_reached', details: 'organization_id=<the organization id>', hint: null };
const GUARD_SHAPE = { code: '42501', message: 'Only a pending invitation can be added from a client session', details: null, hint: null };
const UNAVAILABLE = 'Inviting without a license is not available yet.';

interface World {
  writeError?: unknown;
  /** The invite row resend reads. */
  inviteRow?: Record<string, unknown>;
}

function makeClient(world: World) {
  const writes: { table: string; op: string; payload: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: CALLER } } }) },
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      let op: 'select' | 'insert' | 'update' = 'select';
      const answer = () => {
        if (op !== 'select') return { data: null, error: world.writeError ?? null };
        if (table === 'licenses') return { data: { status: 'active' }, error: null };
        if (table === 'users') return { data: 'email' in eqs ? null : { email: 'admin@fixture.invalid', display_name: 'Admin' }, error: null };
        if (table === 'organizations') return { data: { name: 'Fixture Org', max_seats: 1 }, error: null };
        if (table === 'organization_members' && 'user_id' in eqs) return { data: { role: 'admin', license_status: 'active' }, error: null };
        if (table === 'organization_members' && 'id' in eqs) {
          return {
            data: world.inviteRow ?? { id: INVITE, invited_email: 'old@fixture.invalid', role: 'agent', organization_id: ORG, user_id: null },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        insert: (payload: Record<string, unknown>) => { op = 'insert'; writes.push({ table, op, payload }); return builder; },
        update: (payload: Record<string, unknown>) => { op = 'update'; writes.push({ table, op, payload }); return builder; },
        eq: (col: string, val: unknown) => { eqs[col] = val; return builder; },
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

const inserts = (w: ReturnType<typeof makeClient>['writes']) => w.filter((x) => x.op === 'insert');

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCaptureException.mockReset();
  mockSendInviteEmail.mockReset().mockResolvedValue({ success: true, outcome: 'sent' });
});

describe('C7: the invite insert payload', () => {
  const { inviteUser } = loadActions('true');

  it('withoutLicense -> license_status unassigned, names trimmed', async () => {
    const { writes } = given({});
    const res = await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, withoutLicense: true, firstName: '  Ann ', lastName: ' Lee' });
    expect(res).toEqual(expect.objectContaining({ success: true }));
    expect(inserts(writes)).toHaveLength(1);
    expect(inserts(writes)[0].payload).toEqual(expect.objectContaining({
      license_status: 'unassigned', invited_first_name: 'Ann', invited_last_name: 'Lee',
    }));
  });

  it('default -> license_status pending; empty names -> null', async () => {
    const { writes } = given({});
    await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, firstName: '   ', lastName: '' });
    expect(inserts(writes)[0].payload).toEqual(expect.objectContaining({
      license_status: 'pending', invited_first_name: null, invited_last_name: null,
    }));
  });

  it('a name over 100 characters is refused before any write', async () => {
    const { writes } = given({});
    const res = await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, firstName: 'x'.repeat(101) });
    expect(res).toEqual({ success: false, error: 'Names must be 100 characters or fewer' });
    expect(writes).toHaveLength(0);
  });

  it('the invite email carries withoutLicense and the first name', async () => {
    given({});
    await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, withoutLicense: true, firstName: 'Ann' });
    expect(mockSendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ withoutLicense: true, recipientFirstName: 'Ann' }));
  });
});

describe('C8: database refusals', () => {
  const { inviteUser } = loadActions('true');
  const invite = (withoutLicense: boolean) =>
    inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, ...(withoutLicense ? { withoutLicense: true } : {}) });

  it('unlicensed insert + the guard SHAPE refusal (no M4 yet) -> not available yet, not reported', async () => {
    given({ writeError: GUARD_SHAPE });
    expect(await invite(true)).toEqual({ success: false, error: UNAVAILABLE });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('licensed insert + the same refusal -> Failed to create invitation, reported', async () => {
    given({ writeError: GUARD_SHAPE });
    expect(await invite(false)).toEqual({ success: false, error: 'Failed to create invitation' });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('unlicensed insert + another 42501 (row-level security) -> Failed to create invitation', async () => {
    given({ writeError: { code: '42501', message: 'new row violates row-level security policy for table "organization_members"' } });
    expect(await invite(true)).toEqual({ success: false, error: 'Failed to create invitation' });
  });

  it.each([['seat guard', SEAT_GUARD], ['seat trigger', SEAT_TRIGGER]])('%s -> outOfSeats for a licensed invite, as before', async (_n, err) => {
    given({ writeError: err });
    expect(await invite(false)).toEqual({ success: false, outOfSeats: true });
  });
});

describe('C14: the per-environment switch (server action)', () => {
  it.each([[undefined], ['false'], ['1']])('NEXT_PUBLIC_INVITE_WITHOUT_LICENSE_ENABLED=%s -> unlicensed invite refused, nothing written', async (value) => {
    const { inviteUser } = loadActions(value);
    const { writes } = given({});
    const res = await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG, withoutLicense: true });
    expect(res).toEqual({ success: false, error: UNAVAILABLE });
    expect(writes).toHaveLength(0);
  });

  it('switch off: a licensed invite is unaffected', async () => {
    const { inviteUser } = loadActions(undefined);
    const { writes } = given({});
    await inviteUser({ email: 'new@fixture.invalid', role: 'agent', organizationId: ORG });
    expect(inserts(writes)[0].payload.license_status).toBe('pending');
  });

  it('inviteWithoutLicenseAvailable = env AND Assign/Unassign', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { inviteWithoutLicenseAvailable } = require('@/lib/users/memberLicenseActions');
    expect(inviteWithoutLicenseAvailable(true, true)).toBe(true);
    expect(inviteWithoutLicenseAvailable(true, false)).toBe(false);
    expect(inviteWithoutLicenseAvailable(false, true)).toBe(false);
  });
});

describe('C12: resend follows the row', () => {
  const { resendInvite } = loadActions('true');

  it('an unlicensed invitation is resent with the line and the first name', async () => {
    given({ inviteRow: { id: INVITE, invited_email: 'old@fixture.invalid', role: 'agent', organization_id: ORG, user_id: null, license_status: 'unassigned', invited_first_name: 'Bob' } });
    expect(await resendInvite({ memberId: INVITE, organizationId: ORG })).toEqual({ success: true });
    expect(mockSendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ withoutLicense: true, recipientFirstName: 'Bob' }));
  });

  it('a licensed invitation is resent without the line', async () => {
    given({ inviteRow: { id: INVITE, invited_email: 'old@fixture.invalid', role: 'agent', organization_id: ORG, user_id: null, license_status: 'pending', invited_first_name: null } });
    await resendInvite({ memberId: INVITE, organizationId: ORG });
    expect(mockSendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ withoutLicense: false, recipientFirstName: undefined }));
  });
});

describe('C12: invite email and validator mapping', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildInviteEmail } = require('@/lib/email/templates/invite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mapValidInvitation, UNLICENSED_INVITE_LINE } = require('@/lib/invite/validateResult');
  const RECIPIENT = 'a@fixture.invalid';
  const base = {
    recipientEmail: RECIPIENT,
    organizationName: 'Fixture Org',
    inviterName: 'Admin',
    role: 'agent',
    inviteLink: 'https://x.test/invite/t',
    expiresInDays: 7,
  };

  it('line iff withoutLicense; greeting iff a first name (html and text)', () => {
    const plain = buildInviteEmail(base);
    expect(plain.html).not.toContain(UNLICENSED_INVITE_LINE.replace("'", '&#039;'));
    expect(plain.text).not.toContain(UNLICENSED_INVITE_LINE);
    expect(plain.text).not.toMatch(/^Hi /m);

    const unl = buildInviteEmail({ ...base, withoutLicense: true, recipientFirstName: 'Ann' });
    expect(unl.html).toContain(UNLICENSED_INVITE_LINE.replace("'", '&#039;'));
    expect(unl.text).toContain(UNLICENSED_INVITE_LINE);
    expect(unl.html).toContain('Hi Ann,');
    expect(unl.text).toMatch(/^Hi Ann,$/m);
  });

  it("a validator answer without 'licensed' (database before M4) is licensed", () => {
    expect(mapValidInvitation({ valid: true, email: 'a@x', org_name: 'O', role: 'agent' })).toEqual(
      expect.objectContaining({ licensed: true, firstName: null, role: 'Agent' })
    );
    expect(mapValidInvitation({ valid: true, role: 'broker', licensed: false, first_name: ' Ann ' })).toEqual(
      expect.objectContaining({ licensed: false, firstName: 'Ann' })
    );
  });
});
