/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-10 — /api/mcp request limits: the body read once by the route (256 KiB), at most 4 JSON-RPC
 * requests per POST, 60 JSON-RPC requests per 60 s and 4 in flight per access-token digest. The counters are in
 * memory and count per server instance (lib/mcp/rateLimit.ts).
 *
 * Database results are transcribed fixtures (fixtures/data-tools-4244.json, fixtures/data-tools-4263.json).
 * Requests are driven by the real @modelcontextprotocol/client where a session is needed, and as raw 2025-era
 * POSTs where the test needs a batch or an exact body.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ACCESS_TOKEN, UNKNOWN_ACCESS_TOKEN, checkAccessOk, expectedDigest } from './fixtures';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));

import * as route from '@/app/api/mcp/route';
import * as serverModule from '@/lib/mcp/server';
import {
  MCP_MAX_KEYS,
  MCP_SLOT_ABANDON_MS,
  MCP_SLOT_MAX_MS,
  MCP_WINDOW_MS,
  admitMcpRequest,
  mcpRateLimitKeysForTests,
  mcpRateLimitStateForTests,
  resetMcpRateLimitsForTests,
  setMcpRateLimitClockForTests,
} from '@/lib/mcp/rateLimit';
import { RPC_TIMEOUT_MS } from '@/lib/mcp/oauth/rpc';
import { OAUTH_ENV, PORTAL_SECRET, RESOURCE, postgrestFetchError, refusal } from './oauth/fixtures';

const fid44 = (n: number) => ['00000000', '0000', '4244', '8000', String(n).padStart(12, '0')].join('-');
const fid63 = (n: number) => ['00000000', '0000', '4263', '8000', String(n).padStart(12, '0')].join('-');
const fixture = (file: string, fid: (n: number) => string) =>
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').replace(/<id:(\d+)>/g, (_m, n) => fid(Number(n)))) as Record<
    string,
    { ok: true; result: Record<string, unknown> }
  >;
const FX = fixture('data-tools-4244.json', fid44);
const FX63 = fixture('data-tools-4263.json', fid63);
const D1 = (FX.FX_get_d1.result.deal as { deal_id: string }).deal_id;

const BASE = 'https://portal.test';
const MCP_URL = `${BASE}/api/mcp`;
const ENV = { ...process.env };
const realFetch = global.fetch;
const KNOWN = [expectedDigest(ACCESS_TOKEN), expectedDigest(UNKNOWN_ACCESS_TOKEN)];
const METADATA = `${BASE}/api/mcp/resource-metadata`;
const CHALLENGE_NO_TOKEN = `Bearer resource_metadata="${METADATA}", scope="mcp:read mcp:todos"`;
const CHALLENGE_INVALID = `Bearer error="invalid_token", resource_metadata="${METADATA}", scope="mcp:read mcp:todos"`;

/** The existing tool text (lib/mcp/tools/text.ts TOOL_MESSAGES.rate_limited), written out here on purpose. */
const LIMIT_TEXT = 'Too many requests. Try again in a minute.';
const limited = (id: string | number | null) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: LIMIT_TEXT } });

/** Tool RPCs answered later by the test: each call pushes its resolver. */
let deferred: Array<() => void> = [];
let deferTools = false;
/** Access checks answered later by the test. */
let deferredAccess: Array<() => void> = [];
let deferAccess = false;

function dbAnswer(fn: string, args: Record<string, unknown>) {
  const known = args.p_secret === PORTAL_SECRET && KNOWN.includes(args.p_at_digest as string) && args.p_resource === RESOURCE;
  if (fn === 'mcp_check_access') return { data: known ? checkAccessOk() : refusal('not_connected'), error: null };
  if (!known) return { data: refusal('not_connected'), error: null };
  if (fn === 'mcp_get_deal') return { data: JSON.parse(JSON.stringify(FX.FX_get_d1)), error: null };
  if (fn === 'mcp_get_deal_checklists') return { data: JSON.parse(JSON.stringify(FX.FX_cl_d1)), error: null };
  if (fn === 'mcp_list_all_deals') return { data: JSON.parse(JSON.stringify(FX63.FX_all_a)), error: null };
  return { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } };
}

