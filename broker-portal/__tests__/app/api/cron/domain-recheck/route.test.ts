/**
 * @jest-environment node
 *
 * BACKLOG-3962 PR2: the daily domain claim re-check cron.
 *
 * The fake server-role client answers the two functions with the shapes from
 * supabase/migrations/20261112100000_backlog_3962_domain_claims.sql:
 *   _domain_claims_due_for_recheck  RETURNS TABLE (claim_id, organization_id, domain) -> rows
 *   _domain_claim_record_check      jsonb_build_object('success', true, 'result', ..., 'status', ...,
 *                                   'consecutive_misses', ...)
 * and _domain_claim_begin_check the way it answers right after the due query stamped the row
 * (too_soon). DNS lookups are faked; no network.
 */

const mockRpc = jest.fn();
const mockLookup = jest.fn();

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));
jest.mock('@/lib/domain/doh', () => ({
  lookupClaimTxt: (...a: unknown[]) => mockLookup(...a),
}));

import { GET } from '../../../../../app/api/cron/domain-recheck/route';

const ORG_A = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const ORG_B = '00000000-0000-4000-8000-00000000000b'; // pii-allow-uuid: invented fixture id
const CLAIM_1 = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const CLAIM_2 = '00000000-0000-4000-8000-0000000000c2'; // pii-allow-uuid: invented fixture id
const TOKEN_1 = 'keepr-domain-verification=' + '1'.repeat(48);

const SECRET = 'cron-secret-value';
const ORIGINAL = process.env.CRON_SECRET;

function req(): Request {
  return new Request('https://x/api/cron/domain-recheck', { headers: { authorization: `Bearer ${SECRET}` } });
}

type Reply = { data: unknown; error: unknown };
let dueReply: Reply;
let recordReply: (args: Record<string, unknown>) => Reply;

function calls(fn: string): Array<Record<string, unknown>> {
  return mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  dueReply = {
    data: [
      { claim_id: CLAIM_1, organization_id: ORG_A, domain: 'a-brokerage.example' },
      { claim_id: CLAIM_2, organization_id: ORG_B, domain: 'b-brokerage.example' },
    ],
    error: null,
  };
  recordReply = () => ({
    data: { success: true, result: 'not_found', status: 'verified', consecutive_misses: 1 },
    error: null,
  });
  mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === '_domain_claims_due_for_recheck') return dueReply;
    if (fn === '_domain_claim_record_check') return recordReply(args);
    if (fn === '_domain_claim_begin_check') return { data: { success: false, error: 'too_soon' }, error: null };
    return { data: null, error: { code: 'PGRST202', message: 'unexpected rpc ' + fn } };
  });
  mockLookup.mockImplementation(async (domain: string) =>
    domain === 'a-brokerage.example'
      ? { resolverOk: true, answers: [TOKEN_1] }
      : { resolverOk: false, answers: [] }
  );
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/domain-recheck', () => {
  it('asks for at most 50 due claims', async () => {
    await GET(req());
    expect(calls('_domain_claims_due_for_recheck')).toEqual([{ p_limit: 50 }]);
  });

  it("records each due claim with p_source 'recheck' and the organization from its own due row", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const recorded = calls('_domain_claim_record_check');
    expect(recorded).toHaveLength(2);
    const byClaim = Object.fromEntries(recorded.map((a) => [a.p_claim, a]));
    expect(byClaim[CLAIM_1]).toEqual({
      p_claim: CLAIM_1,
      p_org: ORG_A,
      p_answers: [TOKEN_1],
      p_resolver_ok: true,
      p_source: 'recheck',
    });
    expect(byClaim[CLAIM_2]).toEqual({
      p_claim: CLAIM_2,
      p_org: ORG_B,
      p_answers: [],
      p_resolver_ok: false,
      p_source: 'recheck',
    });
    for (const a of recorded) expect(a.p_source).toBe('recheck');
    expect(mockLookup.mock.calls.map((c) => c[0]).sort()).toEqual(['a-brokerage.example', 'b-brokerage.example']);
  });

  it('never calls _domain_claim_begin_check; the only functions are the due query and record_check', async () => {
    await GET(req());
    expect(calls('_domain_claim_begin_check')).toHaveLength(0);
    expect([...new Set(mockRpc.mock.calls.map((c) => c[0]))].sort()).toEqual([
      '_domain_claim_record_check',
      '_domain_claims_due_for_recheck',
    ]);
  });

  it('reports the counts by result', async () => {
    recordReply = (a) => ({
      data: { success: true, result: a.p_claim === CLAIM_1 ? 'verified' : 'resolver_unavailable', status: 'verified' },
      error: null,
    });
    const body = await (await GET(req())).json();
    expect(body).toEqual({ due: 2, recorded: 2, failed: 0, results: { verified: 1, resolver_unavailable: 1 } });
  });

  it('returns 500 and records nothing when the due query fails', async () => {
    dueReply = { data: null, error: { message: 'boom' } };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(calls('_domain_claim_record_check')).toHaveLength(0);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('does nothing when no claim is due', async () => {
    dueReply = { data: [], error: null };
    const body = await (await GET(req())).json();
    expect(body).toEqual({ due: 0, recorded: 0, failed: 0, results: {} });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('a failed record or a thrown lookup on one claim does not stop the others', async () => {
    dueReply = {
      data: [
        { claim_id: CLAIM_1, organization_id: ORG_A, domain: 'a-brokerage.example' },
        { claim_id: CLAIM_2, organization_id: ORG_B, domain: 'b-brokerage.example' },
        { claim_id: 'c3', organization_id: ORG_A, domain: 'throws.example' },
      ],
      error: null,
    };
    const base = mockLookup.getMockImplementation()!;
    mockLookup.mockImplementation(async (d: string) => {
      if (d === 'throws.example') throw new Error('network');
      return base(d);
    });
    recordReply = (a) =>
      a.p_claim === CLAIM_2
        ? { data: null, error: { message: 'db' } }
        : { data: { success: true, result: 'not_found', status: 'verified' }, error: null };
    const body = await (await GET(req())).json();
    expect(body).toEqual({ due: 3, recorded: 1, failed: 2, results: { not_found: 1 } });
  });

  it("counts a claim_not_found reply ({ success: false, error }) as failed, not recorded", async () => {
    recordReply = () => ({ data: { success: false, error: 'claim_not_found' }, error: null });
    const body = await (await GET(req())).json();
    expect(body).toEqual({ due: 2, recorded: 0, failed: 2, results: {} });
  });

  it('runs at most 5 lookups at once, and more than one', async () => {
    dueReply = {
      data: Array.from({ length: 12 }, (_, i) => ({ claim_id: `c${i}`, organization_id: ORG_A, domain: `d${i}.example` })),
      error: null,
    };
    let inFlight = 0;
    let peak = 0;
    mockLookup.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { resolverOk: true, answers: [] };
    });
    const body = await (await GET(req())).json();
    expect(body.recorded).toBe(12);
    expect(peak).toBe(5);
  });
});
