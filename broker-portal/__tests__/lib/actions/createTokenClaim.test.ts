/**
 * BACKLOG-3543: createTokenClaim verifies the stored token, binds the claim to
 * that token's owner, validates the payload, and returns generic errors.
 */
const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { getUser: (...a: unknown[]) => mockGetUser(...a) },
    rpc: (...a: unknown[]) => mockRpc(...a),
  }),
}));

import { createTokenClaim } from '@/lib/actions/createTokenClaim';

function makeToken(claims: Record<string, unknown>): string {
  const b = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.sig`;
}

const VERIFIED = '11111111-1111-4111-8111-111111111111'; // pii-allow-uuid: invented, not from any live row
const OTHER = '22222222-2222-4222-8222-222222222222'; // pii-allow-uuid: invented, not from any live row
// The token's unverified `sub` deliberately differs from the verified id, so an
// implementation that decodes the JWT locally instead of verifying it fails T0.
const TOKEN = makeToken({ sub: OTHER });
const PAYLOAD = {
  access_token: TOKEN,
  refresh_token: 'r1',
  provider_token: 'p1',
  provider_refresh_token: null,
};

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED } }, error: null });
  mockRpc.mockResolvedValue({ data: 'claim-1', error: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function expectRefusedWith(category: string) {
  expect(mockRpc).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy).toHaveBeenCalledWith('[createTokenClaim] refused:', category);
  // C3: the log line carries the category only — no ids, no tokens.
  const logged = JSON.stringify(warnSpy.mock.calls);
  for (const secret of [VERIFIED, OTHER, TOKEN, 'r1', 'p1']) {
    expect(logged).not.toContain(secret);
  }
}

describe('createTokenClaim caller check (BACKLOG-3543)', () => {
  it('T0 writes a claim for the verified owner of the stored token', async () => {
    const r = await createTokenClaim(VERIFIED, PAYLOAD, 'google');
    expect(r).toEqual({ success: true, claimId: 'claim-1' });
    expect(mockGetUser).toHaveBeenCalledWith(TOKEN);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][1]).toEqual({
      p_user_id: VERIFIED,
      p_payload: PAYLOAD,
      p_provider: 'google',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T0b accepts the providers the callback page sends', async () => {
    for (const p of ['google', 'azure', 'email']) {
      const r = await createTokenClaim(VERIFIED, PAYLOAD, p);
      expect(r.success).toBe(true);
    }
  });

  it('T0c accepts a payload with the provider tokens absent', async () => {
    const r = await createTokenClaim(
      VERIFIED,
      { access_token: TOKEN, refresh_token: 'r1' },
      'azure'
    );
    expect(r.success).toBe(true);
    expect(mockRpc.mock.calls[0][1].p_payload).toEqual({
      access_token: TOKEN,
      refresh_token: 'r1',
      provider_token: null,
      provider_refresh_token: null,
    });
  });

  it('T1 refuses when the supplied user id is not the token owner', async () => {
    const r = await createTokenClaim(OTHER, PAYLOAD, 'google');
    expect(r.success).toBe(false);
    expectRefusedWith('identity_mismatch');
  });

  it('T2 refuses when the token does not verify', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
    const r = await createTokenClaim(OTHER, PAYLOAD, 'google');
    expect(r.success).toBe(false);
    expectRefusedWith('unverified');
  });

  it('T2b refuses when getUser errors even if a user object is present', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: VERIFIED } },
      error: { message: 'boom' },
    });
    const r = await createTokenClaim(VERIFIED, PAYLOAD, 'google');
    expect(r.success).toBe(false);
    expectRefusedWith('unverified');
  });

  it('T3 refuses a payload with keys beyond the four token fields', async () => {
    const r = await createTokenClaim(
      VERIFIED,
      { ...PAYLOAD, junk: 'x'.repeat(1000) } as never,
      'google'
    );
    expect(r.success).toBe(false);
    expectRefusedWith('payload_shape');
  });

  it('T3b refuses an oversized Supabase token field', async () => {
    const r = await createTokenClaim(
      VERIFIED,
      { ...PAYLOAD, refresh_token: 'x'.repeat(100_000) },
      'google'
    );
    expect(r.success).toBe(false);
    expectRefusedWith('payload_shape');
  });

  it('T3c session-token cap: 8192 chars accepted, 8193 refused', async () => {
    const ok = await createTokenClaim(
      VERIFIED,
      { ...PAYLOAD, refresh_token: 'x'.repeat(8192) },
      'google'
    );
    expect(ok.success).toBe(true);
    mockRpc.mockClear();
    const bad = await createTokenClaim(
      VERIFIED,
      { ...PAYLOAD, refresh_token: 'x'.repeat(8193) },
      'google'
    );
    expect(bad.success).toBe(false);
    expectRefusedWith('payload_shape');
  });

  it.each(['provider_token', 'provider_refresh_token'])(
    'T3d provider-token cap on %s: 32768 chars accepted, 32769 refused',
    async (field) => {
      const ok = await createTokenClaim(
        VERIFIED,
        { ...PAYLOAD, [field]: 'x'.repeat(32768) },
        'azure'
      );
      expect(ok.success).toBe(true);
      mockRpc.mockClear();
      const bad = await createTokenClaim(
        VERIFIED,
        { ...PAYLOAD, [field]: 'x'.repeat(32769) },
        'azure'
      );
      expect(bad.success).toBe(false);
      expectRefusedWith('payload_shape');
    }
  );

  it('T3e refuses a missing access token', async () => {
    const r = await createTokenClaim(
      VERIFIED,
      { refresh_token: 'r1' } as never,
      'google'
    );
    expect(r.success).toBe(false);
    expectRefusedWith('payload_shape');
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('T4 does not echo database error text to the caller', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'violates foreign key constraint "token_claims_user_id_fkey"' },
    });
    const r = await createTokenClaim(VERIFIED, PAYLOAD, 'google');
    expect(r.success).toBe(false);
    expect(r.error).not.toMatch(/foreign key|token_claims/);
  });

  it('T5 refuses an invalid provider', async () => {
    const r = await createTokenClaim(VERIFIED, PAYLOAD, 'GOOGLE OAUTH');
    expect(r.success).toBe(false);
    expectRefusedWith('provider');
  });

  it('T5b refuses an over-long provider', async () => {
    const r = await createTokenClaim(VERIFIED, PAYLOAD, 'a'.repeat(33));
    expect(r.success).toBe(false);
    expectRefusedWith('provider');
  });
});
