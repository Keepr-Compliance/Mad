/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-5 — the todo write tools through the real route, an SDK client and a mocked database.
 *
 * Database answers are the real ones: fixtures/todo-tools-4263.json is written by
 * supabase/tests/backlog-4263-pr5/gen.py (fixtures) from a rolled-back run of harness-5.sql on the test project, with
 * ids replaced by <id:n> and instants by one fixed instant.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ACCESS_TOKEN, checkAccessOk, expectedDigest } from './fixtures';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));

import * as route from '@/app/api/mcp/route';
import { checkDataToolEnvelope, checkWriteAccessEnvelope } from '@/lib/mcp/oauth/rpc';
import { normaliseScope } from '@/lib/mcp/oauth/validate';
import { CHECKLIST_ITEM_V2_KEYS, CHECKLISTS_SHAPE, CHECKLISTS_SHAPE_V2, TODO_CHANGE_SHAPE, TODO_ITEM_KEYS, TODO_STATUSES } from '@/lib/mcp/tools/shapes';
import { TOOLS } from '@/lib/mcp/server';
import { WRITE_TOOLS } from '@/lib/mcp/tools/todos';
import { TOOL_MESSAGES } from '@/lib/mcp/tools/text';
import { OAUTH_ENV, PORTAL_SECRET, RESOURCE, refusal } from './oauth/fixtures';