let now = 1_000_000;
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
  resetMcpRateLimitsForTests();
  now = 1_000_000;
  setMcpRateLimitClockForTests(() => now);
  deferred = [];
  deferTools = false;
  deferredAccess = [];
  deferAccess = false;
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    const answer = dbAnswer(fn, args);
    if (deferAccess && fn === 'mcp_check_access') await new Promise<void>((resolve) => deferredAccess.push(resolve));
    if (deferTools && fn !== 'mcp_check_access' && fn !== 'mcp_write_access') {
      await new Promise<void>((resolve) => deferred.push(resolve));
    }
    return answer;
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const rpcCalls = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn).length;
const accessChecks = () => rpcCalls('mcp_check_access');
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

let posts = 0;
async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  if (req.method === 'POST') posts++;
  return req.method === 'POST' ? route.POST(req) : route.GET(req);
}

function rawPost(body: string, token: string | null = ACCESS_TOKEN, extra: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return route.POST(new Request(MCP_URL, { method: 'POST', headers, body, ...extra }));
}

const call = (id: number | string, name = 'get_deal', args: Record<string, unknown> = { deal_id: D1 }) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const post1 = (id: number | string, token: string | null = ACCESS_TOKEN) => rawPost(JSON.stringify(call(id)), token);

/** The JSON-RPC messages of a response: an SSE stream's data lines, or a JSON body. */
async function messages(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l.length > 6)
      .map((l) => JSON.parse(l.slice(6)));
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function expectServed(res: Response, ids: Array<number | string>) {
  expect(res.status).toBe(200);
  const got = await messages(res);
  expect(got.map((m) => m.id).sort()).toEqual([...ids].sort());
  for (const m of got) {
    expect(m.error).toBeUndefined();
    expect((m.result as { isError?: boolean }).isError).toBeFalsy();
  }
}

async function expectLimited(res: Response, body: unknown) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe(JSON.stringify(body));
}

async function useWindow(n: number, token = ACCESS_TOKEN) {
  for (let i = 1; i <= n; i++) await expectServed(await post1(i, token), [i]);
}

