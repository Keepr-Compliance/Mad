/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H20a: the argument names rpc.ts sends to mcp_register_client
 * equal the parameter names in the migration, parsed from the file.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));

import { registerClient } from '@/lib/mcp/oauth/rpc';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql'
);

/** Parameter names of `public.<fn>(...)` in its CREATE OR REPLACE FUNCTION line. */
export function parameterNames(sql: string, fn: string): string[] {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`, 'g');
  const matches = [...sql.matchAll(re)];
  if (matches.length !== 1) throw new Error(`${fn}: expected one definition, found ${matches.length}`);
  return matches[0][1]
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter((n) => n.length > 0);
}

describe('H20a: rpc parity with the migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('positive: the parser reads the known signature', () => {
    expect(parameterNames(sql, 'mcp_register_client')).toEqual([
      'p_secret',
      'p_client_id',
      'p_client_name',
      'p_redirect_uris',
      'p_ip_sha256',
    ]);
  });

  it('registerClient sends exactly the migration parameter names to mcp_register_client', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'busy' }, error: null });
    await registerClient(
      { supabaseUrl: 'https://project-ref.supabase.co', supabaseAnonKey: 'anon' },
      { secret: 's', clientId: 'c', clientName: 'n', redirectUris: ['u'], ipSha256: '\\x00' }
    );
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('mcp_register_client');
    expect(Object.keys(args).sort()).toEqual(parameterNames(sql, 'mcp_register_client').sort());
  });
});