const REPO = path.resolve(__dirname, '../../..');
const MIGRATION = readFileSync(path.join(REPO, 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql'), 'utf8').replace(/\r\n?/g, '\n');
const fid = (n: number) => ['00000000', '0000', '4263', '8005', String(n).padStart(12, '0')].join('-');
const FX = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/todo-tools-4263.json'), 'utf8').replace(/<id:(\d+)>/g, (_m, n) => fid(Number(n)))
) as Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const BASE = 'https://portal.test';
const ENV = { ...process.env };
const realFetch = global.fetch;
const KNOWN_DIGEST = expectedDigest(ACCESS_TOKEN);
const WRITE_NAMES = ['update_todo', 'add_todo', 'remove_todo', 'restore_todo'];

let writeAnswer: unknown;
let toolAnswer: unknown;
function dbAnswer(fn: string, args: Record<string, unknown>) {
  const known = args.p_secret === PORTAL_SECRET && args.p_at_digest === KNOWN_DIGEST && args.p_resource === RESOURCE;
  if (fn === 'mcp_check_access') return { data: known ? checkAccessOk() : refusal('not_connected'), error: null };
  if (!known) return { data: refusal('not_connected'), error: null };
  if (fn === 'mcp_write_access') return writeAnswer instanceof Error ? { data: null, error: writeAnswer } : { data: writeAnswer, error: null };
  if (['mcp_update_todo', 'mcp_add_todo', 'mcp_remove_todo', 'mcp_restore_todo'].includes(fn)) return { data: toolAnswer, error: null };
  return { data: null, error: { message: 'unexpected function', code: 'PGRST202' } };
}

async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  return req.method === 'POST' ? route.POST(req) : req.method === 'GET' ? route.GET(req) : route.DELETE(req);
}
async function connect() {
  const client = new Client({ name: 'keepr-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    fetch: routeFetch,
    requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}
async function listNames() {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}
async function call(name: string, args?: Record<string, unknown>) {
  const client = await connect();
  const r = await client.callTool(args === undefined ? { name } : { name, arguments: args });
  await client.close();
  return r as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}
const calls = (fn: string) => mockRpc.mock.calls.filter(([n]) => n === fn);

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
  writeAnswer = clone(FX.FX_write_access_on);
  toolAnswer = clone(FX.FX_update_applied);
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => dbAnswer(fn, args));
  for (const m of ['warn', 'error', 'log', 'info'] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------- rule 3: the write tools are listed only when the database says so
describe('tools/list', () => {
  it('lists the four write tools after the read tools only for {ok:true, write:true}', async () => {
    expect(FX.FX_write_access_on).toEqual({ ok: true, write: true });
    expect(await listNames()).toEqual([...TOOLS.map((t) => t.name), ...WRITE_NAMES]);
    expect(calls('mcp_write_access')).toHaveLength(1);
  });

  it.each([
    ['the switch off (real answer)', () => clone(FX.FX_write_access_off)],
    ['a read grant (real answer)', () => clone(FX.FX_write_access_read_grant)],
    ['not_connected', () => refusal('not_connected')],
    ['an older database without the function', () => new Error('Could not find the function public.mcp_write_access')],
    ['an extra key', () => ({ ok: true, write: true, scope: 'mcp:todos' })],
    ['write as a string', () => ({ ok: true, write: 'true' })],
    ['null', () => null],
  ])('lists the read tools only for %s', async (_l, a) => {
    writeAnswer = a();
    expect(await listNames()).toEqual(TOOLS.map((t) => t.name));
  });

  it('the write tools are not read-only, only remove_todo is destructive, none reaches outside Keepr', () => {
    const by = Object.fromEntries(WRITE_TOOLS.map((t) => [t.name, t.annotations]));
    expect(by.update_todo).toEqual({ readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true });
    expect(by.add_todo).toEqual({ readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false });
    expect(by.remove_todo).toEqual({ readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true });
    expect(by.restore_todo).toEqual({ readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true });
    for (const t of WRITE_TOOLS) expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it('checkWriteAccessEnvelope accepts exactly the two answers', () => {
    expect(checkWriteAccessEnvelope({ ok: true, write: false })).toEqual({ kind: 'ok', write: false });
    expect(checkWriteAccessEnvelope({ ok: true })).toMatchObject({ kind: 'transport' });
    expect(checkWriteAccessEnvelope({ ok: false, error: 'disabled' })).toMatchObject({ kind: 'transport' });
  });
});

// ---------------------------------------------------------------- calls: what reaches the database, and what the app is shown
describe('update_todo', () => {
  it('sends only the parts given, as the migration names them, and shows the real answer', async () => {
    const r = await call('update_todo', { item_id: fid(1).toUpperCase(), done: true, note: null, request_id: 'r-1' });
    const [[, args]] = calls('mcp_update_todo');
    expect(Object.keys(args).sort()).toEqual(['p_at_digest', 'p_changes', 'p_item_id', 'p_request_id', 'p_resource', 'p_secret']);
    expect(args.p_changes).toEqual({ done: true, note: null });
    expect(args.p_request_id).toBe('r-1');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(FX.FX_update_applied.result);
  });

  it.each([
    [{}],
    [{ item_id: fid(1) }],
    [{ item_id: 'not-a-uuid', done: true }],
    [{ item_id: fid(1), done: 'yes' }],
    [{ item_id: fid(1), title: null }],
    [{ item_id: fid(1), title: 'x'.repeat(2001) }],
    [{ item_id: fid(1), note: 'x'.repeat(16001) }],
    [{ item_id: fid(1), due_date: '20 Dec' }],
    [{ item_id: fid(1), sort_order: 1 }],
    [{ item_id: fid(1), done: true, request_id: 'has space' }],
  ])('refuses %p before the database', async (args) => {
    const r = await call('update_todo', args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(TOOL_MESSAGES.invalid_input);
    expect(calls('mcp_update_todo')).toHaveLength(0);
  });

  it.each(['FX_update_unchanged', 'FX_update_not_allowed', 'FX_update_locked', 'FX_update_note_was_shortened', 'FX_update_is_removed'])(
    'a real %s answer is shown as the frame it is',
    async (k) => {
      toolAnswer = clone(FX[k]);
      const r = await call('update_todo', { item_id: fid(1), done: true });
      expect(r.structuredContent).toEqual(FX[k].result);
    }
  );
});

describe('add_todo, remove_todo, restore_todo', () => {
  it('add_todo sends deal, title, note, due date and request id', async () => {
    toolAnswer = clone(FX.FX_add_added);
    const r = await call('add_todo', { deal_id: fid(2), title: 'Book the movers', note: 'Two trucks', due_date: '2026-12-20', request_id: 'fx-add-1' });
    const [[, args]] = calls('mcp_add_todo');
    expect(args).toMatchObject({ p_deal_id: fid(2), p_title: 'Book the movers', p_note: 'Two trucks', p_due_date: '2026-12-20', p_request_id: 'fx-add-1' });
    expect(r.structuredContent).toEqual(FX.FX_add_added.result);
    expect(FX.FX_add_added.result.item).toMatchObject({ editable_title: true, removable: true, due_date: '2026-12-20' });
  });

  it.each([
    ['remove_todo', 'mcp_remove_todo', 'FX_remove_removed'],
    ['remove_todo', 'mcp_remove_todo', 'FX_remove_not_allowed'],
    ['restore_todo', 'mcp_restore_todo', 'FX_restore_restored'],
    ['restore_todo', 'mcp_restore_todo', 'FX_restore_not_removed'],
  ])('%s calls %s and shows the real %s answer', async (tool, fn, k) => {
    toolAnswer = clone(FX[k]);
    const r = await call(tool, { item_id: fid(3) });
    const [[, args]] = calls(fn);
    expect(Object.keys(args).sort()).toEqual(['p_at_digest', 'p_item_id', 'p_request_id', 'p_resource', 'p_secret']);
    expect(r.structuredContent).toEqual(FX[k].result);
  });

  it.each([[{ deal_id: fid(2) }], [{ deal_id: fid(2), title: 5 }], [{ deal_id: 'x', title: 'ok' }], [{ title: 'ok' }]])('add_todo refuses %p before the database', async (args) => {
    const r = await call('add_todo', args);
    expect(r.content[0].text).toBe(TOOL_MESSAGES.invalid_input);
    expect(calls('mcp_add_todo')).toHaveLength(0);
  });
});

describe('refusals and failures', () => {
  it.each([
    ['FX_err_read_only', TOOL_MESSAGES.read_only],
    ['FX_update_switch_off', TOOL_MESSAGES.read_only],
    ['FX_err_not_found', TOOL_MESSAGES.todo_not_found],
    ['FX_err_invalid_input', TOOL_MESSAGES.invalid_input],
  ])('a real %s answer is a tool error with fixed text', async (k, text) => {
    toolAnswer = clone(FX[k]);
    const r = await call('update_todo', { item_id: fid(1), done: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(text);
  });

  it.each([
    [{ ok: false, error: 'busy' }, TOOL_MESSAGES.busy],
    [{ ok: false, error: 'something_new' }, TOOL_MESSAGES.unavailable],
    [{ ok: true, result: { ...FX.FX_update_applied.result, status: 'lost' } }, TOOL_MESSAGES.unavailable],
    [{ ok: true, result: { ...FX.FX_update_applied.result, extra: 1 } }, TOOL_MESSAGES.unavailable],
  ])('answer %p is shown as %p', async (a, text) => {
    toolAnswer = a;
    const r = await call('update_todo', { item_id: fid(1), done: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(text);
  });
});

// ---------------------------------------------------------------- frames and parity with the migration
describe('frames', () => {
  it('get_deal_checklists: the real v1 and v2 answers are accepted; v2 under v1 keys, or v3, is not', () => {
    expect(FX.FX_checklists_v1.result.v).toBe(1);
    expect(FX.FX_checklists_v2.result.v).toBe(2);
    expect(checkDataToolEnvelope(FX.FX_checklists_v1, [CHECKLISTS_SHAPE, CHECKLISTS_SHAPE_V2]).kind).toBe('ok');
    expect(checkDataToolEnvelope(FX.FX_checklists_v2, [CHECKLISTS_SHAPE, CHECKLISTS_SHAPE_V2]).kind).toBe('ok');
    expect(checkDataToolEnvelope(FX.FX_checklists_v2, CHECKLISTS_SHAPE).kind).toBe('transport');
    expect(checkDataToolEnvelope({ ok: true, result: { ...FX.FX_checklists_v2.result, v: 3 } }, [CHECKLISTS_SHAPE, CHECKLISTS_SHAPE_V2]).kind).toBe('transport');
    const v1 = { ...clone(FX.FX_checklists_v1) };
    v1.result.v = 2;
    expect(checkDataToolEnvelope(v1, [CHECKLISTS_SHAPE, CHECKLISTS_SHAPE_V2]).kind).toBe('transport');
  });

  it('every real write answer matches the todo_change shape', () => {
    for (const [k, v] of Object.entries(FX)) {
      if (k.startsWith('FX_') && v?.ok === true && v.result?.kind === 'keepr.todo_change') {
        expect([k, checkDataToolEnvelope(v, TODO_CHANGE_SHAPE).kind]).toEqual([k, 'ok']);
      }
    }
  });

  it('the v2 item keys are the keys the reader adds; the item out keys are the ones _mcp_todo_item_out builds', () => {
    const reader = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public._mcp_r_deal_checklists('));
    for (const k of ['due_date', 'note_complete', 'editable_title', 'removable']) {
      expect(CHECKLIST_ITEM_V2_KEYS).toContain(k);
      expect(reader).toContain(`'${k}'`);
    }
    const out = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public._mcp_todo_item_out('));
    const built = [...out.slice(0, out.indexOf('$fn$;', out.indexOf('$fn$') + 4)).matchAll(/'([a-z_]+)', /g)].map((m) => m[1]);
    expect([...built].sort()).toEqual([...TODO_ITEM_KEYS].sort());
  });

  it('every status the portal accepts is one _mcp_todo_call can give, and the parameter names match', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public._mcp_todo_call('));
    for (const s of TODO_STATUSES) expect([s, body.includes(`'${s}'`)]).toEqual([s, true]);
    const params = (fn: string) =>
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`).exec(MIGRATION)![1].split(',').map((p) => p.trim().split(/\s+/)[0]);
    expect(params('mcp_update_todo')).toEqual(['p_secret', 'p_at_digest', 'p_resource', 'p_item_id', 'p_changes', 'p_request_id']);
    expect(params('mcp_add_todo')).toEqual(['p_secret', 'p_at_digest', 'p_resource', 'p_deal_id', 'p_title', 'p_note', 'p_due_date', 'p_request_id']);
    expect(params('mcp_remove_todo')).toEqual(['p_secret', 'p_at_digest', 'p_resource', 'p_item_id', 'p_request_id']);
    expect(params('mcp_write_access')).toEqual(['p_secret', 'p_at_digest', 'p_resource']);
  });
});

describe('scope', () => {
  it.each([
    [undefined, 'mcp:read'],
    ['', 'mcp:read'],
    ['mcp:read', 'mcp:read'],
    ['mcp:read offline_access', 'mcp:read'],
    ['mcp:todos', 'mcp:todos'],
    ['mcp:read mcp:todos', 'mcp:todos'],
    ['openid mcp:todos offline_access', 'mcp:todos'],
    ['mcp:read mcp:write', 'mcp:read mcp:write'],
    ['MCP:TODOS', 'MCP:TODOS'],
  ])('normaliseScope(%p) = %p', (raw, want) => {
    expect(normaliseScope(raw)).toBe(want);
  });
});