async function connect(token = ACCESS_TOKEN) {
  const client = new Client({ name: 'keepr-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routeFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  );
  return client;
}

describe('L1: 60 JSON-RPC requests per 60 s per token', () => {
  it('request 61 is refused with the JSON-RPC error for its own id, and makes no database call', async () => {
    await useWindow(60);
    expect(accessChecks()).toBe(60);
    await expectLimited(await post1('r-61'), limited('r-61'));
    expect(accessChecks()).toBe(60);
    expect(rpcCalls('mcp_write_access')).toBe(60);
    expect(rpcCalls('mcp_get_deal')).toBe(60);
  });

  it('the refusal is logged once with outcome rate_limited and no token or digest', async () => {
    await useWindow(60);
    (console.warn as jest.Mock).mockClear();
    await post1(61);
    const lines = (console.warn as jest.Mock).mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.startsWith('[mcp-oauth]'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice('[mcp-oauth] '.length))).toEqual({ route: 'mcp', outcome: 'rate_limited', status: 200, ms: expect.any(Number) });
    for (const k of [ACCESS_TOKEN, ...KNOWN, KNOWN[0].slice(2)]) expect(lines[0]).not.toContain(k);
  });

  it('the window starts again after 60 s', async () => {
    await useWindow(60);
    now += 59_999;
    await expectLimited(await post1(61), limited(61));
    now += 1;
    await expectServed(await post1(62), [62]);
  });

  it('a refused request does not use the window', async () => {
    await useWindow(60);
    for (let i = 0; i < 10; i++) await post1(`x${i}`);
    now += 60_000;
    await useWindow(60);
    await expectLimited(await post1(999), limited(999));
  });

  it('tokens are counted separately', async () => {
    await useWindow(60);
    await expectLimited(await post1(61), limited(61));
    await expectServed(await post1(1, UNKNOWN_ACCESS_TOKEN), [1]);
  });

  it('a notification-only POST counts 1 toward the window and is answered 202 with no body when over it', async () => {
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    for (let i = 0; i < 59; i++) expect((await rawPost(note)).status).toBe(202);
    await expectServed(await post1(60), [60]);
    const res = await rawPost(note);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(accessChecks()).toBe(60);
  });
});

describe('L2: a legitimate session is served', () => {
  it('initialize, initialized, tools/list, prompts/list, 5 list_all_deals and 25 get_deal (at most 4 at once) in one window, then the window resets', async () => {
    const client = await connect();
    await client.listTools();
    await client.listPrompts();
    for (let i = 0; i < 5; i++) {
      const r = await client.callTool({ name: 'list_all_deals', arguments: {} });
      expect(r.isError).toBeFalsy();
    }
    let maxParallel = 0;
    for (let i = 0; i < 25; i += 4) {
      const group = Array.from({ length: Math.min(4, 25 - i) }, () => client.callTool({ name: 'get_deal', arguments: { deal_id: D1 } }));
      maxParallel = Math.max(maxParallel, group.length);
      for (const r of await Promise.all(group)) expect(r.isError).toBeFalsy();
    }
    expect(maxParallel).toBe(4);
    expect(rpcCalls('mcp_get_deal')).toBe(25);
    expect(rpcCalls('mcp_list_all_deals')).toBe(5);
    // 34 JSON-RPC messages so far, every one served; fill the window to 60, refuse 61, then a new window.
    expect(accessChecks()).toBe(34);
    await useWindow(26);
    await expect(client.callTool({ name: 'get_deal', arguments: { deal_id: D1 } })).rejects.toMatchObject({ code: -32000, message: LIMIT_TEXT });
    now += 60_000;
    const after = await client.callTool({ name: 'get_deal', arguments: { deal_id: D1 } });
    expect(after.isError).toBeFalsy();
    await client.close();
  });

  it('one deal and its checklists, as two POSTs in parallel and as one POST with two requests, are served', async () => {
    const client = await connect();
    posts = 0;
    const both = await Promise.all([
      client.callTool({ name: 'get_deal', arguments: { deal_id: D1 } }),
      client.callTool({ name: 'get_deal_checklists', arguments: { deal_id: D1 } }),
    ]);
    for (const r of both) expect(r.isError).toBeFalsy();
    expect(posts).toBe(2); // the reference client sends each call as its own POST
    await client.close();
    const batch = await rawPost(JSON.stringify([call(1), call(2, 'get_deal_checklists')]));
    await expectServed(batch, [1, 2]);
    expect(rpcCalls('mcp_get_deal')).toBe(2);
    expect(rpcCalls('mcp_get_deal_checklists')).toBe(2);
  });
});

describe('L3: what the reference client does at the limit', () => {
  it('callTool rejects with the JSON-RPC error code and text, and the client sends no second POST', async () => {
    const client = await connect();
    await useWindow(58); // initialize + initialized + 58 = 60
    posts = 0;
    const err = await client.callTool({ name: 'get_deal', arguments: { deal_id: D1 } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: -32000, message: LIMIT_TEXT });
    expect(posts).toBe(1);
    await client.close();
  });
});

describe('L4: at most 4 JSON-RPC requests in flight per token', () => {
  /** Starts n get_deal POSTs whose database answers wait for the test. */
  async function startPending(n: number, first = 1, extra: (i: number) => RequestInit = () => ({})) {
    deferTools = true;
    const before = deferred.length;
    const pending = Array.from({ length: n }, (_v, k) => rawPost(JSON.stringify(call(first + k)), ACCESS_TOKEN, extra(k)));
    await until(() => deferred.length === before + n);
    return pending;
  }

  it('the fifth concurrent request is refused while four tool calls wait on the database; one finishing lets the next pass', async () => {
    const pending = await startPending(4);
    await expectLimited(await post1(5), limited(5));
    expect(accessChecks()).toBe(4);
    deferred[0]();
    await expectServed(await pending[0], [1]);
    const next = rawPost(JSON.stringify(call(6)));
    await until(() => deferred.length === 5);
    await expectLimited(await post1(7), limited(7));
    for (const r of deferred.slice(1)) r();
    await expectServed(await next, [6]);
    for (let k = 1; k < 4; k++) await expectServed(await pending[k], [k + 1]);
    deferTools = false;
    await expectServed(await post1(8), [8]);
  });

  it('a slot is released when the stream ends even if nobody reads the body', async () => {
    const pending = await startPending(4);
    deferred[0]();
    await pending[0]; // the response object only; its body is never read
    await until(() => mcpRateLimitStateForTests(KNOWN[0])?.inFlight === 3);
    deferTools = false;
    await expectServed(await post1(5), [5]);
    for (const r of deferred.slice(1)) r();
    await Promise.all(pending);
  });

  it('client abort: the slots stay taken while the database calls run, after they settle, and until the abandon bound', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = await startPending(4, 1, (k) => ({ signal: controllers[k].signal }));
    await expectLimited(await post1(5), limited(5));
    for (const c of controllers) c.abort();
    await Promise.allSettled(pending);
    for (let i = 0; i < 5; i++) await tick();
    await expectLimited(await post1(6), limited(6));
    for (const r of deferred) r();
    for (let i = 0; i < 5; i++) await tick();
    await expectLimited(await post1(7), limited(7));
    now += MCP_SLOT_ABANDON_MS - 1;
    await expectLimited(await post1(8), limited(8));
    now += 1;
    deferTools = false;
    await expectServed(await post1(9), [9]);
  });

  it('a cancelled response body is abandoned, not released', async () => {
    const pending = await startPending(4);
    const first = await pending[0];
    await first.body!.cancel();
    for (let i = 0; i < 5; i++) await tick();
    await expectLimited(await post1(5), limited(5));
    for (const r of deferred) r();
    await Promise.all(pending.slice(1));
    now += MCP_SLOT_ABANDON_MS;
    deferTools = false;
    await expectServed(await post1(6), [6]);
  });

  it('a stream that never ends holds its slots for the route maximum duration, then they end', async () => {
    expect(route.maxDuration * 1000).toBe(MCP_SLOT_MAX_MS);
    const pending = await startPending(4);
    now += MCP_SLOT_MAX_MS - 1;
    await expectLimited(await post1(5), limited(5));
    now += 1;
    deferTools = false;
    await expectServed(await post1(6), [6]);
    for (const r of deferred) r();
    await Promise.all(pending);
  });

  it('slots are released when the SDK handler throws', async () => {
    const real = serverModule.getMcpHandler();
    const spy = jest.spyOn(serverModule, 'getMcpHandler').mockReturnValue({
      ...real,
      fetch: async () => {
        throw new Error('handler failed');
      },
    } as typeof real);
    for (let i = 0; i < 6; i++) expect((await post1(i)).status).toBe(503);
    spy.mockRestore();
    await expectServed(await post1(10), [10]);
  });

  it('a token with counters: slots are released when the access check fails (503) or the token is not connected (401)', async () => {
    await useWindow(1);
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    for (let i = 0; i < 5; i++) expect((await post1(i)).status).toBe(503);
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    mockRpc.mockResolvedValueOnce({ data: refusal('not_connected'), error: null });
    for (let i = 0; i < 5; i++) expect((await post1(i)).status).toBe(401);
    expect(mcpRateLimitStateForTests(KNOWN[0])).toEqual({ count: 11, inFlight: 0 });
    await expectServed(await post1(10), [10]);
  });

  it('a token with counters: 10 POSTs sent together make at most 4 access checks; the other 6 are refused at once', async () => {
    await useWindow(1);
    const before = accessChecks();
    deferAccess = true;
    const all = Array.from({ length: 10 }, (_v, i) => post1(`c${i}`));
    await until(() => deferredAccess.length === 4);
    for (let i = 0; i < 5; i++) await tick();
    expect(accessChecks() - before).toBe(4);
    const settled: Response[] = [];
    for (const [i, p] of all.entries()) {
      const r = await Promise.race([p, new Promise<null>((res) => setImmediate(() => res(null)))]);
      if (r) settled.push(r);
      else expect(i).toBeLessThan(10);
    }
    expect(settled).toHaveLength(6);
    for (const r of settled) expect((await messages(r))[0].error).toEqual({ code: -32000, message: LIMIT_TEXT });
    for (const r of deferredAccess) r();
    const served = await Promise.all(all);
    expect(served.filter((r) => (r.headers.get('content-type') ?? '').startsWith('text/event-stream'))).toHaveLength(4);
  });

  it('a POST takes its in-flight slots all at once or not at all', async () => {
    const pending = await startPending(2);
    const checks = accessChecks();
    await expectLimited(await rawPost(JSON.stringify([call('a'), call('b'), call('c')])), [limited('a'), limited('b'), limited('c')]);
    expect(accessChecks()).toBe(checks);
    deferTools = false;
    await expectServed(await rawPost(JSON.stringify([call('d'), call('e')])), ['d', 'e']);
    for (const r of deferred) r();
    await Promise.all(pending);
  });

  it('an abandoned slot is held longer than the database call timeout', () => {
    expect(MCP_SLOT_ABANDON_MS).toBeGreaterThan(RPC_TIMEOUT_MS);
  });

  it('an abandoned slot ends MCP_SLOT_ABANDON_MS after the abort, not after it started', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = await startPending(4, 1, (k) => ({ signal: controllers[k].signal }));
    now += 5_000;
    for (const c of controllers) c.abort();
    await Promise.allSettled(pending);
    for (let i = 0; i < 5; i++) await tick();
    for (const r of deferred) r();
    now += MCP_SLOT_ABANDON_MS - 5_000;
    await expectLimited(await post1(5), limited(5));
    now += 5_000 - 1;
    await expectLimited(await post1(6), limited(6));
    now += 1;
    deferTools = false;
    await expectServed(await post1(7), [7]);
  });

  it('the in-flight refusal is logged with outcome rate_limited_inflight', async () => {
    const pending = await startPending(4);
    (console.warn as jest.Mock).mockClear();
    await post1(5);
    const lines = (console.warn as jest.Mock).mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.startsWith('[mcp-oauth]'));
    expect(lines.map((l) => JSON.parse(l.slice('[mcp-oauth] '.length)).outcome)).toEqual(['rate_limited_inflight']);
    for (const r of deferred) r();
    await Promise.all(pending);
  });
});

