/**
 * @jest-environment node
 *
 * BACKLOG-4238 — POST /oauth/token: request checks, both grants, the result
 * mapping, response headers, logging and the route-level catch.
 * Controls H11, H12, H13, H14, H15b, H16b, H27b, H28 (plan-pr2-rev1 section f).
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...r: unknown[]) => mockRpc(...r) }) }));
const mockCapture = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import * as token from '@/app/oauth/token/route';
import * as cryptoModule from '@/lib/mcp/oauth/crypto';
import { digest } from '@/lib/mcp/oauth/crypto';
import {
  blockNetwork,
  captureConsole,
  CLIENT_ID,
  CODE,
  OAUTH_ENV,
  ORIGIN,
  PEPPER_BYTES,
  PLANTED_KPR,
  PLANTED_PLAIN,
  PORTAL_SECRET,
  postgrestAbortError,
  postgrestFetchError,
  postgrestTimeoutError,
  REDIRECT_URI,
  REFRESH,
  refusal,
  RESOURCE,
  tokenOk,
  VERIFIER,
} from './fixtures';

const URL_ = `${ORIGIN}/oauth/token`;
const FORM = 'application/x-www-form-urlencoded';
const ENV = { ...process.env };
blockNetwork();
let cap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  mockCapture.mockReset();
  mockRpc.mockResolvedValue({ data: tokenOk(), error: null });
  cap = captureConsole();
});
afterEach(() => {
  cap.restore();
  jest.restoreAllMocks();
});
afterAll(() => {
  process.env = ENV;
});

const CODE_GRANT: Record<string, string> = {
  grant_type: 'authorization_code',
  code: CODE,
  code_verifier: VERIFIER,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
};
const REFRESH_GRANT: Record<string, string> = {
  grant_type: 'refresh_token',
  refresh_token: REFRESH,
  client_id: CLIENT_ID,
};

function form(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, v);
  return q.toString();
}

function post(
  body: string,
  opts: { url?: string; headers?: Record<string, string>; method?: 'POST' | 'GET' | 'HEAD' } = {}
): Promise<Response> {
  const method = opts.method ?? 'POST';
  return token[method](
    new Request(opts.url ?? URL_, {
      method,
      headers: { 'content-type': FORM, ...opts.headers },
      body: method === 'POST' ? body : undefined,
    })
  );
}

/** The arguments as PostgREST receives them (after JSON encoding). */
function wireArgs(fn: string): Record<string, unknown> {
  expect(mockRpc).toHaveBeenCalledTimes(1);
  const [name, args] = mockRpc.mock.calls[0];
  expect(name).toBe(fn);
  return JSON.parse(JSON.stringify(args));
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('pragma')).toBe('no-cache');
}

