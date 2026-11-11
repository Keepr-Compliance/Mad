/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 QA follow-up: a not-found check also looks at `_keepr.<domain>.<domain>`. The hit
 * is display-only: the recorded check stays the miss that record_check returned.
 * DoH answer shapes are transcribed from the fixtures in ./fixtures (see doh.test.ts).
 */

const mockBlock = jest.fn();
const mockAccess = jest.fn();
const mockCreateServiceClient = jest.fn();

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/domain/access', () => ({ requireDomainClaimAccess: () => mockAccess() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: (o: unknown) => mockCreateServiceClient(o) }));

import { checkDomainClaim } from '@/lib/actions/domainClaim';
import { checkResultMessage, doubledNameMessage } from '@/lib/domain/claims';

const ORG = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const DOMAIN = 'a-brokerage.example';
const TOKEN = 'keepr-domain-verification=' + 'a'.repeat(48);
const OTHER = 'keepr-domain-verification=' + 'b'.repeat(48);

let serviceRpc: jest.Mock;
let fetchMock: jest.Mock;

/** `doubledValue`: what a TXT lookup of the doubled name returns (null = no record). */
function given(doubledValue: string | null, recordResult = 'not_found') {
  mockAccess.mockResolvedValue({
    ok: true,
    userId: 'user-a',
    organizationId: ORG,
    supabase: {
      from: (table: string) => {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: table === 'domain_claims' ? { token: TOKEN } : null, error: null }),
        };
        return b;
      },
    },
  });
  serviceRpc = jest.fn(async (fn: string) => {
    if (fn === '_domain_claim_begin_check') return { data: { success: true, domain: DOMAIN }, error: null };
    return { data: { success: true, result: recordResult, status: 'pending' }, error: null };
  });
  mockCreateServiceClient.mockReturnValue({ rpc: serviceRpc });
  fetchMock = jest.fn(async (url: string) => {
    const doubled = decodeURIComponent(url).includes(`_keepr.${DOMAIN}.${DOMAIN}`);
    const hit = doubled && doubledValue !== null;
    const cf = hit
      ? { Status: 0, Answer: [{ type: 16, data: `"${doubledValue}"` }] }
      : { Status: 0 };
    const g = hit ? { Status: 0, Answer: [{ type: 16, data: doubledValue }] } : { Status: 0 };
    return { ok: true, json: async () => (url.startsWith('https://cloudflare-dns.com') ? cf : g) };
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
}

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockAccess.mockReset();
  mockCreateServiceClient.mockReset();
});

describe('doubled-name hint', () => {
  it('is shown when the claim token is at _keepr.<domain>.<domain>, and the claim is NOT verified', async () => {
    given(TOKEN);
    const res = await checkDomainClaim(CLAIM);
    expect(res.doubledName).toBe(true);
    expect(res.message).toBe(doubledNameMessage(DOMAIN));
    expect(res.message).toContain(`_keepr.${DOMAIN}.${DOMAIN}`);
    expect(res.success).toBe(false);
    expect(res.result).toBe('not_found');
    expect(res.status).toBe('pending');
    // what was recorded is the ordinary lookup of _keepr.<domain> only: no answers, a miss
    const rec = serviceRpc.mock.calls.filter((c) => c[0] === '_domain_claim_record_check');
    expect(rec).toHaveLength(1);
    expect(rec[0][1]).toMatchObject({ p_answers: [], p_resolver_ok: true, p_source: 'manual' });
  });

  it('is NOT shown when the doubled name holds a different value', async () => {
    given(OTHER);
    const res = await checkDomainClaim(CLAIM);
    expect(res.doubledName).toBeUndefined();
    expect(res.message).toBe(checkResultMessage('not_found', DOMAIN));
    expect(res.success).toBe(false);
  });

  it.each([
    ['the token with trailing characters', TOKEN + 'x'],
    ['the token with a prefix', 'x' + TOKEN],
    ['the token inside a longer value', 'v=' + TOKEN + ' more'],
  ])('is NOT shown when the doubled name holds %s', async (_n, value) => {
    given(value);
    const res = await checkDomainClaim(CLAIM);
    expect(res.doubledName).toBeUndefined();
    expect(res.message).toBe(checkResultMessage('not_found', DOMAIN));
  });

  it('is NOT shown when the doubled name has no record', async () => {
    given(null);
    const res = await checkDomainClaim(CLAIM);
    expect(res.doubledName).toBeUndefined();
    expect(res.message).toBe(checkResultMessage('not_found', DOMAIN));
  });

  it('is not looked up at all when the check was not a not-found', async () => {
    given(TOKEN, 'mismatch');
    const res = await checkDomainClaim(CLAIM);
    expect(res.doubledName).toBeUndefined();
    expect(fetchMock.mock.calls.some((c) => decodeURIComponent(String(c[0])).includes(`${DOMAIN}.${DOMAIN}`))).toBe(false);
  });
});
