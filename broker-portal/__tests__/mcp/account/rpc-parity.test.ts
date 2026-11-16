/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the argument names lib/mcp/account/rpc.ts sends to each
 * signed-in database function equal the parameter names in the migration,
 * parsed from the file, after JSON encoding.
 */

import { readFileSync } from 'node:fs';
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
