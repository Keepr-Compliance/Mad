/**
 * BACKLOG-4263 PR-6 — deploy order for migration 20261118140000 (mcp_list_my_connections adds `scope`).
 *
 * The row key sets are TRANSCRIBED from the function on the test database (supabase/tests/backlog-4263-pr6/
 * harness-6-scope.sql, rolled back, 2026-11-18): before the migration `B_old_row_keys`, after it `REAL_C1_keys`.
 *
 * The portal at 03665f6a0 (before this PR) validated each row with `hasExactKeys(row, CONNECTION_KEYS)`
 * (lib/mcp/account/rpc.ts:219, :233 at that commit) and turned any failed row into a transport failure, which the
 * page shows as M_A.loadFailed. That check is transcribed below unchanged, so this test states what the OLD build
 * does against the NEW function: the AI apps page shows "Keepr could not load your AI apps." for everyone. Hence
 * the order: deploy this portal first, then apply the migration.
 */
import { listMyConnections } from '@/lib/mcp/account/rpc';
import { CONNECTION_ID } from './fixtures';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));

const OLD_ROW_KEYS = ['client_name', 'consented_at', 'id', 'last_used_at', 'provider', 'redirect_host'];
const NEW_ROW_KEYS = ['client_name', 'consented_at', 'id', 'last_used_at', 'provider', 'redirect_host', 'scope'];

// 03665f6a0 broker-portal/lib/mcp/account/rpc.ts:40-43 and :219, verbatim in behaviour
const OLD_CONNECTION_KEYS = ['id', 'client_name', 'provider', 'redirect_host', 'consented_at', 'last_used_at'];
function oldHasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

const row = (keys: string[]): Record<string, unknown> => {
  const values: Record<string, unknown> = {
    id: CONNECTION_ID,
    client_name: 'Claude',
    provider: 'anthropic',
    redirect_host: 'claude.ai',
    consented_at: '2026-11-10T18:30:00.123456+00:00',
    last_used_at: null,
    scope: 'mcp:todos',
  };
  return Object.fromEntries(keys.map((k) => [k, values[k]]));
};

describe('20261118140000 deploy order', () => {
  it('the OLD portal rejects the NEW answer (so it would show the load failure): deploy the portal first', () => {
    expect(oldHasExactKeys(row(OLD_ROW_KEYS), OLD_CONNECTION_KEYS)).toBe(true);
    expect(oldHasExactKeys(row(NEW_ROW_KEYS), OLD_CONNECTION_KEYS)).toBe(false);
  });

  it.each([
    ['the answer before the migration', OLD_ROW_KEYS, null],
    ['the answer after the migration', NEW_ROW_KEYS, true],
  ])('THIS portal reads %s', async (_l, keys, canChangeTodos) => {
    mockRpc.mockResolvedValue({ data: { ok: true, connections: [row(keys)] }, error: null });
    const res = await listMyConnections();
    expect(res).toMatchObject({ kind: 'ok', connections: [{ canChangeTodos }] });
  });
});