describe('L5: JSON-RPC requests are counted, not POSTs', () => {
  it('a POST with 5 requests is refused with the SDK batch shape and no database call', async () => {
    const res = await rawPost(JSON.stringify([1, 2, 3, 4, 5].map((i) => call(i))));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: Batch must not exceed 4 messages' }, id: null })
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a token with counters sending 5 requests in one POST gets the batch answer', async () => {
    await useWindow(1);
    const checks = accessChecks();
    const res = await rawPost(JSON.stringify([1, 2, 3, 4, 5].map((i) => call(i))));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: Batch must not exceed 4 messages' }, id: null })
    );
    expect(accessChecks()).toBe(checks);
  });

  it('a POST with 100 requests is refused, not counted as one', async () => {
    const res = await rawPost(JSON.stringify(Array.from({ length: 100 }, (_v, i) => call(i))));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a POST with 4 requests is served, each answer carrying its own id', async () => {
    await expectServed(await rawPost(JSON.stringify([call('a'), call('b'), call('c'), call('d')])), ['a', 'b', 'c', 'd']);
    expect(rpcCalls('mcp_get_deal')).toBe(4);
  });

  it('notifications in a batch are not requests: 4 requests and 2 notifications are served', async () => {
    const note = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await expectServed(await rawPost(JSON.stringify([call(1), note, call(2), call(3), note, call(4)])), [1, 2, 3, 4]);
  });

  it('15 POSTs of 4 use the window; the 16th is refused with an error for each of its ids', async () => {
    for (let p = 0; p < 15; p++) {
      const ids = [0, 1, 2, 3].map((k) => p * 4 + k);
      await expectServed(await rawPost(JSON.stringify(ids.map((i) => call(i)))), ids);
    }
    expect(accessChecks()).toBe(15);
    await expectLimited(await rawPost(JSON.stringify([call('w'), call('x'), call('y'), call('z')])), [
      limited('w'),
      limited('x'),
      limited('y'),
      limited('z'),
    ]);
    expect(accessChecks()).toBe(15);
  });

  it('a POST of 3 with 58 used is refused whole: all or nothing', async () => {
    await useWindow(58);
    await expectLimited(await rawPost(JSON.stringify([call('p'), call('q'), call('r')])), [limited('p'), limited('q'), limited('r')]);
    await expectServed(await rawPost(JSON.stringify([call('s'), call('t')])), ['s', 't']);
  });
});

