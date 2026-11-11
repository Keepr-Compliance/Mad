/**
 * @jest-environment node
 *
 * BACKLOG-4237 A7 — no Sentry event or transaction from /api/mcp or /oauth
 * carries the Authorization header, cookies, body or query string, and the MCP
 * route writes no log line containing the token.
 *
 * Event shape: RequestEventData from the installed @sentry/core
 * (build/types/types/request.d.ts): url, method, data, query_string, cookies,
 * env, headers.
 */

const mockInit = jest.fn();
jest.mock('@sentry/nextjs', () => ({ init: (...a: unknown[]) => mockInit(...a) }));

const mockGetClaims = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getClaims: (t: string) => mockGetClaims(t) } }),
}));

import { CONNECTED_APP_CLAIMS } from './fixtures';

const SECRET = 'planted-secret-token-value';

type Hooks = {
  beforeSend: (e: Record<string, unknown>) => Record<string, unknown> | null;
  beforeSendTransaction: (e: Record<string, unknown>) => Record<string, unknown> | null;
};

function loadConfig(file: 'server' | 'edge'): Hooks {
  mockInit.mockReset();
  jest.isolateModules(() => {
    require(file === 'server' ? '../../sentry.server.config' : '../../sentry.edge.config');
  });
  expect(mockInit).toHaveBeenCalledTimes(1);
  return mockInit.mock.calls[0][0] as Hooks;
}

function plantedEvent(url: string, extra: Record<string, unknown> = {}) {
  return {
    event_id: '0'.repeat(32),
    message: 'planted',
    request: {
      url,
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, cookie: `sb=${SECRET}`, 'content-type': 'application/json' },
      cookies: { sb: SECRET },
      data: `{"token":"${SECRET}"}`,
      query_string: `authorization_id=${SECRET}`,
      env: { REMOTE_ADDR: '127.0.0.1' },
    },
    ...extra,
  };
}

const SCRUBBED_URLS = [
  'https://portal.test/api/mcp',
  'https://portal.test/api/mcp/resource-metadata',
  'https://portal.test/oauth/consent?authorization_id=x',
  'https://portal.test/oauth/consent/start',
  '/api/mcp',
  '/oauth/consent',
  'https://portal.test/API/MCP',
];

const KEPT_URLS = ['https://portal.test/dashboard', 'https://portal.test/api/mcpx', 'https://portal.test/oauthx', '/api/billing/plan-summary'];

describe.each(['server', 'edge'] as const)('A7: sentry.%s.config', (file) => {
  describe.each(['beforeSend', 'beforeSendTransaction'] as const)('%s', (hook) => {
    it.each(SCRUBBED_URLS)('event from %p is captured with headers, cookies, body and query removed', (url) => {
      const fn = loadConfig(file)[hook];
      const out = fn(plantedEvent(url));
      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain(SECRET);
      const req = (out as { request: Record<string, unknown> }).request;
      expect(req.headers).toBeUndefined();
      expect(req.cookies).toBeUndefined();
      expect(req.data).toBeUndefined();
      expect(req.query_string).toBeUndefined();
      expect(req.method).toBe('POST');
    });

    it('a transaction named for the route is scrubbed even without a request url', () => {
      const fn = loadConfig(file)[hook];
      const ev = plantedEvent('');
      delete (ev.request as Record<string, unknown>).url;
      const out = fn({ ...ev, transaction: 'POST /api/mcp' });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    });

    it.each(KEPT_URLS)('positive: an event from %p keeps its request headers', (url) => {
      const fn = loadConfig(file)[hook];
      const out = fn(plantedEvent(url)) as { request: { headers?: Record<string, string> } };
      expect(out.request.headers?.['content-type']).toBe('application/json');
    });
  });
});

describe('A7: the MCP route logs no token', () => {
  const ENV = { ...process.env };
  const realFetch = global.fetch;
  beforeAll(() => {
    global.fetch = (() => {
      throw new Error('network access in a test');
    }) as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
    process.env = ENV;
  });

  it('a token check that throws with the token in its message writes nothing containing it', async () => {
    process.env = { ...ENV, MCP_ENABLED: 'true', NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' };
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    mockGetClaims.mockImplementationOnce(async (t: string) => {
      throw new Error(`bad token ${t}`);
    });
    mockGetClaims.mockImplementation(async () => ({ data: { claims: CONNECTED_APP_CLAIMS }, error: null }));
    const { POST } = await import('@/app/api/mcp/route');
    const mk = (body: string) =>
      new Request('https://portal.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body,
      });
    expect((await POST(mk('{}'))).status).toBe(401);
    // A malformed body reaches the SDK, which reports through onerror.
    await POST(mk(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${SECRET}"`));
    await POST(mk(`not json ${SECRET}`));
    // A 2026-07-28 request whose Mcp-Name header disagrees with the body is
    // rejected by the SDK, which reports it through onerror with a message that
    // quotes params.name (measured with SDK 2.4.0).
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const mismatch = new Request('https://portal.test/api/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'other',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: SECRET, arguments: {}, _meta: meta } }),
    });
    expect((await POST(mismatch)).status).toBe(400);
    const written = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' '));
    // Positive control: the SDK's rejection was reported, so a log line exists to inspect.
    expect(written.some((l) => l.startsWith('[mcp] handler error:'))).toBe(true);
    for (const line of written) expect(line).not.toContain(SECRET);
    spies.forEach((s) => s.mockRestore());
  });
});
