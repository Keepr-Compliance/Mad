/**
 * @jest-environment node
 *
 * BACKLOG-4237 / BACKLOG-4238 — /api/mcp: kill switch, method, Origin, Bearer
 * token shape, the database access check, and the get_status tool over both
 * protocol eras. Requests are driven by the real @modelcontextprotocol/client
 * where a protocol exchange is needed. The database is a mocked rpc client.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ACCESS_TOKEN, UNKNOWN_ACCESS_TOKEN, checkAccessOk, expectedDigest, getStatusOk } from './fixtures';

const mockRpc = jest.fn();
/** Every property read on the client's `auth` object (a Supabase JWT check would read one). */
const mockAuthReads: string[] = [];
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...a: unknown[]) => mockRpc(...a),
    auth: new Proxy(
      {},
      {
        get: (_t, prop) => {
          mockAuthReads.push(String(prop));
          return async () => ({ data: { claims: { sub: 'x', client_id: 'y' } }, error: null });
        },
      }
    ),
  }),
}));

import * as route from '@/app/api/mcp/route';
import * as prm from '@/app/api/mcp/resource-metadata/route';
import * as serverModule from '@/lib/mcp/server';
import {
  OAUTH_ENV,
  PORTAL_SECRET,
  RESOURCE,
  postgrestAbortError,
  postgrestFetchError,
  postgrestTimeoutError,
  refusal,
} from './oauth/fixtures';

const metadataGET = prm.GET;

const BASE = 'https://portal.test';
const MCP_URL = `${BASE}/api/mcp`;
const ENV = { ...process.env };
const realFetch = global.fetch;
const METADATA = `${BASE}/api/mcp/resource-metadata`;
const CHALLENGE_NO_TOKEN = `Bearer resource_metadata="${METADATA}", scope="mcp:read"`;
const CHALLENGE_INVALID = `Bearer error="invalid_token", resource_metadata="${METADATA}", scope="mcp:read"`;

const KNOWN_DIGEST = expectedDigest(ACCESS_TOKEN);

/** The tool error texts an AI app is shown (plan section m, M-S1..M-S4), written out here on purpose. */
const STATUS_MESSAGES = {
  not_connected: 'This connection was removed. Reconnect Keepr in your AI app.',
  disabled: 'Keepr AI access is turned off right now.',
  rate_limited: 'Too many requests. Try again in a minute.',
  unavailable: 'Keepr could not answer. Try again.',
};

/** A database that answers ok to any arguments, so an argument assertion is what fails. */
function acceptAnything() {
  mockRpc.mockImplementation(async (fn: string) => ({ data: fn === 'mcp_check_access' ? checkAccessOk() : getStatusOk(), error: null }));
}

/** The database: answers for the known token digest, with the portal secret and this resource. */
function dbAnswer(fn: string, args: Record<string, unknown>) {
  const known = args.p_secret === PORTAL_SECRET && args.p_at_digest === KNOWN_DIGEST && args.p_resource === RESOURCE;
  if (fn === 'mcp_check_access') return { data: known ? checkAccessOk() : refusal('not_connected'), error: null };
  if (fn === 'mcp_get_status') return { data: known ? getStatusOk() : refusal('not_connected'), error: null };
  return { data: null, error: { message: 'unexpected function', code: 'PGRST202' } };
}

beforeAll(() => {
  global.fetch = (() => {
    throw new Error('network access in a test');
  }) as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
  process.env = ENV;
});

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV, MCP_PUBLIC_ORIGIN: BASE };
  delete process.env.MCP_ALLOWED_ORIGINS;
  mockAuthReads.length = 0;
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => dbAnswer(fn, args));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const rpcCalls = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/** Routes a fetch from the MCP client into the route module. */
async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  switch (req.method) {
    case 'POST':
      return route.POST(req);
    case 'GET':
      return route.GET(req);
    case 'DELETE':
      return route.DELETE(req);
    default:
      return route.PUT(req);
  }
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
}

