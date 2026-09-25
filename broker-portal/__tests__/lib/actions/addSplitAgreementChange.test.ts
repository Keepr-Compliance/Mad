/**
 * addSplitAgreementChange — BACKLOG-3504.
 *
 * Only the Supabase client and the impersonation guard are mocked, matching
 * org-settings-actions-gate.test.ts's convention: the action's own
 * authorization logic runs for real against a stubbed client, rather than
 * being re-implemented inline in the test (updateUserRole.test.ts's older,
 * weaker convention — a copy here could drift from the code it stands in for).
 */

const mockCreateClient = jest.fn();
const mockBlockWrite = jest.fn(async () => null as { error: string } | null);

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  blockWriteDuringImpersonation: () => mockBlockWrite(),
}));

import { addSplitAgreementChange } from '@/lib/actions/addSplitAgreementChange';

const CALLER_ID = 'caller-1';
const TARGET_MEMBER_ID = 'member-1';
const TARGET_USER_ID = 'target-user-1';
const ORG_ID = 'org-1';

interface TargetMember {
  id: string;
  user_id: string | null;
  role: string;
  organization_id: string;
}

/** A client whose organization_members query returns TARGET on the first
 *  `.eq('id', ...)` call and CALLER on the first `.eq('user_id', ...)` call —
 *  the two distinct reads the action makes against the same table, in the
 *  same order updateUserRole.ts's sibling action makes them. `.insert()`
 *  records what it was called with, so the exact column set is assertable. */
function makeClient(opts: {
  user?: { id: string } | null;
  target?: TargetMember | null;
  callerMembership?: { role: string } | null;
  insertError?: { message: string } | null;
}) {
  const insertCalls: unknown[] = [];
  const from = jest.fn((table: string) => {
    if (table === 'organization_members') {
      const query: Record<string, unknown> = {};
      let mode: 'target' | 'caller' | null = null;
      query.select = jest.fn(() => query);
      query.eq = jest.fn((key: string) => {
        if (key === 'id') mode = 'target';
        if (key === 'user_id') mode = 'caller';
        return query;
      });
      query.single = jest.fn(async () => {
        if (mode === 'target') return { data: opts.target ?? null, error: null };
        if (mode === 'caller') return { data: opts.callerMembership ?? null, error: null };
        return { data: null, error: null };
      });
      return query;
    }
    if (table === 'agent_split_agreements') {
      return {
        insert: jest.fn(async (payload: unknown) => {
          insertCalls.push(payload);
          return { error: opts.insertError ?? null };
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });

  return {
    client: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: opts.user === undefined ? { id: CALLER_ID } : opts.user },
        })),
      },
      from,
    },
    insertCalls,
  };
}

const AGENT_TARGET: TargetMember = {
  id: TARGET_MEMBER_ID,
  user_id: TARGET_USER_ID,
  role: 'agent',
  organization_id: ORG_ID,
};

