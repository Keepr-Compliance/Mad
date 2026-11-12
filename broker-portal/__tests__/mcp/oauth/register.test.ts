/**
 * @jest-environment node
 *
 * BACKLOG-4238 — POST /oauth/register (RFC 7591): request checks, the database
 * call, the result mapping, logging and the route-level catch.
 * Controls H6, H15a, H16a, H16e, H23 (plan-pr2-rev1 section f).
 */

const mockRpc = jest.fn();
const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...a: unknown[]) => {
    mockCreateClient(...a);
    return { rpc: (...r: unknown[]) => mockRpc(...r) };
  },
}));
const mockCapture = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import * as register from '@/app/oauth/register/route';
import * as cryptoModule from '@/lib/mcp/oauth/crypto';
import { ipDigest, toBytea } from '@/lib/mcp/oauth/crypto';
import { clientIp } from '@/lib/mcp/oauth/clientIp';
import {
  blockNetwork,
  captureConsole,
  OAUTH_ENV,
  ORIGIN,
  PEPPER_BYTES,
  PLANTED_KPR,
  PLANTED_PLAIN,
  PORTAL_SECRET,
  postgrestAbortError,
  postgrestFetchError,
  REDIRECT_URI,
  refusal,
  registerOk,
} from './fixtures';

const URL_ = `${ORIGIN}/oauth/register`;
const ENV = { ...process.env };
blockNetwork();

let consoleCap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  mockCreateClient.mockReset();
  mockCapture.mockReset();
  mockRpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({
    data: registerOk(args.p_client_id as string, args.p_client_name as string, args.p_redirect_uris as string[]),
    error: null,
  }));
  consoleCap = captureConsole();
});
afterEach(() => consoleCap.restore());
afterAll(() => {
  process.env = ENV;
});

function post(body: unknown, opts: { url?: string; headers?: Record<string, string>; raw?: string } = {}) {
  return register.POST(
    new Request(opts.url ?? URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: opts.raw ?? JSON.stringify(body),
    })
  );
}

const GOOD = { redirect_uris: [REDIRECT_URI], client_name: 'Example client' };

