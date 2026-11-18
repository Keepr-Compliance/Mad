/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the argument names lib/mcp/account/rpc.ts sends to each
 * signed-in database function equal the parameter names in the migration,
 * parsed from the file, after JSON encoding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));

import {
  approveRequest,
  denyRequest,
  disconnectAllMine,
  disconnectConnection,
  listMyConnections,
  viewRequest,
} from '@/lib/mcp/account/rpc';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql'
);

function parameterNames(sql: string, fn: string): string[] {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`, 'g');
  const matches = [...sql.matchAll(re)];
  if (matches.length !== 1) throw new Error(`${fn}: expected one definition, found ${matches.length}`);
  return matches[0][1]
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter((n) => n.length > 0);
}

const sql = readFileSync(MIGRATION, 'utf8');

describe('signed-in rpc parity with the migration', () => {
  it('positive: the parser reads the known approve signature', () => {
    expect(parameterNames(sql, 'mcp_authorize_approve')).toEqual([
      'p_request_id',
      'p_browser_binding_sha256',
      'p_nonce',
      'p_code_digest',
    ]);
  });

  const CALLS: Array<[string, () => Promise<unknown>, number]> = [
    ['mcp_authorize_view', () => viewRequest('r', '\\x00'), 2],
    ['mcp_authorize_approve', () => approveRequest('r', '\\x00', 'n', '\\x01'), 4],
    ['mcp_authorize_deny', () => denyRequest('r', '\\x00', 'n'), 3],
    ['mcp_list_my_connections', () => listMyConnections(), 0],
    ['mcp_disconnect', () => disconnectConnection('c'), 1],
    ['mcp_disconnect_all_mine', () => disconnectAllMine(), 0],
  ];

  it.each(CALLS)('%s gets exactly the migration parameter names on the wire', async (fn, invoke, n) => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'not_signed_in' }, error: null });
    await invoke();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe(fn);
    const wire = args === undefined ? [] : Object.keys(JSON.parse(JSON.stringify(args))).sort();
    expect(wire).toHaveLength(n);
    expect(wire).toEqual(parameterNames(sql, fn).sort());
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-4263 PR-10.5: the keys the newest mcp_authorize_view definition returns are an answer
// viewRequest accepts. Today that is the 9 keys; once a migration adds age_seconds it is 10.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

function newestViewDefinition(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const text = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const at = text.lastIndexOf('CREATE OR REPLACE FUNCTION public.mcp_authorize_view(');
    if (at < 0) continue;
    const end = text.indexOf('$fn$;', at);
    if (end < 0) throw new Error(`${file}: mcp_authorize_view has no closing $fn$;`);
    found = { file, body: text.slice(at, end) };
  }
  if (!found) throw new Error('no migration defines mcp_authorize_view');
  return found;
}

/** The top-level keys of the success jsonb_build_object (the one that starts with 'ok', true). */
function viewSuccessKeys(body: string): string[] {
  const start = body.search(/jsonb_build_object\(\s*'ok',\s*true/);
  if (start < 0) throw new Error('no success jsonb_build_object');
  const open = body.indexOf('(', start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error('unbalanced jsonb_build_object');
  const args: string[] = [];
  let cur = '';
  depth = 0;
  for (const ch of body.slice(open + 1, close)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  args.push(cur.trim());
  const keys = args
    .filter((_, i) => i % 2 === 0)
    .map((a) => a.replace(/\/\*.*?\*\//g, '').replace(/--[^\n]*/g, '').trim());
  for (const k of keys) if (!/^'[a-z_]+'$/.test(k)) throw new Error(`not a key literal: ${k}`);
  return keys.map((k) => k.slice(1, -1));
}

describe('mcp_authorize_view return keys parity with the newest migration', () => {
  const { file, body } = newestViewDefinition();
  const keys = viewSuccessKeys(body);

  it('positive: the parser reads the newest definition and its nine keys', () => {
    expect(file >= '20261118130000_backlog_4263_mcp_todo_write_tools.sql').toBe(true);
    for (const k of ['ok', 'request_id', 'client_name', 'provider', 'redirect_host', 'scope', 'notice_version', 'nonce', 'replaces_existing']) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('an answer with exactly the keys the SQL returns is accepted by viewRequest', async () => {
    const sample: Record<string, unknown> = {
      ok: true,
      request_id: 'A'.repeat(22),
      client_name: 'Claude',
      provider: 'anthropic',
      redirect_host: 'claude.ai',
      scope: 'mcp:read',
      notice_version: 1,
      nonce: 'N'.repeat(43),
      replaces_existing: false,
      age_seconds: 40,
    };
    // A key the portal does not know gets a placeholder value; viewRequest must then refuse the answer.
    const answer = Object.fromEntries(keys.map((k) => [k, k in sample ? sample[k] : 'unknown']));
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: answer, error: null });
    const res = await viewRequest('A'.repeat(22), '\\x00');
    expect(res.kind).toBe('ok');
  });
});