beforeEach(() => {
  mockCreateClient.mockReset();
  mockBlockWrite.mockReset();
  mockBlockWrite.mockResolvedValue(null);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const VALID_INPUT = { memberId: TARGET_MEMBER_ID, agentPct: 65, effectiveFrom: '2026-01-01' };

// ============================================================================
// Impersonation
// ============================================================================

it('refuses during impersonation without touching Supabase at all', async () => {
  mockBlockWrite.mockResolvedValue({ error: 'Write operations are not allowed during impersonation sessions' });
  const result = await addSplitAgreementChange(VALID_INPUT);
  expect(result).toEqual({ success: false, error: 'Write operations are not allowed during impersonation sessions' });
  expect(mockCreateClient).not.toHaveBeenCalled();
});

// ============================================================================
// Authentication / authorization
// ============================================================================

describe('authentication and authorization', () => {
  it('refuses when there is no session', async () => {
    const { client } = makeClient({ user: null, target: AGENT_TARGET, callerMembership: { role: 'admin' } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Not authenticated' });
  });

  it('refuses when the target member does not exist', async () => {
    const { client } = makeClient({ target: null });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Member not found' });
  });

  it('refuses a pending invite (no user_id yet)', async () => {
    const { client } = makeClient({ target: { ...AGENT_TARGET, user_id: null } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Cannot set a split for a pending invitation' });
  });

  it.each(['admin', 'it_admin'])('refuses a %s SUBJECT — splits apply to agent/broker only', async (role) => {
    const { client } = makeClient({ target: { ...AGENT_TARGET, role } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Splits apply to agent and broker roles only' });
  });

  it('refuses when the caller has no membership in the org at all', async () => {
    const { client } = makeClient({ target: AGENT_TARGET, callerMembership: null });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Not authorized' });
  });

  it.each(['admin', 'broker'])('allows a %s CALLER to write', async (role) => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: { role } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: true });
    expect(insertCalls).toHaveLength(1);
  });

  it('CONTROL: an agent CALLER is refused — proves the previous two cases are not vacuously true', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: { role: 'agent' } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Not authorized to set commission splits' });
    expect(insertCalls).toHaveLength(0);
  });

  it('it_admin CALLER is refused — the founder ruling this whole item turns on: broker/admin may write, it_admin may not', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: { role: 'it_admin' } });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Not authorized to set commission splits' });
    expect(insertCalls).toHaveLength(0);
  });
});

// ============================================================================
// Validation and derivation
// ============================================================================

describe('validation', () => {
  const ADMIN = { role: 'admin' };

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an out-of-range agentPct: %s',
    async (agentPct) => {
      const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: ADMIN });
      mockCreateClient.mockResolvedValue(client);
      const result = await addSplitAgreementChange({ ...VALID_INPUT, agentPct });
      expect(result.success).toBe(false);
      expect(insertCalls).toHaveLength(0);
    }
  );

  it('rejects a missing/invalid effective date', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: ADMIN });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange({ ...VALID_INPUT, effectiveFrom: 'not-a-date' });
    expect(result).toEqual({ success: false, error: 'Enter a valid effective date' });
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects a note over 2000 characters', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: ADMIN });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange({ ...VALID_INPUT, note: 'x'.repeat(2001) });
    expect(result).toEqual({ success: false, error: 'Note must be 2000 characters or fewer' });
    expect(insertCalls).toHaveLength(0);
  });

  it('derives brokerage_pct as 100 - agentPct server-side, never trusting a client-sent value', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: ADMIN });
    mockCreateClient.mockResolvedValue(client);
    // Note: the input type has no brokeragePct field at all — this proves the
    // server derives it, since there is nowhere for a caller to smuggle one in.
    await addSplitAgreementChange({ ...VALID_INPUT, agentPct: 62 });
    expect(insertCalls[0]).toMatchObject({ agent_pct: 62, brokerage_pct: 38 });
  });

  it('blank/whitespace-only note becomes null, matching the DB\'s own CHECK (note IS NULL OR length 1-2000)', async () => {
    const { client, insertCalls } = makeClient({ target: AGENT_TARGET, callerMembership: ADMIN });
    mockCreateClient.mockResolvedValue(client);
    await addSplitAgreementChange({ ...VALID_INPUT, note: '   ' });
    expect(insertCalls[0]).toMatchObject({ note: null });
  });
});

// ============================================================================
// The insert payload — exactly the post-trim GRANT column list
// ============================================================================

describe('insert payload', () => {
  it('inserts EXACTLY the post-trim granted columns — no office-fee fields, no seq/set_by/set_at', async () => {
    const { client, insertCalls } = makeClient({
      target: AGENT_TARGET,
      callerMembership: { role: 'admin' },
    });
    mockCreateClient.mockResolvedValue(client);
    await addSplitAgreementChange({ ...VALID_INPUT, note: 'Annual review' });

    // Transcribed from chore/BACKLOG-3503-trim-fees @ 107c29deb's GRANT INSERT
    // column list. Object.keys, not toMatchObject, so an EXTRA column (e.g. a
    // reintroduced office_fee_amount, or a client-supplied seq/set_by) fails
    // this test even though it would satisfy a subset match.
    expect(Object.keys(insertCalls[0] as object).sort()).toEqual(
      ['agent_pct', 'agent_user_id', 'brokerage_pct', 'effective_from', 'note', 'organization_id'].sort()
    );
    expect(insertCalls[0]).toEqual({
      organization_id: ORG_ID,
      agent_user_id: TARGET_USER_ID,
      agent_pct: 65,
      brokerage_pct: 35,
      effective_from: '2026-01-01',
      note: 'Annual review',
    });
  });

  it('surfaces an insert error (e.g. RLS refusal) without leaking the raw Postgres message', async () => {
    const { client } = makeClient({
      target: AGENT_TARGET,
      callerMembership: { role: 'admin' },
      insertError: { message: 'new row violates row-level security policy' },
    });
    mockCreateClient.mockResolvedValue(client);
    const result = await addSplitAgreementChange(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Failed to record the change' });
  });
});