describe('H6: request checks', () => {
  it('positive: a minimal body registers (201)', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it.each(['?x=1', `?refresh_token=${PLANTED_PLAIN}`, '?'])('a query string %p is refused with no database call', async (q) => {
    const res = await post(GOOD, { url: `${URL_}${q}` });
    if (q === '?') {
      // a bare '?' is an empty query
      expect(res.status).toBe(201);
      return;
    }
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain', JSON.stringify(GOOD)],
    ['application/x-www-form-urlencoded', 'redirect_uris=x'],
    ['application/jsonx', JSON.stringify(GOOD)],
  ])('content type %p is refused', async (ct, raw) => {
    const res = await post(null, { headers: { 'content-type': ct }, raw });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client_metadata' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('application/json with a charset passes', async () => {
    expect((await post(GOOD, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(201);
  });

  it.each([
    ['not JSON', `{"redirect_uris": [${PLANTED_PLAIN}`],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['over 16 KiB', JSON.stringify({ ...GOOD, pad: 'x'.repeat(16 * 1024) })],
  ])('a body that is %s is refused with no database call', async (_label, raw) => {
    const res = await post(null, { raw });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client_metadata' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a body of exactly 16 KiB passes the size check', async () => {
    const base = JSON.stringify({ ...GOOD, pad: '' });
    const raw = JSON.stringify({ ...GOOD, pad: 'x'.repeat(16 * 1024 - base.length) });
    expect(Buffer.byteLength(raw)).toBe(16 * 1024);
    expect((await post(null, { raw })).status).toBe(201);
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['four', [REDIRECT_URI, REDIRECT_URI, REDIRECT_URI, REDIRECT_URI]],
    ['http', ['http://client.example/callback']],
    ['fragment', [`${REDIRECT_URI}#x`]],
    ['userinfo', ['https://user:pw@client.example/callback']],
    ['not a URL', ['not a url']],
    ['not a string', [42]],
    ['too long', [`https://client.example/${'a'.repeat(2000)}`]],
    ['a string, not an array', REDIRECT_URI],
  ])('redirect_uris %s → invalid_redirect_uri, no database call', async (_label, uris) => {
    const res = await post({ ...GOOD, redirect_uris: uris });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['grant_types', ['client_credentials']],
    ['grant_types', 'authorization_code'],
    ['grant_types', ['authorization_code', 'implicit']],
    ['response_types', ['token']],
    ['client_name', ''],
    ['client_name', 'x'.repeat(101)],
    ['client_name', 'tab\there'],
    ['client_name', 'nul\u0000'],
    ['client_name', 'c1\u0085'],
    ['client_name', 42],
    ['client_name', null],
  ])('%s = %p → invalid_client_metadata, no database call', async (field, value) => {
    const res = await post({ ...GOOD, [field]: value });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_client_metadata' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a 100-character name with astral characters passes (counted in code points)', async () => {
    const name = '\u{1F600}'.repeat(100);
    expect((await post({ ...GOOD, client_name: name })).status).toBe(201);
    expect(mockRpc.mock.calls[0][1].p_client_name).toBe(name);
  });

  it('accepted grant and response types pass', async () => {
    const res = await post({ ...GOOD, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(res.status).toBe(201);
  });

  it('a missing client_name becomes the host of the first redirect URI', async () => {
    await post({ redirect_uris: ['https://cb.example:8443/x', REDIRECT_URI] });
    expect(mockRpc.mock.calls[0][1].p_client_name).toBe('cb.example:8443');
  });

  it.each(['client_secret_basic', 'client_secret_post', 'private_key_jwt', 42])(
    'token_endpoint_auth_method %p is answered as none, with no secret',
    async (method) => {
      const res = await post({ ...GOOD, token_endpoint_auth_method: method });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body).not.toHaveProperty('client_secret');
      expect(body).not.toHaveProperty('client_secret_expires_at');
    }
  );

  it('sends exactly the five named arguments; client id and address digest have the fixed shapes', async () => {
    await post(GOOD, { headers: { 'x-vercel-forwarded-for': '203.0.113.7' } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('mcp_register_client');
    expect(Object.keys(args).sort()).toEqual(['p_client_id', 'p_client_name', 'p_ip_sha256', 'p_redirect_uris', 'p_secret']);
    expect(args.p_secret).toBe(PORTAL_SECRET);
    expect(args.p_client_id).toMatch(/^kpr_c_[A-Za-z0-9_-]{22}$/);
    expect(args.p_client_name).toBe('Example client');
    expect(args.p_redirect_uris).toEqual([REDIRECT_URI]);
    expect(args.p_ip_sha256).toMatch(/^\\x[0-9a-f]{64}$/);
    expect((args.p_ip_sha256 as string).length).toBe(66);
    expect(args.p_ip_sha256).toBe('\\xee6f9612bd55af19581fb91675a14447ba26035f8c4a528dfbb840166be10c84');
    expect(JSON.stringify(args)).not.toContain('203.0.113.7');
  });

  it('two registrations get different client ids', async () => {
    await post(GOOD);
    await post(GOOD);
    expect(mockRpc.mock.calls[0][1].p_client_id).not.toBe(mockRpc.mock.calls[1][1].p_client_id);
  });

  it('the database client is a bare anon client with no session and a fetch wrapper', async () => {
    await post(GOOD);
    const [url, key, opts] = mockCreateClient.mock.calls[0];
    expect(url).toBe(OAUTH_ENV.NEXT_PUBLIC_SUPABASE_URL);
    expect(key).toBe(OAUTH_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    expect(opts.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(typeof opts.global.fetch).toBe('function');
  });

  it('the fetch wrapper always passes a timeout signal and keeps the caller signal', async () => {
    await post(GOOD);
    const wrapped = mockCreateClient.mock.calls[0][2].global.fetch as typeof fetch;
    const seen: Array<AbortSignal | null | undefined> = [];
    const blocked = global.fetch;
    global.fetch = (async (_i: unknown, init?: { signal?: AbortSignal | null }) => {
      seen.push(init?.signal);
      return new Response('{}');
    }) as typeof fetch;
    try {
      await wrapped('https://project-ref.supabase.co/rest/v1/rpc/x', { method: 'POST' });
      const caller = new AbortController();
      await wrapped('https://project-ref.supabase.co/rest/v1/rpc/x', { method: 'POST', signal: caller.signal });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0]!.aborted).toBe(false);
      expect(seen[1]).not.toBe(caller.signal);
      caller.abort();
      expect(seen[1]!.aborted).toBe(true);
    } finally {
      global.fetch = blocked;
    }
  });

  it('the response echoes no unknown field', async () => {
    const res = await post({ ...GOOD, logo_uri: `https://x.example/${PLANTED_PLAIN}`, jwks: { k: PLANTED_PLAIN } });
    const text = await res.text();
    expect(text).not.toContain(PLANTED_PLAIN);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      'client_id',
      'client_id_issued_at',
      'client_name',
      'grant_types',
      'redirect_uris',
      'response_types',
      'scope',
      'token_endpoint_auth_method',
    ]);
  });
});

describe('H15a: database result mapping', () => {
  it('success → 201 with the registered fields and no-store', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const body = await res.json();
    expect(body).toMatchObject({
      client_name: 'Example client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:read',
    });
    expect(body.client_id).toBe(mockRpc.mock.calls[0][1].p_client_id);
    expect(Number.isInteger(body.client_id_issued_at)).toBe(true);
  });

  it.each([
    ['invalid_client_metadata', 400, { error: 'invalid_client_metadata' }, null],
    ['invalid_redirect_uri', 400, { error: 'invalid_redirect_uri' }, null],
    ['rate_limited', 429, { error: 'temporarily_unavailable' }, '3600'],
    ['busy', 503, { error: 'temporarily_unavailable' }, '1'],
  ])('refusal %s → %i', async (code, status, body, retryAfter) => {
    mockRpc.mockResolvedValueOnce({ data: refusal(code), error: null });
    const res = await post(GOOD);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get('retry-after')).toBe(retryAfter);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['fetch failure (returned)', () => Promise.resolve(postgrestFetchError(PLANTED_PLAIN))],
    ['timeout (returned)', () => Promise.resolve(postgrestAbortError(PLANTED_PLAIN))],
    ['thrown TypeError', () => Promise.reject(new TypeError(`fetch failed ${PLANTED_PLAIN}`))],
    ['thrown AbortError', () => Promise.reject(Object.assign(new Error(`aborted ${PLANTED_PLAIN}`), { name: 'AbortError' }))],
    ['{ok:"true"}', () => Promise.resolve({ data: { ok: 'true', client_id: 'x', client_name: 'x', redirect_uris: [] }, error: null })],
    ['ok with a missing field', () => Promise.resolve({ data: { ok: true, client_id: 'x', redirect_uris: [] }, error: null })],
    ['ok with a non-string redirect', () => Promise.resolve({ data: { ok: true, client_id: 'x', client_name: 'x', redirect_uris: [1] }, error: null })],
    ['an unknown code', () => Promise.resolve({ data: refusal('invalid_grant'), error: null })],
    ['ok:false with no code', () => Promise.resolve({ data: { ok: false }, error: null })],
    ['null data', () => Promise.resolve({ data: null, error: null })],
    ['an array', () => Promise.resolve({ data: [], error: null })],
  ])('%s → 503 temporarily_unavailable', async (_label, impl) => {
    mockRpc.mockImplementationOnce(impl);
    const res = await post(GOOD);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('H16a: register logs', () => {
  const planted = { kpr: PLANTED_KPR, plain: PLANTED_PLAIN };

  it('planted values in every field reach neither the body nor any console line', async () => {
    // redirect_uris and client_name are echoed on success (RFC 7591 section 3.2.1), so they carry
    // their own marker: absent from every log line and from every refusal body.
    const ECHO = 'echoed-marker-0043';
    const ECHO_KPR = `kpr_ac_${'E'.repeat(43)}`;
    const body = {
      redirect_uris: [`https://client.example/${ECHO}?k=${ECHO_KPR}`],
      client_name: `${ECHO} ${ECHO_KPR}`,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: planted.plain,
      scope: planted.plain,
      client_uri: planted.plain,
      logo_uri: planted.kpr,
      contacts: [planted.plain],
      software_statement: planted.kpr,
      [planted.plain]: planted.plain,
      [planted.kpr]: planted.kpr,
    };
    const statuses: number[] = [];
    for (const variant of ['ok', 'invalid_redirect_uri', 'transport'] as const) {
      if (variant === 'invalid_redirect_uri') mockRpc.mockResolvedValueOnce({ data: refusal('invalid_redirect_uri'), error: null });
      if (variant === 'transport') mockRpc.mockResolvedValueOnce(postgrestFetchError(`${planted.plain} ${planted.kpr}`));
      const res = await post(body);
      statuses.push(res.status);
      const text = await res.text();
      expect(text).not.toContain(planted.plain);
      expect(text).not.toContain(planted.kpr);
      if (res.status !== 201) {
        expect(text).not.toContain(ECHO);
        expect(text).not.toContain(ECHO_KPR);
      } else {
        expect(text).toContain(ECHO); // positive: the echo marker is visible where it belongs
      }
    }
    expect(statuses).toEqual([201, 400, 503]);
    const lines = consoleCap.lines();
    expect(lines.filter((l) => l.startsWith('[mcp-oauth] '))).toHaveLength(3);
    for (const l of lines) {
      expect(l).not.toContain(planted.plain);
      expect(l).not.toContain(planted.kpr);
      expect(l).not.toContain(ECHO);
      expect(l).not.toContain(ECHO_KPR);
    }
  });

  it('logs only allowlisted key names, sorted, plus a count of the rest', async () => {
    const extra: Record<string, number> = {};
    for (let i = 0; i < 1500; i++) extra[`a${i}`] = 0;
    const body = { ...GOOD, scope: 'x', [PLANTED_PLAIN]: 1, ...extra };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(16 * 1024);
    expect((await post(body)).status).toBe(201);
    const line = consoleCap.lines().find((l) => l.startsWith('[mcp-oauth] '))!;
    const logged = JSON.parse(line.slice('[mcp-oauth] '.length));
    expect(logged).toMatchObject({ route: 'register', outcome: 'registered', status: 201 });
    expect(logged.keys).toEqual(['client_name', 'redirect_uris', 'scope']);
    expect(logged.otherKeys).toBe(1501);
    expect(line).not.toContain(PLANTED_PLAIN);
    expect(line).not.toContain('a1499');
  });

  it('a transport error logs the error name class and code shape only', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: PLANTED_PLAIN, details: PLANTED_PLAIN, hint: PLANTED_PLAIN, code: '57014' } });
    expect((await post(GOOD)).status).toBe(503);
    const line = consoleCap.lines().find((l) => l.startsWith('[mcp-oauth] '))!;
    expect(JSON.parse(line.slice('[mcp-oauth] '.length)).error).toBe('Other:57014');
    expect(line).not.toContain(PLANTED_PLAIN);
  });

  it('a database code of an unknown shape is not logged', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'x', details: '', hint: '', code: PLANTED_PLAIN } });
    await post(GOOD);
    const line = consoleCap.lines().find((l) => l.startsWith('[mcp-oauth] '))!;
    expect(JSON.parse(line.slice('[mcp-oauth] '.length)).error).toBe('Other:none');
  });
});

describe('H16e: the route-level catch', () => {
  function plantThrow(name: string) {
    return jest.spyOn(cryptoModule, 'newClientId').mockImplementationOnce(() => {
      const err = new Error(`boom ${PLANTED_PLAIN} ${PLANTED_KPR}`);
      err.name = name;
      throw err;
    });
  }

  it.each([
    [PLANTED_PLAIN, 'Other'],
    [PLANTED_KPR, 'Other'],
    ['TypeError', 'TypeError'],
    ['RangeError', 'RangeError'],
  ])('a handler throwing an error named %p → static 503; Sentry gets only the static message and tag %p', async (name, tag) => {
    const spy = plantThrow(name);
    let res: Response | undefined;
    await expect(
      (async () => {
        res = await post(GOOD);
      })()
    ).resolves.toBeUndefined();
    spy.mockRestore();
    expect(res!.status).toBe(503);
    expect(await res!.text()).toBe('{"error":"temporarily_unavailable"}');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0]).toEqual([
      'mcp-oauth route error',
      { level: 'error', tags: { route: 'register', error_name: tag } },
    ]);
    const lines = consoleCap.lines();
    expect(lines.some((l) => l.startsWith('[mcp-oauth] ') && l.includes(`"error":"${tag}"`))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(PLANTED_PLAIN);
      expect(l).not.toContain(PLANTED_KPR);
      expect(l).not.toContain('boom');
    }
  });

  it('a throwing Sentry call does not change the answer', async () => {
    const spy = plantThrow('TypeError');
    mockCapture.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    const res = await post(GOOD);
    spy.mockRestore();
    expect(res.status).toBe(503);
  });

  it('positive: without a throw, Sentry is not called', async () => {
    expect((await post(GOOD)).status).toBe(201);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('H23: client address', () => {
  const req = (h: Record<string, string>) => new Request(URL_, { headers: h });

  it('prefers x-vercel-forwarded-for over x-forwarded-for', () => {
    expect(clientIp(req({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))).toBe('203.0.113.7');
  });
  it('falls back to the first x-forwarded-for entry, then unknown', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 198.51.100.9 , 10.0.0.1' }))).toBe('198.51.100.9');
    expect(clientIp(req({}))).toBe('unknown');
  });
  it('the registered digest is of the x-vercel-forwarded-for address', async () => {
    await post(GOOD, { headers: { 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' } });
    expect(mockRpc.mock.calls[0][1].p_ip_sha256).toBe(toBytea(ipDigest(PEPPER_BYTES, '203.0.113.7')));
  });
});

describe('H27a (register): HEAD and other methods', () => {
  it('exports every method explicitly', () => {
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(typeof (register as Record<string, unknown>)[m]).toBe('function');
    }
  });
  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('%s → 405 Allow: POST, no database call', async (m) => {
    const res = await register[m](new Request(URL_, { method: m }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