function post(headers: Record<string, string> = {}, url = MCP_URL): Promise<Response> {
  return route.POST(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: initializeBody(),
    })
  );
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function connect(mode: 'legacy' | { pin: string }, token = ACCESS_TOKEN, url = MCP_URL) {
  const client = new Client({ name: 'keepr-test-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: routeFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text: string }> }).content[0].text;
}

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((k) => k.toLowerCase().startsWith('access-control-'));
}

describe('A1: no Authorization header', () => {
  it('returns 401 with WWW-Authenticate naming the resource metadata address and the scope', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_NO_TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(['Basic abc', 'Bearer', 'Bearer ', 'bearer'])('a malformed header %p is treated as absent (401, no error)', async (h) => {
    const res = await post({ authorization: h });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_NO_TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('positive: an access token the database accepts lists get_status', async () => {
    const client = await connect('legacy');
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['get_status']);
    await client.close();
  });

  it('the resource metadata names this resource and this portal as the issuer', async () => {
    const res = await metadataGET(new Request(METADATA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: MCP_URL,
      authorization_servers: [BASE],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Keepr',
    });
  });
});

describe('C28: only kpr_at_ tokens reach the database', () => {
  const JWT_SHAPED = `${'a'.repeat(20)}.${'b'.repeat(40)}.${'c'.repeat(43)}`;
  it.each([
    ['a JWT-shaped token', JWT_SHAPED],
    ['a refresh token', `kpr_rt_${'R'.repeat(43)}`],
    ['an authorization code', `kpr_ac_${'C'.repeat(43)}`],
    ['a browser binding', `kpr_bd_${'B'.repeat(43)}`],
    ['42 characters', `kpr_at_${'T'.repeat(42)}`],
    ['44 characters', `kpr_at_${'T'.repeat(44)}`],
    ['a character outside base64url', `kpr_at_${'T'.repeat(42)}+`],
    ['an upper-case prefix', `KPR_AT_${'T'.repeat(43)}`],
  ])('%s gets 401 invalid_token and no database call', async (_label, token) => {
    const res = await post(bearer(token));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_INVALID);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAuthReads).toEqual([]);
  });

  it('positive: a kpr_at_ token reaches the access check', async () => {
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(200);
    expect(rpcCalls('mcp_check_access')).toHaveLength(1);
    expect(mockAuthReads).toEqual([]);
  });
});

describe('C29: the digest of the whole token, with the pepper, reaches both database functions', () => {
  it('mcp_check_access gets exactly the portal secret, the digest and the configured resource', async () => {
    acceptAnything();
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(200);
    const [[fn, args]] = mockRpc.mock.calls;
    expect(fn).toBe('mcp_check_access');
    expect(args).toEqual({ p_secret: PORTAL_SECRET, p_at_digest: KNOWN_DIGEST, p_resource: RESOURCE });
  });

  it.each([['legacy' as const], [{ pin: '2026-07-28' }]])('get_status (%p) sends the same digest to mcp_get_status', async (mode) => {
    const client = await connect(mode);
    await client.callTool({ name: 'get_status', arguments: {} });
    await client.close();
    const calls = rpcCalls('mcp_get_status');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ p_secret: PORTAL_SECRET, p_at_digest: KNOWN_DIGEST, p_resource: RESOURCE });
  });

  it('a well-formed token the database does not know gets 401 invalid_token', async () => {
    const res = await post(bearer(UNKNOWN_ACCESS_TOKEN));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_INVALID);
    expect(rpcCalls('mcp_check_access')[0][1].p_at_digest).toBe(expectedDigest(UNKNOWN_ACCESS_TOKEN));
  });
});