describe('H11: request hygiene, no database call', () => {
  it.each([
    ['a query string', { url: `${URL_}?x=1` }, 400, 'invalid_request'],
    ['a credential in the query', { url: `${URL_}?refresh_token=${PLANTED_PLAIN}` }, 400, 'invalid_request'],
    ['a JSON body', { headers: { 'content-type': 'application/json' } }, 400, 'invalid_request'],
    ['no content type', { headers: { 'content-type': '' } }, 400, 'invalid_request'],
  ] as const)('%s → %s %s', async (_l, opts, status, error) => {
    await expectError(await post(form(CODE_GRANT), opts as { url?: string; headers?: Record<string, string> }), status, error);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a form content type with a charset is accepted', async () => {
    const res = await post(form(CODE_GRANT), { headers: { 'content-type': `${FORM}; charset=UTF-8` } });
    expect(res.status).toBe(200);
  });

  it('a body over 8 KiB → 400 invalid_request', async () => {
    await expectError(await post(form({ ...CODE_GRANT, pad: 'x'.repeat(8 * 1024) })), 400, 'invalid_request');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('positive: a body of exactly 8 KiB passes the size check', async () => {
    const base = form({ ...CODE_GRANT, pad: '' });
    const body = form({ ...CODE_GRANT, pad: 'x'.repeat(8 * 1024 - base.length) });
    expect(Buffer.byteLength(body)).toBe(8 * 1024);
    expect((await post(body)).status).toBe(200);
  });

  it('an Authorization header → 401 invalid_client with a Basic challenge', async () => {
    const res = await post(form(CODE_GRANT), { headers: { authorization: `Basic ${PLANTED_PLAIN}` } });
    await expectError(res, 401, 'invalid_client');
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="keepr"');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['grant_type sent twice', `${form(CODE_GRANT)}&grant_type=authorization_code`, 'invalid_request'],
    ['code sent twice', `${form(CODE_GRANT)}&code=${CODE}`, 'invalid_request'],
    ['code sent twice, one copy empty', `${form({ ...CODE_GRANT, code: '' })}&code=${CODE}`, 'invalid_request'],
    ['redirect_uri sent twice', `${form(CODE_GRANT)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`, 'invalid_request'],
    ['client_secret sent twice', `${form(CODE_GRANT)}&client_secret=a&client_secret=b`, 'invalid_request'],
    ['resource sent twice', `${form({ ...CODE_GRANT, resource: RESOURCE })}&resource=${encodeURIComponent(RESOURCE)}`, 'invalid_target'],
    ['client_secret', form({ ...CODE_GRANT, client_secret: PLANTED_PLAIN }), 'invalid_client'],
    ['client_assertion', form({ ...CODE_GRANT, client_assertion: PLANTED_PLAIN }), 'invalid_client'],
    ['client_id missing', form({ ...CODE_GRANT, client_id: undefined }), 'invalid_request'],
    ['client_id malformed', form({ ...CODE_GRANT, client_id: `kpr_c_${PLANTED_PLAIN}` }), 'invalid_client'],
    ['grant_type missing', form({ ...CODE_GRANT, grant_type: undefined }), 'invalid_request'],
    ['grant_type unknown', form({ ...CODE_GRANT, grant_type: 'password' }), 'unsupported_grant_type'],
    ['grant_type client_credentials', form({ ...CODE_GRANT, grant_type: 'client_credentials' }), 'unsupported_grant_type'],
    ['scope outside the read set', form({ ...CODE_GRANT, scope: 'mcp:write' }), 'invalid_scope'],
  ])('%s → 400 %s', async (_l, body, error) => {
    await expectError(await post(body), 400, error);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(['mcp:read', 'mcp:read offline_access', ''])('scope %p is accepted and not sent', async (scope) => {
    expect((await post(form({ ...CODE_GRANT, scope }))).status).toBe(200);
    expect(Object.keys(wireArgs('mcp_exchange_code'))).not.toContain('p_scope');
  });
});

describe('H12: authorization_code request checks', () => {
  it('a missing redirect_uri is sent as null with the key present', async () => {
    await post(form({ ...CODE_GRANT, redirect_uri: undefined }));
    const args = wireArgs('mcp_exchange_code');
    expect(Object.prototype.hasOwnProperty.call(args, 'p_redirect_uri')).toBe(true);
    expect(args.p_redirect_uri).toBeNull();
  });

  it('a present redirect_uri is forwarded unchanged', async () => {
    const odd = 'https://client.example/callback?x=1';
    await post(form({ ...CODE_GRANT, redirect_uri: odd }));
    expect(wireArgs('mcp_exchange_code').p_redirect_uri).toBe(odd);
  });

  it.each([
    ['code missing', { code: undefined }, 'invalid_request'],
    ['code malformed', { code: `kpr_ac_${'C'.repeat(42)}` }, 'invalid_grant'],
    ['code of another kind', { code: REFRESH }, 'invalid_grant'],
    ['verifier missing', { code_verifier: undefined }, 'invalid_request'],
    ['verifier 42 characters', { code_verifier: 'v'.repeat(42) }, 'invalid_request'],
    ['verifier 129 characters', { code_verifier: 'v'.repeat(129) }, 'invalid_request'],
    ['resource another origin', { resource: 'https://other.test/api/mcp' }, 'invalid_target'],
  ])('%s → 400 %s, no database call', async (_l, change, error) => {
    await expectError(await post(form({ ...CODE_GRANT, ...change })), 400, error);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H13: authorization_code exchange', () => {
  it('sends exactly the 8 parameters with digests of the code and of the issued tokens', async () => {
    const res = await post(form(CODE_GRANT));
    const body = await res.json();
    const args = wireArgs('mcp_exchange_code');
    expect(Object.keys(args).sort()).toEqual(
      ['p_secret', 'p_code_digest', 'p_code_verifier', 'p_client_id', 'p_redirect_uri', 'p_resource', 'p_at_digest', 'p_rt_digest'].sort()
    );
    expect(args).toEqual({
      p_secret: PORTAL_SECRET,
      p_code_digest: digest(PEPPER_BYTES, CODE),
      p_code_verifier: VERIFIER,
      p_client_id: CLIENT_ID,
      p_redirect_uri: REDIRECT_URI,
      p_resource: RESOURCE,
      p_at_digest: digest(PEPPER_BYTES, body.access_token),
      p_rt_digest: digest(PEPPER_BYTES, body.refresh_token),
    });
    expect(args.p_at_digest).not.toBe(args.p_rt_digest);
  });

  it('the access and refresh tokens come from separate random values', async () => {
    const body = await (await post(form(CODE_GRANT))).json();
    expect(body.access_token.slice('kpr_at_'.length)).not.toBe(body.refresh_token.slice('kpr_rt_'.length));
  });

  it('answers 200 with the issued tokens and the database values', async () => {
    mockRpc.mockResolvedValue({ data: { ...tokenOk(), expires_in: 1234 }, error: null });
    const res = await post(form(CODE_GRANT));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
    expect(body.access_token).toMatch(/^kpr_at_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^kpr_rt_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 1234, scope: 'mcp:read' });
  });

  it('success carries no-store and Pragma', async () => {
    const res = await post(form(CODE_GRANT));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
  });

  it('an uppercase resource is accepted and sent canonical (H28)', async () => {
    await post(form({ ...CODE_GRANT, resource: 'HTTPS://PORTAL.TEST/api/mcp' }));
    expect(wireArgs('mcp_exchange_code').p_resource).toBe(RESOURCE);
  });
});

describe('H14: refresh', () => {
  it('sends exactly the 6 parameters; the returned refresh token is new and matches its digest', async () => {
    const res = await post(form(REFRESH_GRANT));
    expect(res.status).toBe(200);
    const body = await res.json();
    const args = wireArgs('mcp_refresh');
    expect(Object.keys(args).sort()).toEqual(
      ['p_secret', 'p_rt_digest', 'p_client_id', 'p_resource', 'p_new_at_digest', 'p_new_rt_digest'].sort()
    );
    expect(args).toEqual({
      p_secret: PORTAL_SECRET,
      p_rt_digest: digest(PEPPER_BYTES, REFRESH),
      p_client_id: CLIENT_ID,
      p_resource: RESOURCE,
      p_new_at_digest: digest(PEPPER_BYTES, body.access_token),
      p_new_rt_digest: digest(PEPPER_BYTES, body.refresh_token),
    });
    expect(body.refresh_token).not.toBe(REFRESH);
  });

  it('a transport error → 503 and the database is called once', async () => {
    mockRpc.mockResolvedValue({ data: null, error: postgrestFetchError(PLANTED_PLAIN).error });
    const res = await post(form(REFRESH_GRANT));
    await expectError(res, 503, 'temporarily_unavailable');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('a database invalid_request (token insert failure) → 400 invalid_request', async () => {
    mockRpc.mockResolvedValue({ data: refusal('invalid_request'), error: null });
    await expectError(await post(form(REFRESH_GRANT)), 400, 'invalid_request');
  });

  it('an uppercase resource is accepted and sent canonical (H28)', async () => {
    await post(form({ ...REFRESH_GRANT, resource: 'HTTPS://PORTAL.TEST/api/mcp' }));
    expect(wireArgs('mcp_refresh').p_resource).toBe(RESOURCE);
  });

  it.each([
    ['refresh_token missing', { refresh_token: undefined }, 'invalid_request'],
    ['refresh_token malformed', { refresh_token: `kpr_rt_${'R'.repeat(44)}` }, 'invalid_grant'],
    ['refresh_token of another kind', { refresh_token: CODE }, 'invalid_grant'],
    ['resource with a trailing slash', { resource: `${RESOURCE}/` }, 'invalid_target'],
  ])('%s → 400 %s, no database call', async (_l, change, error) => {
    await expectError(await post(form({ ...REFRESH_GRANT, ...change })), 400, error);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H15b: result mapping', () => {
  it.each([
    ['invalid_grant', 400, 'invalid_grant'],
    ['invalid_request', 400, 'invalid_request'],
  ])('database %s → %s %s', async (code, status, error) => {
    mockRpc.mockResolvedValue({ data: refusal(code), error: null });
    await expectError(await post(form(CODE_GRANT)), status, error);
  });

  it('database rate_limited → 429 invalid_request with Retry-After 60', async () => {
    mockRpc.mockResolvedValue({ data: refusal('rate_limited'), error: null });
    const res = await post(form(CODE_GRANT));
    await expectError(res, 429, 'invalid_request');
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it.each([
    ['a fetch failure', { data: null, error: postgrestFetchError(PLANTED_PLAIN).error }],
    ['a timeout', { data: null, error: postgrestTimeoutError(PLANTED_PLAIN).error }],
    ['an abort', { data: null, error: postgrestAbortError(PLANTED_PLAIN).error }],
    ['ok as a string', { data: { ...tokenOk(), ok: 'true' }, error: null }],
    ['ok without expires_in', { data: { ok: true, token_type: 'Bearer', scope: 'mcp:read' }, error: null }],
    ['expires_in zero', { data: { ...tokenOk(), expires_in: 0 }, error: null }],
    ['expires_in not an integer', { data: { ...tokenOk(), expires_in: 1.5 }, error: null }],
    ['expires_in a string', { data: { ...tokenOk(), expires_in: '3600' }, error: null }],
    ['token_type lowercase', { data: { ...tokenOk(), token_type: 'bearer' }, error: null }],
    ['scope missing', { data: { ok: true, token_type: 'Bearer', expires_in: 3600 }, error: null }],
    ['an unknown code', { data: refusal('access_denied'), error: null }],
    ['null data', { data: null, error: null }],
  ])('%s → 503 temporarily_unavailable, never invalid_grant', async (_l, reply) => {
    mockRpc.mockResolvedValue(reply);
    const res = await post(form(CODE_GRANT));
    await expectError(res, 503, 'temporarily_unavailable');
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('a thrown database call → 503 temporarily_unavailable', async () => {
    mockRpc.mockRejectedValue(new TypeError(PLANTED_PLAIN));
    await expectError(await post(form(CODE_GRANT)), 503, 'temporarily_unavailable');
  });
});

describe('a request on a host other than MCP_PUBLIC_ORIGIN', () => {
  const OTHER_HOST = 'https://other-host.test';

  it.each([
    ['authorization_code', CODE_GRANT, 'mcp_exchange_code'],
    ['refresh_token', REFRESH_GRANT, 'mcp_refresh'],
  ])('%s: the configured resource is accepted and sent', async (_l, grant, fn) => {
    const res = await post(form({ ...grant, resource: RESOURCE }), { url: `${OTHER_HOST}/oauth/token` });
    expect(wireArgs(fn).p_resource).toBe(RESOURCE);
    expect(res.status).toBe(200);
  });

  it('a resource on the request host → 400 invalid_target, no database call', async () => {
    const res = await post(form({ ...CODE_GRANT, resource: `${OTHER_HOST}/api/mcp` }), { url: `${OTHER_HOST}/oauth/token` });
    await expectError(res, 400, 'invalid_target');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H27b: methods', () => {
  it('the module exports HEAD', () => {
    expect(typeof token.HEAD).toBe('function');
  });

  it.each(['HEAD', 'GET'] as const)('%s → 405 with Allow: POST, no database call', async (method) => {
    const res = await post('', { method });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('H16b: logging and the route-level catch', () => {
  const PLANTED_VERIFIER = `${PLANTED_PLAIN}${'v'.repeat(43 - PLANTED_PLAIN.length)}`;

  it('one log line: allowlisted names, other names counted, the grant; no value', async () => {
    const body = `${form({ ...CODE_GRANT, code_verifier: PLANTED_VERIFIER, state: PLANTED_PLAIN })}&${PLANTED_KPR}&${PLANTED_PLAIN}=1`;
    const res = await post(body);
    expect(res.status).toBe(200);
    const { access_token: at, refresh_token: rt } = await res.json();
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0].slice('[mcp-oauth] '.length));
    expect(o).toMatchObject({
      route: 'token',
      outcome: 'issued',
      status: 200,
      grant: 'authorization_code',
      keys: ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'],
      otherKeys: 3,
    });
    for (const v of [PLANTED_PLAIN, PLANTED_KPR, CODE, at, rt, CLIENT_ID, REDIRECT_URI, PORTAL_SECRET]) {
      expect(lines[0]).not.toContain(v);
    }
  });

  it('refusals and a refresh write no value', async () => {
    await post(form({ ...REFRESH_GRANT, client_id: `kpr_c_${PLANTED_PLAIN}` }));
    await post(form({ ...REFRESH_GRANT, refresh_token: `kpr_rt_${PLANTED_PLAIN}` }));
    await post(form(REFRESH_GRANT));
    const lines = cap.lines();
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).not.toContain(PLANTED_PLAIN);
      expect(l).not.toContain(REFRESH);
    }
    expect(JSON.parse(lines[2].slice('[mcp-oauth] '.length)).grant).toBe('refresh_token');
  });

  it('an unknown grant is logged as other', async () => {
    await post(form({ ...CODE_GRANT, grant_type: PLANTED_PLAIN }));
    const o = JSON.parse(cap.lines()[0].slice('[mcp-oauth] '.length));
    expect(o.grant).toBe('other');
    expect(cap.lines()[0]).not.toContain(PLANTED_PLAIN);
  });

  it('a handler that throws → static 503 JSON; Sentry gets the static message only', async () => {
    jest.spyOn(cryptoModule, 'newToken').mockImplementation(() => {
      throw new Error(`${PLANTED_KPR} ${PLANTED_PLAIN}`);
    });
    await expectError(await post(form(CODE_GRANT)), 503, 'temporarily_unavailable');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith('mcp-oauth route error', {
      level: 'error',
      tags: { route: 'token', error_name: 'Other' },
    });
    for (const l of cap.lines()) {
      expect(l).not.toContain(PLANTED_PLAIN);
      expect(l).not.toContain(PLANTED_KPR);
    }
  });
});