describe('L6: the body is read once, at most 256 KiB', () => {
  /** A get_deal POST body of exactly n bytes (ASCII). */
  function bodyOf(n: number, fill = 'a'): string {
    const base = JSON.stringify({ ...call(1), params: { name: 'get_deal', arguments: { deal_id: D1 }, _meta: { pad: '' } } });
    const width = Buffer.byteLength(fill);
    const pad = fill.repeat(Math.floor((n - Buffer.byteLength(base)) / width));
    const out = base.replace('"pad":""', `"pad":"${pad}${'a'.repeat(n - Buffer.byteLength(base) - Buffer.byteLength(pad))}"`);
    expect(Buffer.byteLength(out)).toBe(n);
    return out;
  }
  const TOO_LARGE = { jsonrpc: '2.0', error: { code: -32000, message: 'Payload Too Large: Request body must not exceed 262144 bytes' }, id: null };

  it('256 KiB + 1 byte is refused as the SDK refuses it, with no database call', async () => {
    const body = bodyOf(256 * 1024 + 1);
    const res = await rawPost(body);
    expect(res.status).toBe(413);
    expect([...res.headers.entries()]).toEqual([['content-type', 'application/json']]);
    expect(await res.text()).toBe(JSON.stringify(TOO_LARGE));
    expect(mockRpc).not.toHaveBeenCalled();
    // The SDK's own answer for the same request, read by the SDK itself.
    const sdk = await serverModule.getMcpHandler().fetch(
      new Request(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body })
    );
    expect(sdk.status).toBe(413);
    expect([...sdk.headers.entries()]).toEqual([['content-type', 'application/json']]);
    expect(await sdk.text()).toBe(JSON.stringify(TOO_LARGE));
  });

  it('bytes are counted, not characters', async () => {
    const body = bodyOf(256 * 1024 + 2, 'é');
    expect(body.length).toBeLessThan(256 * 1024);
    expect((await rawPost(body)).status).toBe(413);
  });

  it('a declared Content-Length over the limit is refused', async () => {
    const req = new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ACCESS_TOKEN}`,
        'content-length': String(256 * 1024 + 1),
      },
      body: JSON.stringify(call(1)),
    });
    expect((await route.POST(req)).status).toBe(413);
  });

  it('exactly 256 KiB is served', async () => {
    await expectServed(await rawPost(bodyOf(256 * 1024)), [1]);
  });

  it('a body that is not JSON still gets the SDK parse error', async () => {
    const res = await rawPost('{not json');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }));
  });
});

describe('L7: the 401 answers come first and are unchanged', () => {
  it('with the window and the in-flight slots of the token used up, no token and a malformed token still get 401', async () => {
    await useWindow(60);
    deferTools = true;
    now += 60_000;
    const pending = [1, 2, 3, 4].map((i) => post1(`p${i}`));
    await until(() => deferred.length === 4);
    for (let i = 0; i < 200; i++) {
      const res = await post1(i, null);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE_NO_TOKEN);
      expect(await res.text()).toBe('{"error":"unauthorized"}');
    }
    const bad = await post1(1, `kpr_at_${'T'.repeat(42)}`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toBe(CHALLENGE_INVALID);
    expect(await bad.text()).toBe('{"error":"invalid_token"}');
    for (const r of deferred) r();
    await Promise.all(pending);
  });
});

describe('L8: the limiter holds digests only, and only for accepted tokens', () => {
  it('the key is the token digest, never the token', async () => {
    await useWindow(1);
    await useWindow(1, UNKNOWN_ACCESS_TOKEN);
    const keys = mcpRateLimitKeysForTests();
    expect([...keys].sort()).toEqual([...KNOWN].sort());
    for (const k of keys) {
      expect(k).not.toContain(ACCESS_TOKEN);
      expect(k).not.toContain('T'.repeat(43));
      expect(k).not.toContain('U'.repeat(43));
    }
  });

  it('30,000 requests with distinct unknown tokens create no entry and leave a real token untouched', async () => {
    const pending = await (async () => {
      deferTools = true;
      const p = [1, 2].map((i) => post1(`live${i}`));
      await until(() => deferred.length === 2);
      return p;
    })();
    await useWindowNoDefer(10);
    const before = mcpRateLimitStateForTests(KNOWN[0]);
    expect(before).toEqual({ count: 12, inFlight: 2 });
    const checks = accessChecks();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < 30_000; i++) {
      let tail = '';
      for (let n = i, k = 0; k < 6; k++, n = Math.floor(n / 64)) tail += alphabet[n % 64];
      const res = await post1(i, `kpr_at_${'V'.repeat(37)}${tail}`);
      if (res.status !== 401) throw new Error(`unknown token answered ${res.status}`);
    }
    expect(accessChecks() - checks).toBe(30_000);
    expect(mcpRateLimitKeysForTests()).toEqual([KNOWN[0]]);
    expect(mcpRateLimitStateForTests(KNOWN[0])).toEqual(before);
    for (const r of deferred) r();
    await Promise.all(pending);
  }, 120_000);

  it('an access check that fails (503) creates no entry', async () => {
    mockRpc.mockResolvedValueOnce(postgrestFetchError('x'));
    expect((await post1(1)).status).toBe(503);
    expect(mcpRateLimitKeysForTests()).toEqual([]);
  });

  it('a known token at its limit is refused with no access-check call', async () => {
    await useWindow(60);
    const checks = accessChecks();
    for (let i = 0; i < 20; i++) await expectLimited(await post1(i), limited(i));
    expect(accessChecks()).toBe(checks);
  });

  it('an unknown token (401) never gets an entry, a known token gets one after its access check', async () => {
    expect((await post1(1, UNKNOWN_ACCESS_TOKEN.replace('U', 'W'))).status).toBe(401);
    expect(mcpRateLimitKeysForTests()).toEqual([]);
    await useWindow(1);
    expect(mcpRateLimitKeysForTests()).toEqual([KNOWN[0]]);
  });

  it('a full map of live entries keeps every one of them; one more accepted key is served without an entry', () => {
    for (let i = 0; i < MCP_MAX_KEYS; i++) expect(admitMcpRequest(`k${i}`, 1, 0).ok).toBe(true);
    const extra = [1, 2, 3, 4, 5, 6].map(() => admitMcpRequest('newcomer', 1, 1));
    expect(extra.every((a) => a.ok)).toBe(true);
    const keys = mcpRateLimitKeysForTests();
    expect(keys).toHaveLength(MCP_MAX_KEYS);
    expect(keys).not.toContain('newcomer');
    expect(keys[0]).toBe('k0');
    expect(mcpRateLimitStateForTests('k0')).toEqual({ count: 1, inFlight: 0 });
  });

  it('an entry with a slot in flight is kept even after its window ended', () => {
    expect(admitMcpRequest('k0', 1, 0).ok).toBe(true);
    for (let i = 1; i < MCP_MAX_KEYS; i++) admitMcpRequest(`k${i}`, 1, 0);
    now += MCP_WINDOW_MS / 2;
    expect(admitMcpRequest('k0', 0, 1).ok).toBe(true); // a slot taken in the same window
    now += MCP_WINDOW_MS / 2;
    expect(admitMcpRequest('newcomer', 1, 0).ok).toBe(true);
    const keys = mcpRateLimitKeysForTests();
    expect(keys).toContain('k0');
    expect(keys).toContain('newcomer');
    expect(mcpRateLimitStateForTests('k0')).toEqual({ count: 1, inFlight: 1 });
  });

  it('when the map is full, ended idle entries are deleted first and the new key gets an entry', () => {
    for (let i = 0; i < MCP_MAX_KEYS; i++) admitMcpRequest(`k${i}`, 1, 0);
    now += MCP_WINDOW_MS;
    expect(admitMcpRequest('newcomer', 1, 0).ok).toBe(true);
    expect(mcpRateLimitKeysForTests()).toContain('newcomer');
    expect(mcpRateLimitKeysForTests().length).toBeLessThanOrEqual(MCP_MAX_KEYS);
  });

  it('a release is counted once, and a release after a reset changes nothing', () => {
    const a = admitMcpRequest('k', 1, 4);
    if (!a.ok) throw new Error('refused');
    a.slot.release();
    a.slot.release();
    const all = [1, 2, 3, 4].map(() => admitMcpRequest('k', 1, 1));
    expect(all.every((x) => x.ok)).toBe(true);
    expect(admitMcpRequest('k', 1, 1).ok).toBe(false);
    resetMcpRateLimitsForTests();
    setMcpRateLimitClockForTests(() => now);
    const b = admitMcpRequest('k', 1, 4);
    for (const x of all) if (x.ok) x.slot.release();
    expect(b.ok).toBe(true);
    expect(mcpRateLimitStateForTests('k')).toEqual({ count: 1, inFlight: 4 });
  });

  it('ended, idle windows are deleted on later calls, at most 100 per call', () => {
    for (let i = 0; i < 250; i++) admitMcpRequest(`old${i}`, 1, 0);
    now += MCP_WINDOW_MS;
    admitMcpRequest('new1', 1, 0);
    expect(mcpRateLimitKeysForTests()).toHaveLength(151);
    admitMcpRequest('new2', 1, 0);
    admitMcpRequest('new3', 1, 0);
    expect([...mcpRateLimitKeysForTests()].sort()).toEqual(['new1', 'new2', 'new3']);
  });
});

async function useWindowNoDefer(n: number) {
  const was = deferTools;
  deferTools = false;
  for (let i = 1; i <= n; i++) await expectServed(await post1(`w${i}`), [`w${i}`]);
  deferTools = was;
}
