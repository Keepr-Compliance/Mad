/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the access token digest the route computes (authInfo.extra.atDigest)
 * and the raw token appear in no console line, no @sentry/nextjs call and no
 * response, on every path of /api/mcp. redactKpr only knows kpr_ values, so the
 * digest is planted (fixed pepper + fixed token) and searched for in every text form.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ACCESS_TOKEN, UNKNOWN_ACCESS_TOKEN, checkAccessOk, digestForms, expectedDigest, getStatusOk } from './fixtures';
import { OAUTH_ENV, postgrestFetchError, refusal } from './oauth/fixtures';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));

/** Every call to any @sentry/nextjs export, by name, with its arguments. */
const mockSentryCalls: Array<[string, unknown[]]> = [];
jest.mock('@sentry/nextjs', () => {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      mockSentryCalls.push([name, args]);
      if (name === 'withScope' && typeof args[0] === 'function') return (args[0] as (s: unknown) => unknown)(scope);
      return scope;
    };
  const scope: Record<string, unknown> = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : record(`scope.${String(p)}`)) });
  return new Proxy(
    { __esModule: true },
    { get: (t, p) => (p === '__esModule' ? true : p === 'then' || p === 'default' ? undefined : record(String(p))) }
  );
});

import * as route from '@/app/api/mcp/route';
import * as serverModule from '@/lib/mcp/server';

const BASE = 'https://portal.test';
const MCP_URL = `${BASE}/api/mcp`;
const ENV = { ...process.env };
const realFetch = global.fetch;

const FORMS = [...digestForms(ACCESS_TOKEN), ...digestForms(UNKNOWN_ACCESS_TOKEN)];
const RAW = [ACCESS_TOKEN, UNKNOWN_ACCESS_TOKEN, 'T'.repeat(43), 'U'.repeat(43)];

let consoleLines: () => string[];
const bodies: string[] = [];

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
  mockSentryCalls.length = 0;
  bodies.length = 0;
  mockRpc.mockReset();
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  consoleLines = () => spies.flatMap((s) => s.mock.calls).map((c) => c.map((v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v))).join(' '));
});
afterEach(() => jest.restoreAllMocks());

async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await route.POST(new Request(input, init));
  bodies.push(await res.clone().text());
  return res;
}

function post(token: string, body = '{}'): Promise<Response> {
  return routeFetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
}

async function callStatus(mode: 'legacy' | { pin: string }) {
  const client = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routeFetch, requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } } })
  );
  const result = await client.callTool({ name: 'get_status', arguments: {} });
  await client.close();
  return result;
}

/** Everything the code wrote: console lines, Sentry call arguments and response bodies. */
function written(): string {
  const sentry = mockSentryCalls.map(([n, a]) => `${n} ${JSON.stringify(a, (_k, v) => (typeof v === 'function' ? '[fn]' : v))}`);
  return [...consoleLines(), ...sentry, ...bodies].join('\n');
}

function expectNoDigestOrToken() {
  const out = written();
  for (const f of FORMS) expect(out).not.toContain(f);
  for (const r of RAW) expect(out).not.toContain(r);
}

describe('A5: the access token digest and the raw token are never written', () => {
  it('positive control: the planted digest is the one sent to the database, and log lines exist to inspect', async () => {
    mockRpc.mockImplementation(async (fn: string) => ({ data: fn === 'mcp_check_access' ? checkAccessOk() : getStatusOk(), error: null }));
    await callStatus('legacy');
    expect(mockRpc.mock.calls.every(([, a]) => a.p_at_digest === expectedDigest(ACCESS_TOKEN))).toBe(true);
    expect(FORMS).toContain(expectedDigest(ACCESS_TOKEN));
    expect(consoleLines().some((l) => l.startsWith('[mcp-oauth] '))).toBe(true);
    expectNoDigestOrToken();
  });

  it.each([['legacy' as const], [{ pin: '2026-07-28' }]])('a successful get_status (%p)', async (mode) => {
    mockRpc.mockImplementation(async (fn: string) => ({ data: fn === 'mcp_check_access' ? checkAccessOk() : getStatusOk(), error: null }));
    await callStatus(mode);
    expectNoDigestOrToken();
  });

  it.each(['not_connected', 'disabled', 'rate_limited', 'busy', 'timeout', 'error'])('a get_status refusal %s', async (code) => {
    mockRpc.mockImplementation(async (fn: string) => ({ data: fn === 'mcp_check_access' ? checkAccessOk() : refusal(code), error: null }));
    await callStatus('legacy');
    expectNoDigestOrToken();
  });

  it('a token the database does not know (401)', async () => {
    mockRpc.mockResolvedValue({ data: refusal('not_connected'), error: null });
    expect((await post(UNKNOWN_ACCESS_TOKEN)).status).toBe(401);
    expectNoDigestOrToken();
  });

  it('an access check that fails or throws (503)', async () => {
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    expect((await post(ACCESS_TOKEN)).status).toBe(503);
    mockRpc.mockRejectedValueOnce(new Error(`failed ${expectedDigest(ACCESS_TOKEN)}`));
    expect((await post(ACCESS_TOKEN)).status).toBe(503);
    mockRpc.mockResolvedValueOnce({ data: { ok: 'true' }, error: null });
    expect((await post(ACCESS_TOKEN)).status).toBe(503);
    expectNoDigestOrToken();
  });

  it('a body the SDK rejects, and the SDK handler throwing', async () => {
    mockRpc.mockResolvedValue({ data: checkAccessOk(), error: null });
    await post(ACCESS_TOKEN, 'not json');
    await post(ACCESS_TOKEN, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status"');
    jest.spyOn(serverModule, 'getMcpHandler').mockReturnValueOnce({
      fetch: async (_r: Request, o?: { authInfo?: { extra?: { atDigest?: string } } }) => {
        throw new Error(`handler failed ${o?.authInfo?.extra?.atDigest}`);
      },
    } as unknown as ReturnType<typeof serverModule.getMcpHandler>);
    expect((await post(ACCESS_TOKEN)).status).toBe(503);
    expect(consoleLines().some((l) => l.startsWith('[mcp] request failed:'))).toBe(true);
    expectNoDigestOrToken();
  });
});
