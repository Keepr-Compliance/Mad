/**
 * @jest-environment node
 *
 * BACKLOG-4238 — GET /oauth/authorize: request checks, the database call, the
 * consent redirect with the binding cookie, error redirects back to the client,
 * pages, logging and the route-level catch.
 * Controls H7, H8, H9, H10, H16b, H27b, H28 (plan-pr2-rev1 section f).
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...r: unknown[]) => mockRpc(...r) }) }));
const mockCapture = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import { createHash } from 'node:crypto';
import * as authorize from '@/app/oauth/authorize/route';
import * as cryptoModule from '@/lib/mcp/oauth/crypto';
import { ipDigest, toBytea } from '@/lib/mcp/oauth/crypto';
import {
  authorizeOk,
  authorizePage,
  authorizeRedirect,
  BINDING,
  blockNetwork,
  captureConsole,
  CHALLENGE,
  CLIENT_ID,
  OAUTH_ENV,
  ORIGIN,
  PEPPER_BYTES,
  PLANTED_KPR,
  PLANTED_PLAIN,
  PORTAL_SECRET,
  postgrestFetchError,
  REDIRECT_URI,
  REQUEST_ID,
  RESOURCE,
} from './fixtures';

const ENV = { ...process.env };
blockNetwork();
let cap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  mockCapture.mockReset();
  mockRpc.mockResolvedValue({ data: authorizeOk(), error: null });
  cap = captureConsole();
});
afterEach(() => {
  cap.restore();
  jest.restoreAllMocks();
});
afterAll(() => {
  process.env = ENV;
});

const GOOD: Record<string, string> = {
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  scope: 'mcp:read',
  state: PLANTED_PLAIN,
  resource: RESOURCE,
};

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, v);
  return `?${q.toString()}`;
}

function get(search: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' | 'POST' = 'GET') {
  return authorize[method](new Request(`${ORIGIN}/oauth/authorize${search}`, { method, headers }));
}

/** The arguments as PostgREST receives them (after JSON encoding). */
function wireArgs(): Record<string, unknown> {
  expect(mockRpc).toHaveBeenCalledTimes(1);
  const [fn, args] = mockRpc.mock.calls[0];
  expect(fn).toBe('mcp_authorize_begin');
  return JSON.parse(JSON.stringify(args));
}

function setCookieValue(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  return sc.split(';')[0].split('=').slice(1).join('=');
}

const PAGE_400 = 'This connection request is not valid. Go back to the app you came from and start again.\n';
const PAGE_503 = 'Keepr cannot take this connection request right now. Try again in a few minutes.\n';

async function expectPage(res: Response, status: 400 | 503) {
  expect(res.status).toBe(status);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('set-cookie')).toBeNull();
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe(status === 400 ? PAGE_400 : PAGE_503);
}

describe('H9: success', () => {
  it('302 to the consent page on the issuer origin', async () => {
    const res = await get(query(GOOD));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard/account/ai-apps/connect/${REQUEST_ID}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets the binding cookie with its flags', async () => {
    const res = await get(query(GOOD));
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-kpr_mcp_bind=kpr_bd_[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/
    );
  });

  it('sends sha256 of the cookie value as the binding digest', async () => {
    const res = await get(query(GOOD));
    const value = setCookieValue(res)!;
    expect(wireArgs().p_browser_binding_sha256).toBe(`\\x${createHash('sha256').update(value).digest('hex')}`);
  });

  it('reuses a well-formed binding cookie', async () => {
    const res = await get(query(GOOD), { cookie: `other=1; __Host-kpr_mcp_bind=${BINDING}` });
    expect(setCookieValue(res)).toBe(BINDING);
    expect(wireArgs().p_browser_binding_sha256).toBe(`\\x${createHash('sha256').update(BINDING).digest('hex')}`);
  });

  it.each([
    ['malformed', `__Host-kpr_mcp_bind=${PLANTED_PLAIN}`],
    ['sent twice', `__Host-kpr_mcp_bind=${BINDING}; __Host-kpr_mcp_bind=${BINDING}`],
    ['under another name', `kpr_mcp_bind=${BINDING}`],
  ])('mints a new binding when the cookie is %s', async (_l, cookie) => {
    const res = await get(query(GOOD), { cookie });
    const value = setCookieValue(res)!;
    expect(value).toMatch(/^kpr_bd_[A-Za-z0-9_-]{43}$/);
    expect(value).not.toBe(BINDING);
  });

  it('sends exactly the 10 parameters, with the canonical resource and the address digest', async () => {
    await get(query({ ...GOOD, resource: 'HTTPS://PORTAL.TEST/api/mcp' }), { 'x-vercel-forwarded-for': '203.0.113.7' });
    const args = wireArgs();
    expect(Object.keys(args).sort()).toEqual(
      [
        'p_secret',
        'p_client_id',
        'p_redirect_uri',
        'p_code_challenge',
        'p_code_challenge_method',
        'p_resource',
        'p_scope',
        'p_state',
        'p_browser_binding_sha256',
        'p_ip_sha256',
      ].sort()
    );
    expect(args).toMatchObject({
      p_secret: PORTAL_SECRET,
      p_client_id: CLIENT_ID,
      p_redirect_uri: REDIRECT_URI,
      p_code_challenge: CHALLENGE,
      p_code_challenge_method: 'S256',
      p_resource: RESOURCE,
      p_scope: 'mcp:read',
      p_state: PLANTED_PLAIN,
      p_ip_sha256: toBytea(ipDigest(PEPPER_BYTES, '203.0.113.7')),
    });
  });

  it.each(['state', 'code_challenge', 'code_challenge_method'])('an absent %s is sent as null with the key present', async (key) => {
    await get(query({ ...GOOD, [key]: undefined }));
    const args = wireArgs();
    expect(Object.prototype.hasOwnProperty.call(args, `p_${key}`)).toBe(true);
    expect(args[`p_${key}`]).toBeNull();
  });

  it('an empty state is sent as null', async () => {
    await get(query({ ...GOOD, state: '' }));
    expect(wireArgs().p_state).toBeNull();
  });

  it.each([
    ['../x'],
    ['A'.repeat(21)],
    [`${'A'.repeat(21)}/`],
  ])('a request id %p from the database shows the 503 page', async (id) => {
    mockRpc.mockResolvedValue({ data: authorizeOk(id), error: null });
    await expectPage(await get(query(GOOD)), 503);
  });
});

