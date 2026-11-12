/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H20a/H20b: the argument names rpc.ts sends to each database
 * function equal the parameter names in the migration, parsed from the file.
 * Compared after JSON encoding, with every optional value null, so a key that
 * would be dropped on the wire is caught.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));

import { authorizeBegin, exchangeCode, refreshTokens, registerClient } from '@/lib/mcp/oauth/rpc';

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

  const CFG = { supabaseUrl: 'https://project-ref.supabase.co', supabaseAnonKey: 'anon' };
  const CALLS: Array<[string, () => Promise<unknown>, number]> = [
    [
      'mcp_authorize_begin',
      () =>
        authorizeBegin(CFG, {
          secret: 's',
          clientId: 'c',
          redirectUri: 'u',
          codeChallenge: null,
          codeChallengeMethod: null,
          resource: 'r',
          scope: 'mcp:read',
          state: null,
          bindingSha256: '\\x00',
          ipSha256: '\\x00',
        }),
      10,
    ],
    [
      'mcp_exchange_code',
      () =>
        exchangeCode(CFG, {
          secret: 's',
          codeDigest: '\\x00',
          codeVerifier: 'v',
          clientId: 'c',
          redirectUri: null,
          resource: 'r',
          atDigest: '\\x01',
          rtDigest: '\\x02',
        }),
      8,
    ],
    [
      'mcp_refresh',
      () =>
        refreshTokens(CFG, {
          secret: 's',
          rtDigest: '\\x00',
          clientId: 'c',
          resource: 'r',
          newAtDigest: '\\x01',
          newRtDigest: '\\x02',
        }),
      6,
    ],
  ];

  it.each(CALLS)('H20b: %s gets exactly the migration parameter names on the wire', async (fn, invoke, n) => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'invalid_request' }, error: null });
    await invoke();
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe(fn);
    const wire = Object.keys(JSON.parse(JSON.stringify(args))).sort();
    expect(wire).toHaveLength(n);
    expect(wire).toEqual(parameterNames(sql, fn).sort());
  });
});
