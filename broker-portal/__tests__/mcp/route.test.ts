/**
 * @jest-environment node
 *
 * BACKLOG-4237 — /api/mcp: kill switch, method, Origin, Bearer, client_id claim,
 * and the get_status tool over both protocol eras. Requests are driven by the
 * real @modelcontextprotocol/client where a protocol exchange is needed.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  CONNECTED_APP_CLAIMS,
  CONNECTED_APP_TOKEN,
  FIRST_PARTY_CLAIMS,
  FIRST_PARTY_TOKEN,
} from './fixtures';

const mockGetClaims = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getClaims: (t: string) => mockGetClaims(t) } }),
}));

import * as route from '@/app/api/mcp/route';
import { GET as metadataGET } from '@/app/api/mcp/resource-metadata/route';

const BASE = 'https://portal.test';
const MCP_URL = `${BASE}/api/mcp`;
const ENV = { ...process.env };
const realFetch = global.fetch;

const claimsByToken: Record<string, unknown> = {
  [CONNECTED_APP_TOKEN]: CONNECTED_APP_CLAIMS,
  [FIRST_PARTY_TOKEN]: FIRST_PARTY_CLAIMS,
};

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
  process.env = {
    ...ENV,
    MCP_ENABLED: 'true',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture',
  };
  delete process.env.MCP_ALLOWED_ORIGINS;
  delete process.env.MCP_PUBLIC_ORIGIN;
  mockGetClaims.mockReset();
  mockGetClaims.mockImplementation(async (token: string) => {
    const claims = claimsByToken[token];
    if (!claims) return { data: null, error: { name: 'AuthInvalidJwtError', message: 'invalid' } };
    return { data: { claims, header: {}, signature: new Uint8Array() }, error: null };
  });
});

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

function post(headers: Record<string, string> = {}): Promise<Response> {
  return route.POST(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: initializeBody(),
    })
  );
}

async function connect(mode: 'legacy' | { pin: string }, token = CONNECTED_APP_TOKEN, extraHeaders: Record<string, string> = {}) {
  const client = new Client({ name: 'keepr-test-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: routeFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
  });
  await client.connect(transport);
  return client;
}

function statusFrom(result: unknown) {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((k) => k.toLowerCase().startsWith('access-control-'));
}

describe('A1: no Authorization header', () => {
  it('returns 401 with WWW-Authenticate naming the resource metadata address', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/api/mcp/resource-metadata"`
    );
  });

  it.each(['Basic abc', 'Bearer', 'Bearer ', 'bearer'])('a malformed header %p is treated as absent (401)', async (h) => {
    const res = await post({ authorization: h });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="');
  });

  it('positive: a connected-app token lists get_status', async () => {
    const client = await connect('legacy');
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['get_status']);
    await client.close();
  });

  it('the resource metadata names this resource and the Supabase issuer', async () => {
    const res = await metadataGET(new Request(`${BASE}/api/mcp/resource-metadata`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: MCP_URL,
      authorization_servers: ['https://project-ref.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
      resource_name: 'Keepr',
    });
  });
});

describe('A2: a token must carry a client_id claim', () => {
  it('a first-party session token gets 401 invalid_token', async () => {
    const res = await post({ authorization: `Bearer ${FIRST_PARTY_TOKEN}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['number', 123],
    ['object', { id: 'x' }],
  ])('client_id %s gets 401', async (_label, value) => {
    claimsByToken['odd-token'] = { ...FIRST_PARTY_CLAIMS, client_id: value };
    const res = await post({ authorization: 'Bearer odd-token' });
    expect(res.status).toBe(401);
  });

  it('a token the auth server rejects gets 401', async () => {
    const res = await post({ authorization: 'Bearer unknown-token' });
    expect(res.status).toBe(401);
  });

  it('a token check that throws gets 401', async () => {
    mockGetClaims.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const res = await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(401);
  });

  it('positive: a connected-app token gets 200', async () => {
    const res = await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(200);
  });
});

describe('A3: Origin', () => {
  it.each(['https://evil.example', 'null', 'https://portal.test'])(
    'Origin %p with an empty allowlist gets 403 and no CORS header',
    async (origin) => {
      const res = await post({ origin, authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
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
    const res = await post({ origin, authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(403);
    expect(corsHeaders(res)).toEqual([]);
  });

  it('the origin check runs before the token check', async () => {
    const res = await post({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('positive: an exactly allow-listed origin passes', async () => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://other.example, https://allowed.example';
    const res = await post({ origin: 'https://allowed.example', authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('positive: no Origin header passes', async () => {
    const res = await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(200);
  });
});

describe('A4: POST only', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'] as const)('%s returns 405 with Allow: POST', async (m) => {
    const res = await route[m](new Request(MCP_URL, { method: m }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('GET with a valid token and an SSE accept header is still 405', async () => {
    const res = await route.GET(
      new Request(MCP_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${CONNECTED_APP_TOKEN}`, accept: 'text/event-stream' },
      })
    );
    expect(res.status).toBe(405);
  });

  it('positive: POST returns 200', async () => {
    const res = await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` });
    expect(res.status).toBe(200);
  });
});

describe('A5: both protocol eras, stateless', () => {
  it('a 2025-era client initializes, then lists and calls get_status', async () => {
    const client = await connect('legacy');
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: 'get_status',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    const status = statusFrom(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(status).toEqual({ connected: true, protocolVersion: '2025-11-25', serverVersion: '0.1.0' });
    await client.close();
  });

  it('a 2026-07-28 client lists and calls get_status with no initialize', async () => {
    const client = await connect({ pin: '2026-07-28' });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['get_status']);
    const status = statusFrom(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(status).toEqual({ connected: true, protocolVersion: '2026-07-28', serverVersion: '0.1.0' });
    await client.close();
  });

  it('an unknown tool is an error result, not a crash', async () => {
    const client = await connect({ pin: '2026-07-28' });
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('A8: MCP_ENABLED kill switch', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', '1', 'yes'])('MCP_ENABLED=%p: every method and the metadata route are 404', async (value) => {
    if (value === undefined) delete process.env.MCP_ENABLED;
    else process.env.MCP_ENABLED = value;
    expect((await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` })).status).toBe(404);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(404);
    expect((await route.GET(new Request(MCP_URL))).status).toBe(404);
    expect((await route.DELETE(new Request(MCP_URL, { method: 'DELETE' }))).status).toBe(404);
    expect((await metadataGET(new Request(`${BASE}/api/mcp/resource-metadata`))).status).toBe(404);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('positive: MCP_ENABLED=true gives 401 without a token and 200 with one', async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: `Bearer ${CONNECTED_APP_TOKEN}` })).status).toBe(200);
  });
});
