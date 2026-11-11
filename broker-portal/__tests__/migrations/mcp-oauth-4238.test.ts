/**
 * BACKLOG-4238 — CI tripwire for the MCP OAuth server migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no
 * database. Behaviour is proved by supabase/tests/backlog-4238 (controls,
 * mutate.py, concurrency scripts).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const FILE = '20261112170000_backlog_4238_mcp_oauth_server.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-4238/rollback-4238.sql');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const RAW = read(join(MIGRATIONS_DIR, FILE));
/** comments removed, whitespace collapsed */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const SQL = statements(RAW);
const RB = statements(read(ROLLBACK));

interface Fn {
  name: string;
  args: string;
  sig: string;
  header: string;
  body: string;
  start: number;
}

/** argument types of a CREATE FUNCTION parameter list (names and defaults dropped) */
function argTypes(params: string): string {
  if (!params.trim()) return '';
  return params
    .split(',')
    .map((p) => p.trim().replace(/\s+DEFAULT\s+.*$/i, '').split(/\s+/).slice(1).join(' '))
    .join(', ');
}

const FNS: Fn[] = [];
{
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)([\s\S]*?)AS \$fn\$([\s\S]*?)\$fn\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SQL)) !== null) {
    const args = argTypes(m[2]);
    FNS.push({ name: m[1], args, sig: `public.${m[1]}(${args})`, header: m[3], body: m[4], start: m.index });
  }
}
const fn = (name: string): Fn => {
  const f = FNS.filter((x) => x.name === name);
  expect(f).toHaveLength(1);
  return f[0];
};

const ANON = ['mcp_register_client', 'mcp_authorize_begin', 'mcp_exchange_code', 'mcp_refresh', 'mcp_check_access', 'mcp_get_status'];
const SIGNED_IN = ['mcp_authorize_view', 'mcp_authorize_approve', 'mcp_authorize_deny', 'mcp_list_my_connections', 'mcp_disconnect', 'mcp_disconnect_all_mine'];
const TABLES = ['mcp_settings', 'mcp_redirect_allowlist', 'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections',
  'mcp_authorization_codes', 'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log'];