describe('C30: not_connected is 401; any database failure is 503, never 401', () => {
  it('not_connected → 401 with error, resource_metadata and scope', async () => {
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    const res = await post(bearer(ACCESS_TOKEN));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_INVALID);
  });

  it.each([
    ['a fetch failure', () => postgrestFetchError('x')],
    ['a timeout', () => postgrestTimeoutError('x')],
    ['an aborted request', () => postgrestAbortError('x')],
    ['a PostgREST error', () => ({ data: null, error: { message: 'm', details: '', hint: '', code: 'PGRST202' } })],
    ['a SQL error', () => ({ data: null, error: { message: 'm', details: '', hint: '', code: '57014' } })],
  ])('%s → 503 with Retry-After and no challenge', async (_label, answer) => {
    mockRpc.mockResolvedValueOnce(answer());
    const res = await post(bearer(ACCESS_TOKEN));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('a client that throws → 503 with Retry-After', async () => {
    mockRpc.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await post(bearer(ACCESS_TOKEN));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
  });
});

describe('C38: access needs exactly {ok: true}', () => {
  it.each([
    ['ok "true"', { ok: 'true' }],
    ['ok 1', { ok: 1 }],
    ['empty object', {}],
    ['an extra key', { ok: true, user_id: 'x' }],
    ['another refusal code', { ok: false, error: 'disabled' }],
    ['not_connected with an extra key', { ok: false, error: 'not_connected', x: 1 }],
    ['an array', [{ ok: true }]],
    ['a string', 'ok'],
    ['null', null],
  ])('%s → 503, not access and not 401', async (_label, data) => {
    mockRpc.mockResolvedValueOnce({ data, error: null });
    const res = await post(bearer(ACCESS_TOKEN));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
  });
});

describe('C31: configuration', () => {
  it.each([
    ['MCP_TOKEN_PEPPER', undefined],
    ['MCP_TOKEN_PEPPER', 'too-short'],
    ['MCP_PORTAL_SECRET', undefined],
    ['NEXT_PUBLIC_SUPABASE_URL', undefined],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined],
  ])('%s=%p → 503 and no database call', async (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    const res = await post(bearer(ACCESS_TOKEN));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('C32: get_status answers from the database', () => {
  async function callStatus(mode: 'legacy' | { pin: string } = 'legacy') {
    const client = await connect(mode);
    const result = await client.callTool({ name: 'get_status', arguments: {} });
    await client.close();
    return result;
  }

  it('a 2025-era client gets the database fields plus the protocol and server versions', async () => {
    const result = await callStatus('legacy');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      connected: true,
      provider: 'anthropic',
      entitled: true,
      reason: null,
      protocolVersion: '2025-11-25',
      serverVersion: '0.1.0',
    });
  });

  it('a 2026-07-28 client gets the same with its protocol version', async () => {
    const result = await callStatus({ pin: '2026-07-28' });
    expect(result.structuredContent).toEqual({
      connected: true,
      provider: 'anthropic',
      entitled: true,
      reason: null,
      protocolVersion: '2026-07-28',
      serverVersion: '0.1.0',
    });
  });

  it('a not-entitled answer is passed through with its reason', async () => {
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'mcp_get_status' ? { data: getStatusOk(false, 'no_license'), error: null } : dbAnswer(fn, args)
    );
    const status = JSON.parse(textOf(await callStatus()));
    expect(status).toMatchObject({ connected: true, entitled: false, reason: 'no_license' });
  });

  it.each([
    ['not_connected', STATUS_MESSAGES.not_connected],
    ['disabled', STATUS_MESSAGES.disabled],
    ['rate_limited', STATUS_MESSAGES.rate_limited],
    ['busy', STATUS_MESSAGES.unavailable],
    ['timeout', STATUS_MESSAGES.unavailable],
    ['error', STATUS_MESSAGES.unavailable],
    ['something_new', STATUS_MESSAGES.unavailable],
  ])('refusal %s → a tool error with fixed text', async (code, text) => {
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'mcp_get_status' ? { data: refusal(code), error: null } : dbAnswer(fn, args)
    );
    const result = await callStatus();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(text);
  });

  it.each([
    ['an unknown provider', { ok: true, result: { connected: true, provider: 'other', entitled: true, reason: null } }],
    ['an extra result key', { ok: true, result: { ...getStatusOk().result, user_id: 'x' } }],
    ['an extra top-level key', { ...getStatusOk(), x: 1 }],
    ['a missing reason', { ok: true, result: { connected: true, provider: 'anthropic', entitled: true } }],
    ['entitled as a string', { ok: true, result: { connected: true, provider: 'anthropic', entitled: 'true', reason: null } }],
    ['a reason with spaces', getStatusOk(false, 'not entitled')],
    ['a reason of 65 characters', getStatusOk(false, 'a'.repeat(65))],
    ['connected false', { ok: true, result: { connected: false, provider: 'anthropic', entitled: true, reason: null } }],
    ['ok "true"', { ...getStatusOk(), ok: 'true' }],
    ['a transport error', null],
  ])('%s → a tool error, never a status', async (_label, data) => {
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'mcp_get_status'
        ? data === null
          ? postgrestFetchError('x')
          : { data, error: null }
        : dbAnswer(fn, args)
    );
    const result = await callStatus();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(STATUS_MESSAGES.unavailable);
  });

  it('the tool answers with HTTP 200 when the database refuses', async () => {
    mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === 'mcp_get_status' ? { data: refusal('disabled'), error: null } : dbAnswer(fn, args)
    );
    const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const statuses: number[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: async (i, init) => {
        const r = await routeFetch(i as string, init);
        statuses.push(r.status);
        return r;
      },
      requestInit: { headers: bearer(ACCESS_TOKEN) },
    });
    await client.connect(transport);
    await client.callTool({ name: 'get_status', arguments: {} });
    await client.close();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});