describe('H10: scope', () => {
  it.each([
    [undefined, 'mcp:read'],
    ['', 'mcp:read'],
    ['mcp:read offline_access', 'mcp:read'],
    ['openid profile email', 'mcp:read'],
    ['mcp:write', 'mcp:write'],
    ['mcp:read mcp:write', 'mcp:read mcp:write'],
  ])('scope %p is sent as %p', async (scope, sent) => {
    await get(query({ ...GOOD, scope }));
    expect(wireArgs().p_scope).toBe(sent);
  });
});

describe('H7: never redirects to the client for a request it cannot trust', () => {
  it.each([
    ['client_id sent twice', `${query(GOOD)}&client_id=${CLIENT_ID}`],
    ['redirect_uri sent twice', `${query(GOOD)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`],
    ['state sent twice', `${query(GOOD)}&state=x`],
    ['client_id missing', query({ ...GOOD, client_id: undefined })],
    ['client_id malformed', query({ ...GOOD, client_id: `kpr_c_${PLANTED_PLAIN}` })],
    ['redirect_uri missing', query({ ...GOOD, redirect_uri: undefined })],
    ['redirect_uri http', query({ ...GOOD, redirect_uri: 'http://client.example/callback' })],
    ['redirect_uri with a fragment', query({ ...GOOD, redirect_uri: `${REDIRECT_URI}#f` })],
    ['response_type missing', query({ ...GOOD, response_type: undefined })],
    ['response_type token', query({ ...GOOD, response_type: 'token' })],
    ['resource missing', query({ ...GOOD, resource: undefined })],
    ['query over 4096 bytes', query({ ...GOOD, pad: 'x'.repeat(4096) })],
  ])('%s → 400 page, no database call', async (_l, search) => {
    await expectPage(await get(search), 400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('positive: a query of exactly 4096 bytes passes the size check', async () => {
    const base = query({ ...GOOD, pad: '' });
    const search = query({ ...GOOD, pad: 'x'.repeat(4097 - base.length) });
    expect(search.length - 1).toBe(4096);
    expect((await get(search)).status).toBe(302);
  });

  it.each([
    ['invalid_client', 400],
    ['temporarily_unavailable', 503],
  ] as const)('database page %s → %s page', async (code, status) => {
    mockRpc.mockResolvedValue({ data: authorizePage(code), error: null });
    await expectPage(await get(query(GOOD)), status);
  });

  it.each([
    ['a transport error', { data: null, error: postgrestFetchError(PLANTED_PLAIN).error }],
    ['a thrown error', null],
    ['ok as a string', { data: { ok: 'true', request_id: REQUEST_ID, expires_in: 600 }, error: null }],
    ['ok without expires_in', { data: { ok: true, request_id: REQUEST_ID }, error: null }],
    ['an unknown page code', { data: authorizePage('access_denied'), error: null }],
    ['a page code as a redirect', { data: authorizeRedirect('invalid_client', REDIRECT_URI, null), error: null }],
    ['a redirect code as a page', { data: authorizePage('invalid_scope'), error: null }],
    ['a redirect with no redirect_uri', { data: { ok: false, error: 'invalid_scope', show: 'redirect' }, error: null }],
    ['an unknown show', { data: { ok: false, error: 'invalid_scope', show: 'json' }, error: null }],
  ])('%s → 503 page', async (_l, reply) => {
    if (reply === null) mockRpc.mockRejectedValue(new TypeError(PLANTED_PLAIN));
    else mockRpc.mockResolvedValue(reply);
    await expectPage(await get(query(GOOD)), 503);
  });

  it('a database redirect to another redirect_uri → 503 page', async () => {
    mockRpc.mockResolvedValue({ data: authorizeRedirect('invalid_scope', 'https://elsewhere.example/cb', null), error: null });
    await expectPage(await get(query(GOOD)), 503);
  });

  it('a database redirect that differs only in case → 503 page', async () => {
    mockRpc.mockResolvedValue({ data: authorizeRedirect('invalid_scope', REDIRECT_URI.toUpperCase(), null), error: null });
    await expectPage(await get(query(GOOD)), 503);
  });

  it('a redirect_uri with its own query is not redirected to → 503 page', async () => {
    const withQuery = `${REDIRECT_URI}?tenant=1`;
    mockRpc.mockResolvedValue({ data: authorizeRedirect('invalid_scope', withQuery, null), error: null });
    await expectPage(await get(query({ ...GOOD, redirect_uri: withQuery })), 503);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('H8: error redirect to the client', () => {
  it.each(['invalid_request', 'invalid_scope'])('%s → 302 to the request redirect_uri with error, state and iss', async (code) => {
    mockRpc.mockResolvedValue({ data: authorizeRedirect(code, REDIRECT_URI, PLANTED_PLAIN), error: null });
    const res = await get(query(GOOD));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith(`${REDIRECT_URI}?`)).toBe(true);
    const url = new URL(loc);
    expect([...url.searchParams.keys()]).toEqual(['error', 'state', 'iss']);
    expect(url.searchParams.get('error')).toBe(code);
    expect(url.searchParams.get('state')).toBe(PLANTED_PLAIN);
    expect(url.searchParams.get('iss')).toBe(ORIGIN);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('state is left out when the request had none', async () => {
    mockRpc.mockResolvedValue({ data: authorizeRedirect('invalid_scope', REDIRECT_URI, null), error: null });
    const loc = (await get(query({ ...GOOD, state: undefined }))).headers.get('location')!;
    expect([...new URL(loc).searchParams.keys()]).toEqual(['error', 'iss']);
  });

  it("the state comes from the request, not the database's copy", async () => {
    mockRpc.mockResolvedValue({ data: authorizeRedirect('invalid_scope', REDIRECT_URI, 'from-database'), error: null });
    const loc = (await get(query(GOOD))).headers.get('location')!;
    expect(new URL(loc).searchParams.get('state')).toBe(PLANTED_PLAIN);
  });
});

describe('H28: resource', () => {
  it.each(['HTTPS://PORTAL.TEST/api/mcp', 'https://Portal.Test/api/mcp'])('%p is accepted and sent canonical', async (r) => {
    await get(query({ ...GOOD, resource: r }));
    expect(wireArgs().p_resource).toBe(RESOURCE);
  });

  it.each([
    `${RESOURCE}/`,
    `${RESOURCE}?x=1`,
    `${RESOURCE}#f`,
    'https://portal.test:443/api/mcp',
    'https://portal.test/API/mcp',
    'https://portal.test/api/./mcp',
    'https://u@portal.test/api/mcp',
    'https://other.test/api/mcp',
    'http://portal.test/api/mcp',
  ])('%p → 400 page, no database call', async (r) => {
    await expectPage(await get(query({ ...GOOD, resource: r })), 400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H27b: methods', () => {
  it('the module exports HEAD', () => {
    expect(typeof authorize.HEAD).toBe('function');
  });

  it('HEAD → 405 with Allow: GET, no database call, no cookie', async () => {
    const res = await get(query(GOOD), {}, 'HEAD');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('POST → 405, no database call', async () => {
    expect((await get(query(GOOD), {}, 'POST')).status).toBe(405);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H16b: logging and the route-level catch', () => {
  it('one log line with the outcome; no parameter or cookie value', async () => {
    await get(query({ ...GOOD, client_id: CLIENT_ID }), { cookie: `__Host-kpr_mcp_bind=${BINDING}` });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0].slice('[mcp-oauth] '.length));
    expect(o).toMatchObject({ route: 'authorize', outcome: 'consent', status: 302 });
    for (const v of [PLANTED_PLAIN, CLIENT_ID, BINDING, CHALLENGE, REDIRECT_URI, PORTAL_SECRET]) {
      expect(lines[0]).not.toContain(v);
    }
  });

  it('a page and a transport error log no request value', async () => {
    mockRpc.mockResolvedValue({ data: null, error: postgrestFetchError(PLANTED_PLAIN).error });
    await get(query(GOOD));
    await get(query({ ...GOOD, client_id: `kpr_c_${PLANTED_PLAIN}` }));
    const lines = cap.lines();
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).not.toContain(PLANTED_PLAIN);
  });

  it('a handler that throws → the static 503 page; Sentry gets the static message only', async () => {
    jest.spyOn(cryptoModule, 'ipDigest').mockImplementation(() => {
      throw new Error(`${PLANTED_KPR} ${PLANTED_PLAIN}`);
    });
    await expectPage(await get(query(GOOD)), 503);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith('mcp-oauth route error', {
      level: 'error',
      tags: { route: 'authorize', error_name: 'Other' },
    });
    for (const l of cap.lines()) {
      expect(l).not.toContain(PLANTED_PLAIN);
      expect(l).not.toContain(PLANTED_KPR);
    }
  });
});
