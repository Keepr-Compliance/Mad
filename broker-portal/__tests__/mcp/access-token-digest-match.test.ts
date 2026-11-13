/**
 * @jest-environment node
 */

/*
 * BACKLOG-4238 — the access token digest /oauth/token sends to the database
 * for storage equals the digest /api/mcp sends to mcp_check_access for the
 * token the client received, for both grants. The database is a mocked rpc
 * client; the token comes from the token route's response body.
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));

import * as tokenRoute from '@/app/oauth/token/route';
import * as mcpRoute from '@/app/api/mcp/route';
import { CLIENT_ID, CODE, OAUTH_ENV, REDIRECT_URI, REFRESH, VERIFIER, blockNetwork, refusal, tokenOk } from './oauth/fixtures';

const ENV = { ...process.env };
blockNetwork();
beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = ENV;
});

/** Issues a token through /oauth/token; returns the token from the response and the digest sent for storage. */
async function issue(params: Record<string, string>, fn: string, digestArg: string) {
  mockRpc.mockResolvedValue({ data: tokenOk(), error: null });
  const res = await tokenRoute.POST(
    new Request('https://portal.test/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockRpc).toHaveBeenCalledTimes(1);
  const [name, args] = mockRpc.mock.calls[0];
  expect(name).toBe(fn);
  const wire = JSON.parse(JSON.stringify(args));
  return { accessToken: body.access_token as string, stored: wire[digestArg] as string };
}

/** Sends the token to /api/mcp; returns the digest sent to mcp_check_access. */
async function checked(accessToken: string) {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: refusal('not_connected'), error: null });
  const res = await mcpRoute.POST(
    new Request('https://portal.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    })
  );
  expect(res.status).toBe(401);
  expect(mockRpc).toHaveBeenCalledTimes(1);
  const [name, args] = mockRpc.mock.calls[0];
  expect(name).toBe('mcp_check_access');
  return JSON.parse(JSON.stringify(args)).p_at_digest as string;
}

describe('the access token digest stored at issue equals the digest checked at /api/mcp', () => {
  it.each([
    [
      'authorization_code',
      { grant_type: 'authorization_code', code: CODE, code_verifier: VERIFIER, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI },
      'mcp_exchange_code',
      'p_at_digest',
    ],
    ['refresh_token', { grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT_ID }, 'mcp_refresh', 'p_new_at_digest'],
  ])('grant %s', async (_grant, params, fn, digestArg) => {
    const { accessToken, stored } = await issue(params, fn, digestArg);
    expect(accessToken).toMatch(/^kpr_at_[A-Za-z0-9_-]{43}$/);
    expect(stored).toMatch(/^\\x[0-9a-f]{64}$/);
    const sent = await checked(accessToken);
    expect(sent).toBe(stored);
  });
});