describe('BACKLOG-4238 migration file', () => {
  it('sorts after 20261112160000 and is the only file with its version', () => {
    const versions = readdirSync(MIGRATIONS_DIR).map((f) => f.slice(0, 14));
    expect(FILE.slice(0, 14) > '20261112160000').toBe(true);
    expect(versions.filter((v) => v === FILE.slice(0, 14))).toHaveLength(1);
    expect(SQL).not.toMatch(/\b(BEGIN|COMMIT)\s*;/i);
  });

  it('defines 25 functions, every one revoked from all four roles with its full signature', () => {
    expect(FNS).toHaveLength(25);
    for (const f of FNS) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${f.sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(f.header).toMatch(/SET search_path = ''/);
    }
  });

  it('grants EXECUTE to anon on exactly the six portal functions, each marked', () => {
    const anonGrants = [...SQL.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO anon;/g)].map((m) => m[1]).sort();
    expect(anonGrants).toEqual([...ANON].sort());
    for (const name of ANON) {
      const at = RAW.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const above = RAW.slice(0, at).trimEnd().split('\n').pop() ?? '';
      expect(above).toMatch(/^-- Intentionally callable by anon: \S/);
      expect(fn(name).body).toContain('IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN');
    }
  });

  it('grants EXECUTE to authenticated on exactly the six signed-in functions, and nothing to service_role', () => {
    const authGrants = [...SQL.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO authenticated;/g)].map((m) => m[1]).sort();
    expect(authGrants).toEqual([...SIGNED_IN].sort());
    expect(SQL).not.toMatch(/GRANT [^;]* TO [^;]*service_role/);
    expect(SQL).not.toMatch(/TO PUBLIC/);
    const grantsToPostgres = [...SQL.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO postgres;/g)].map((m) => m[1]);
    expect(grantsToPostgres).toEqual(['_mcp_r_entitlement']);
  });

  it('closes every table: row level security on, no policy, no client privilege', () => {
    const created = [...SQL.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(TABLES);
    for (const t of TABLES) {
      expect(SQL).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(SQL).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`);
    }
    expect(SQL).not.toMatch(/CREATE POLICY/i);
  });

  it('revokes the sequence of every identity or serial column, and the composite type', () => {
    const tables = [...SQL.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(([\s\S]*?)\);/g)];
    let seqCols = 0;
    for (const t of tables) {
      for (const m of t[2].matchAll(/(?:^\s*|,\s*)(\w+) (?:\w+ GENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY|(?:big|small)?serial\b)/gi)) {
        seqCols += 1;
        expect(SQL).toContain(`REVOKE ALL ON SEQUENCE public.${t[1]}_${m[1]}_seq FROM PUBLIC, anon, authenticated;`);
      }
    }
    expect(seqCols).toBe(1);
    expect(SQL).not.toMatch(/CREATE SEQUENCE/i);
    const types = [...RAW.matchAll(/CREATE TYPE public\.(\w+)/g)].map((m) => m[1]);
    expect(types).toEqual(['mcp_gate']);
    for (const ty of types) expect(SQL).toContain(`REVOKE ALL ON TYPE public.${ty} FROM PUBLIC, anon, authenticated;`);
  });

  it('counts token endpoint failures only on failure paths', () => {
    expect(SQL).not.toMatch(/_mcp_fail_over/);
    for (const name of ['mcp_exchange_code', 'mcp_refresh']) {
      const b = fn(name).body;
      const calls = [...b.matchAll(/(\S+) public\._mcp_token_fail\(/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const c of calls) expect(c).toBe('RETURN');
      expect(b).not.toMatch(/tok_fail/);
    }
  });

  it('keeps the call log content-free', () => {
    const block = SQL.slice(SQL.indexOf('CREATE TABLE IF NOT EXISTS public.mcp_call_log ('), SQL.indexOf('CREATE INDEX IF NOT EXISTS mcp_call_log_user_idx'));
    const cols = [...block.matchAll(/[(,] (\w+) (?:bigint|uuid|text|timestamptz|integer)\b/g)].map((m) => m[1]);
    expect(cols).toEqual(['id', 'user_id', 'connection_id', 'provider', 'event', 'tool', 'outcome', 'started_at', 'ended_at', 'rows_returned', 'duration_ms']);
  });

  it('seeds the kill switch off, no secret, and the two exact callback addresses', () => {
    expect(SQL).toContain('enabled boolean NOT NULL DEFAULT false,');
    expect(SQL).toContain('connect_requires_cloud boolean NOT NULL DEFAULT true,');
    expect(SQL).toContain('INSERT INTO public.mcp_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;');
    expect(SQL).not.toMatch(/portal_secret_sha256\s*=/);
    expect(SQL).not.toMatch(/INSERT INTO public\.mcp_settings \([^)]*portal_secret/);
    expect(SQL).toContain(
      "INSERT INTO public.mcp_redirect_allowlist (redirect_uri, provider) VALUES ('https://claude.ai/api/mcp/auth_callback', 'anthropic'), ('https://chatgpt.com/connector_platform_oauth_redirect', 'openai') ON CONFLICT (redirect_uri) DO NOTHING;",
    );
  });

  it('checks the portal secret with a predicate that cannot return NULL', () => {
    const f = fn('_mcp_secret_ok');
    expect(f.header).toMatch(/LANGUAGE sql STABLE SECURITY INVOKER/);
    expect(f.header).not.toMatch(/STRICT/);
    expect(f.body.trim()).toMatch(/^SELECT coalesce\(\(/);
    expect(f.body.trim()).toMatch(/\), false\)$/);
    expect(f.body).toContain('p_secret IS NOT NULL AND s.portal_secret_sha256 IS NOT NULL');
    expect(f.body).toContain('s.portal_secret_prev_sha256 IS NOT NULL AND');
    expect(f.body).not.toMatch(/IS NOT DISTINCT FROM/);
  });

  it('writes gates as IS NOT TRUE / IS DISTINCT FROM, never IF NOT or <> in an IF', () => {
    expect(SQL).not.toMatch(/IF NOT public\._mcp_/);
    const conditions = [...SQL.replace(/CREATE (TABLE|INDEX) IF NOT EXISTS/g, 'CREATE $1').matchAll(/\b(?:IF|ELSIF) ([\s\S]*?) THEN\b/g)].map((m) => m[1]);
    expect(conditions.length).toBeGreaterThan(40);
    for (const c of conditions) {
      expect(c).not.toMatch(/<>|!=/);
    }
    expect([...SQL.matchAll(/public\._mcp_secret_ok\(p_secret\)/g)]).toHaveLength(ANON.length);
    expect([...SQL.matchAll(/IF public\._mcp_secret_ok\(p_secret\) IS NOT TRUE THEN/g)]).toHaveLength(ANON.length);
    expect(fn('mcp_get_status').body).toContain('IF g.outcome IS DISTINCT FROM \'ok\' THEN');
  });

  it('creates the reader as mcp_reader, STABLE, and the reader role without login or RLS bypass', () => {
    expect(SQL).toContain('ALTER ROLE mcp_reader NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;');
    expect(SQL).toContain('GRANT authenticated TO mcp_reader;');
    expect(SQL).toContain('GRANT mcp_reader TO postgres WITH INHERIT FALSE, SET TRUE;');
    expect(SQL.replace(/NOBYPASSRLS/g, '')).not.toMatch(/BYPASSRLS/);
    const setRole = SQL.indexOf('SET ROLE mcp_reader;');
    const resetRole = SQL.indexOf('RESET ROLE;');
    expect(setRole).toBeGreaterThan(0);
    expect(SQL.indexOf('SET ROLE mcp_reader;', setRole + 1)).toBe(-1);
    const readers = FNS.filter((f) => f.name.startsWith('_mcp_r_'));
    expect(readers.map((f) => f.name)).toEqual(['_mcp_r_entitlement']);
    for (const f of readers) {
      expect(f.start).toBeGreaterThan(setRole);
      expect(f.start).toBeLessThan(resetRole);
      expect(f.header).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    }
    const inside = FNS.filter((f) => f.start > setRole && f.start < resetRole).map((f) => f.name);
    expect(inside).toEqual(['_mcp_r_entitlement']);
  });

  it('revokes every schema CREATE it grants, in the same file', () => {
    const grants = [...SQL.matchAll(/GRANT CREATE ON SCHEMA (\w+) TO (\w+);/g)];
    expect(grants).toHaveLength(1);
    for (const g of grants) {
      const revoke = `REVOKE CREATE ON SCHEMA ${g[1]} FROM ${g[2]};`;
      expect(SQL.indexOf(revoke)).toBeGreaterThan(g.index ?? 0);
    }
  });

  it('reader bodies reference only cloud tables, other readers and the state function', () => {
    const allowedCalls = new Set(['if', 'to_regprocedure', 'jsonb_build_object', 'coalesce', 'to_jsonb', 'get_my_cloud_autosave_state']);
    for (const f of FNS.filter((x) => x.name.startsWith('_mcp_r_'))) {
      const body = f.body.replace(/'[^']*'/g, (s) => s.replace(/public\.get_my_cloud_autosave_state/g, 'public.get_my_cloud_autosave_state'));
      for (const m of body.matchAll(/public\.(\w+)/g)) {
        expect(m[1]).toMatch(/^(cloud_\w+|_mcp_r_\w+|get_my_cloud_autosave_state)$/);
      }
      const calls = [...body.replace(/'[^']*'/g, "''").matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1].toLowerCase());
      for (const c of calls) {
        expect(allowedCalls.has(c)).toBe(true);
      }
      expect(body).not.toMatch(/pg_advisory|pg_sleep|set_config|dblink|\bnet\.|RAISE (NOTICE|LOG|INFO|WARNING|DEBUG)/i);
    }
  });

  it('runs every reader call in a read-only block that always rolls back', () => {
    for (const name of ['mcp_get_status', '_mcp_entitlement_now']) {
      const b = fn(name).body;
      expect(b).toContain("PERFORM set_config('transaction_read_only', 'on', true);");
      expect(b).toContain("RAISE EXCEPTION USING ERRCODE = 'MC000'");
      expect(b).toContain("WHEN SQLSTATE 'MC000' THEN NULL;");
      expect(b).toContain("IF public._mcp_reader_ok('public._mcp_r_entitlement()'::regprocedure) IS NOT TRUE THEN");
      const unquoted = b.replace(/'[^']*'/g, "''");
      const ro = unquoted.indexOf("set_config('', '', true)");
      const call = unquoted.indexOf('public._mcp_r_entitlement()');
      expect(ro).toBeGreaterThan(0);
      expect(call).toBeGreaterThan(ro);
    }
    const st = fn('mcp_get_status').body;
    expect(st).toContain("WHEN query_canceled THEN v_out := 'timeout';");
    const block = st.slice(st.indexOf("set_config('transaction_read_only', 'on', true)"), st.indexOf("RAISE EXCEPTION USING ERRCODE = 'MC000'"));
    expect(block).toContain("set_config('request.jwt.claims'");
    expect(st.slice(0, st.indexOf("set_config('transaction_read_only', 'on', true)"))).not.toContain('request.jwt.claim');
  });

  it('refuses consent writes during an impersonation session in progress', () => {
    const imp = fn('_mcp_impersonating').body;
    expect(imp).toContain("i.status IN ('active', 'validated')");
    expect(imp).toContain('i.session_expires_at > now()');
    for (const name of ['mcp_authorize_view', 'mcp_authorize_approve', 'mcp_authorize_deny', 'mcp_disconnect', 'mcp_disconnect_all_mine']) {
      expect(fn(name).body).toContain('IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN');
    }
  });

  it('rollback drops every function, table, the type and the role', () => {
    for (const f of FNS) {
      expect(RB).toContain(`DROP FUNCTION IF EXISTS ${f.sig.replace('timestamp with time zone', 'timestamptz')}`);
    }
    for (const t of TABLES) expect(RB).toContain(`DROP TABLE IF EXISTS public.${t};`);
    expect(RB).toContain('DROP TYPE IF EXISTS public.mcp_gate;');
    expect(RB).toContain("EXECUTE 'DROP ROLE mcp_reader';");
    expect(RB).toContain("version = '20261112170000'");
  });
});