describe('C33: resource, authInfo and order', () => {
  it('a request on another host still checks access for the configured resource', async () => {
    acceptAnything();
    const client = await connect('legacy', ACCESS_TOKEN, 'https://other-host.test/api/mcp');
    await client.callTool({ name: 'get_status', arguments: {} });
    await client.close();
    expect(rpcCalls('mcp_check_access').length).toBeGreaterThan(0);
    expect(rpcCalls('mcp_check_access').every(([, a]) => a.p_resource === RESOURCE)).toBe(true);
    expect(rpcCalls('mcp_get_status')).toHaveLength(1);
    expect(rpcCalls('mcp_get_status')[0][1].p_resource).toBe(RESOURCE);
  });

  it('the 401 names MCP_PUBLIC_ORIGIN, not the request Host', async () => {
    const res = await post({}, 'https://other-host.test/api/mcp');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_NO_TOKEN);
  });

  it('the SDK gets an authInfo with no raw token, scope mcp:read and the digest in extra', async () => {
    const real = serverModule.getMcpHandler();
    const seen: unknown[] = [];
    jest.spyOn(serverModule, 'getMcpHandler').mockReturnValue({
      ...real,
      fetch: (req: Request, opts?: { authInfo?: unknown }) => {
        seen.push(opts?.authInfo);
        return real.fetch(req, opts as Parameters<typeof real.fetch>[1]);
      },
    } as typeof real);
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(200);
    expect(seen).toEqual([{ token: '', clientId: '', scopes: ['mcp:read'], extra: { atDigest: KNOWN_DIGEST } }]);
    expect(JSON.stringify(seen)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(seen)).not.toContain('T'.repeat(43));
  });

  it('the Origin check runs before the token check (valid token, foreign Origin → 403, no database call)', async () => {
    const res = await post({ origin: 'https://evil.example', ...bearer(ACCESS_TOKEN) });
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a foreign Origin with no token is 403, not 401', async () => {
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('A3: Origin', () => {
  it.each(['https://evil.example', 'null', 'https://portal.test'])(
    'Origin %p with an empty allowlist gets 403 and no CORS header',
    async (origin) => {
      const res = await post({ origin, ...bearer(ACCESS_TOKEN) });
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
    }
  );

  it.each([
    'https://allowed.example.evil.test',
    'https://evil.test.allowed.example',
    'https://allowed.example:8443',
    'http://allowed.example',
    'https://allowed.example/',
  ])('look-alike %p of an allow-listed origin gets 403', async (origin) => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://allowed.example';
    const res = await post({ origin, ...bearer(ACCESS_TOKEN) });
    expect(res.status).toBe(403);
    expect(corsHeaders(res)).toEqual([]);
  });

  it('positive: an exactly allow-listed origin passes', async () => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://other.example, https://allowed.example';
    const res = await post({ origin: 'https://allowed.example', ...bearer(ACCESS_TOKEN) });
    expect(res.status).toBe(200);
  });

  it('positive: no Origin header passes', async () => {
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(200);
  });
});

describe('A4: POST only', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('%s returns 405 with Allow: POST', async (m) => {
    const res = await route[m](new Request(MCP_URL, { method: m }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('GET with a valid token and an SSE accept header is still 405, with no database call', async () => {
    const res = await route.GET(
      new Request(MCP_URL, { method: 'GET', headers: { ...bearer(ACCESS_TOKEN), accept: 'text/event-stream' } })
    );
    expect(res.status).toBe(405);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('A5: both protocol eras, stateless', () => {
  it('a 2025-era client initializes, then lists get_status with its annotations', async () => {
    const client = await connect('legacy');
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: 'get_status',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    await client.close();
  });

  it('a 2026-07-28 client lists get_status with no initialize', async () => {
    const client = await connect({ pin: '2026-07-28' });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['get_status']);
    await client.close();
  });

  it('an unknown tool is an error result with no get_status call', async () => {
    const client = await connect({ pin: '2026-07-28' });
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
    expect(rpcCalls('mcp_get_status')).toEqual([]);
  });

  it('every HTTP request of a session is checked against the database', async () => {
    const client = await connect('legacy');
    await client.listTools();
    await client.close();
    const posts = rpcCalls('mcp_check_access').length;
    expect(posts).toBeGreaterThanOrEqual(2);
  });
});

describe('A8: MCP_ENABLED kill switch', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', '1', 'yes'])('MCP_ENABLED=%p: every method and the metadata route are 404', async (value) => {
    if (value === undefined) delete process.env.MCP_ENABLED;
    else process.env.MCP_ENABLED = value;
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(404);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(404);
    expect((await route.GET(new Request(MCP_URL))).status).toBe(404);
    expect((await route.DELETE(new Request(MCP_URL, { method: 'DELETE' }))).status).toBe(404);
    expect((await route.OPTIONS(new Request(MCP_URL, { method: 'OPTIONS' }))).status).toBe(404);
    expect((await metadataGET(new Request(METADATA))).status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'http://portal.test', 'https://portal.test/path', 'not a url'])(
    'MCP_ENABLED=true with MCP_PUBLIC_ORIGIN=%p: every method and the metadata route are 404',
    async (value) => {
      if (value === undefined) delete process.env.MCP_PUBLIC_ORIGIN;
      else process.env.MCP_PUBLIC_ORIGIN = value;
      expect((await post(bearer(ACCESS_TOKEN))).status).toBe(404);
      expect((await post()).status).toBe(404);
      expect((await route.GET(new Request(MCP_URL))).status).toBe(404);
      expect((await metadataGET(new Request(METADATA))).status).toBe(404);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  );

  it('positive: MCP_ENABLED=true gives 401 without a token and 200 with one', async () => {
    expect((await post()).status).toBe(401);
    expect((await post(bearer(ACCESS_TOKEN))).status).toBe(200);
  });
});

/** Every route handler this endpoint exports, with the status it gives when MCP_ENABLED=true. */
const SURFACES: Array<[string, number, () => Promise<Response> | Response]> = [
  ['POST /api/mcp', 200, () => post(bearer(ACCESS_TOKEN))],
  ['GET /api/mcp', 405, () => route.GET(new Request(MCP_URL))],
  ['PUT /api/mcp', 405, () => route.PUT(new Request(MCP_URL, { method: 'PUT' }))],
  ['PATCH /api/mcp', 405, () => route.PATCH(new Request(MCP_URL, { method: 'PATCH' }))],
  ['DELETE /api/mcp', 405, () => route.DELETE(new Request(MCP_URL, { method: 'DELETE' }))],
  ['OPTIONS /api/mcp', 405, () => route.OPTIONS(new Request(MCP_URL, { method: 'OPTIONS' }))],
  ['GET /api/mcp/resource-metadata', 200, () => metadataGET(new Request(METADATA))],
  ['HEAD /api/mcp/resource-metadata', 200, () => prm.HEAD(new Request(METADATA, { method: 'HEAD' }))],
  ['POST /api/mcp/resource-metadata', 405, () => prm.POST(new Request(METADATA, { method: 'POST' }))],
  ['PUT /api/mcp/resource-metadata', 405, () => prm.PUT(new Request(METADATA, { method: 'PUT' }))],
  ['PATCH /api/mcp/resource-metadata', 405, () => prm.PATCH(new Request(METADATA, { method: 'PATCH' }))],
  ['DELETE /api/mcp/resource-metadata', 405, () => prm.DELETE(new Request(METADATA, { method: 'DELETE' }))],
  ['OPTIONS /api/mcp/resource-metadata', 405, () => prm.OPTIONS(new Request(METADATA, { method: 'OPTIONS' }))],
];

describe('A8: each surface with MCP_ENABLED unset', () => {
  it('lists every exported handler of both routes', () => {
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    const exported = [
      ...methods.filter((m) => typeof (route as Record<string, unknown>)[m] === 'function').map((m) => `${m} /api/mcp`),
      ...methods.filter((m) => typeof (prm as Record<string, unknown>)[m] === 'function').map((m) => `${m} /api/mcp/resource-metadata`),
    ];
    expect(SURFACES.map(([name]) => name).sort()).toEqual(exported.sort());
  });

  it.each(SURFACES)('%s is 404 and makes no database call', async (_name, _status, call) => {
    delete process.env.MCP_ENABLED;
    expect((await call()).status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(SURFACES)('positive: %s with MCP_ENABLED=true is %p', async (_name, status, call) => {
    expect((await call()).status).toBe(status);
  });
});

describe('C33: the route log line', () => {
  it.each([
    ['ok', () => post(bearer(ACCESS_TOKEN)), 200],
    ['no_token', () => post(), 401],
    ['bad_token_shape', () => post(bearer(`kpr_rt_${'R'.repeat(43)}`)), 401],
    ['not_connected', () => post(bearer(UNKNOWN_ACCESS_TOKEN)), 401],
    ['forbidden_origin', () => post({ origin: 'https://evil.example' }), 403],
  ])('outcome %s is logged once with route mcp and no token', async (outcome, call, status) => {
    const warn = console.warn as jest.Mock;
    await call();
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.startsWith('[mcp-oauth]'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice('[mcp-oauth] '.length))).toEqual({ route: 'mcp', outcome, status, ms: expect.any(Number) });
    expect(lines[0]).not.toContain('T'.repeat(43));
  });
});
