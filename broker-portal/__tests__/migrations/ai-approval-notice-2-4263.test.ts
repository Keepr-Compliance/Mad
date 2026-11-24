/**
 * BACKLOG-4263 (sync 2.49), P11 / T-N — migration 20261123150000 (approval page version 2), its rollback file and its
 * harness, checked as text (CI has no database; the harness runs them: supabase/tests/backlog-4263-sync2-n).
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const MIG_PATH = 'supabase/migrations/20261123150000_backlog_4263_ai_approval_notice_2.sql';
const DIR = 'supabase/tests/backlog-4263-sync2-n';
const MIG = read(MIG_PATH);
const RB = read(`${DIR}/rollback-20261123150000.sql`);
const code = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const NEW_FUNCS = ['_mcp_notice_change_expires_requests()', '_mcp_connection_version_fixed()', 'mcp_list_my_connection_access()'];

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const b0 = sql.indexOf('AS $fn$', start) + 'AS $fn$'.length;
  return sql.slice(b0, sql.indexOf('$fn$', b0));
}

describe('BACKLOG-4263 T-N migration text', () => {
  it('lock_timeout first, then the EXCLUSIVE lock on the request table, before any other statement that takes a lock', () => {
    const c = code(MIG);
    const lt = c.indexOf("SET LOCAL lock_timeout = '3s';");
    const lock = c.indexOf('LOCK TABLE public.mcp_authorization_requests IN EXCLUSIVE MODE;');
    const firstCreate = c.indexOf('CREATE OR REPLACE');
    expect(lt).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(lt);
    expect(c.slice(lt, lock).replace("SET LOCAL lock_timeout = '3s';", '').trim()).toBe('');
    expect(firstCreate).toBeGreaterThan(lock);
  });

  it('a notice-version change expires pending requests: the AFTER UPDATE trigger on mcp_settings, under the request-table lock', () => {
    expect(MIG).toContain(
      'CREATE OR REPLACE TRIGGER mcp_settings_notice_change_expires_requests\n  AFTER UPDATE ON public.mcp_settings\n' +
        '  FOR EACH ROW WHEN (OLD.notice_version IS DISTINCT FROM NEW.notice_version)\n' +
        '  EXECUTE FUNCTION public._mcp_notice_change_expires_requests();',
    );
    const b = fnBody(MIG, '_mcp_notice_change_expires_requests');
    expect(b).toContain("TG_TABLE_NAME = 'mcp_settings'");
    expect(b.indexOf('LOCK TABLE public.mcp_authorization_requests IN EXCLUSIVE MODE;')).toBeLessThan(b.indexOf('UPDATE public.mcp_authorization_requests'));
    expect(b).toMatch(/SET expires_at = '-infinity' +\/\*EXPIRE:value\*\/\n\s+WHERE r\.status = 'pending' AND r\.expires_at > '-infinity';/);
    expect(b).not.toMatch(/SET expires_at = now\(\)/);
  });

  it('the trigger is the only expiry of requests in the file (no second mechanism to conflict with it)', () => {
    expect(code(MIG).match(/UPDATE public\.mcp_authorization_requests/g)).toHaveLength(1);
  });

  it("a connection's version never changes by UPDATE: the BEFORE UPDATE trigger on mcp_connections raises", () => {
    expect(MIG).toContain(
      'CREATE OR REPLACE TRIGGER mcp_connections_version_fixed\n  BEFORE UPDATE ON public.mcp_connections\n' +
        '  FOR EACH ROW WHEN (OLD.notice_version IS DISTINCT FROM NEW.notice_version)\n' +
        '  EXECUTE FUNCTION public._mcp_connection_version_fixed();',
    );
    expect(fnBody(MIG, '_mcp_connection_version_fixed')).toContain("RAISE EXCEPTION 'mcp_connections.notice_version cannot be changed");
  });

  it('no backfill: no statement writes mcp_connections', () => {
    expect(code(MIG)).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+public\.mcp_connections/);
  });

  it('the header states the limit of the two triggers', () => {
    expect(MIG).toContain('--   Limit: neither trigger covers an INSERT of a connection row that already carries version 2, nor TRUNCATE.');
  });

  it('the bump runs only at version 1, does nothing at 2, refuses anything else', () => {
    const b = MIG.slice(MIG.indexOf('DO $bump4263n$'), MIG.indexOf('$bump4263n$;'));
    expect(b).toMatch(/ELSIF v = 1 THEN\n\s+UPDATE public\.mcp_settings s SET notice_version = 2, updated_at = now\(\) WHERE s\.id;/);
    expect(b).toMatch(/ELSIF v <> 2 THEN\n\s+RAISE EXCEPTION/);
    expect(b.indexOf("set_config('t4263n.bumped', 'off', true)")).toBeLessThan(b.indexOf('IF v IS NULL'));
  });

  it('every new function: SECURITY DEFINER, empty search_path, EXECUTE revoked from every API role; only the reader is granted, to authenticated', () => {
    for (const f of NEW_FUNCS) {
      const name = f.slice(0, f.indexOf('('));
      const at = MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const head = MIG.slice(at, MIG.indexOf('AS $fn$', at));
      expect(head).toContain("SECURITY DEFINER SET search_path = ''");
      expect(MIG).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(code(MIG).match(/GRANT EXECUTE ON FUNCTION [^\n]*/g)).toEqual(['GRANT EXECUTE ON FUNCTION public.mcp_list_my_connection_access() TO authenticated;']);
  });

  it('the reader checks its caller inside and answers the permission of each own active connection only', () => {
    const b = fnBody(MIG, 'mcp_list_my_connection_access');
    expect(b).toContain("IF v_uid IS NULL THEN\n    RETURN public._mcp_refuse('not_signed_in');");
    expect(b).toContain("IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN");
    expect(b).toContain("'messages', public._mcp_conn_reads_messages(c.id) IS TRUE)");
    expect(b).toContain("WHERE c.user_id = v_uid AND c.status = 'active'");
    expect(b).not.toContain('messages_upload');
  });

  it('replaces no existing function (approve, view, exchange and the message tools keep their pinned bodies)', () => {
    const created = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(created).toEqual(['_mcp_notice_change_expires_requests', '_mcp_connection_version_fixed', 'mcp_list_my_connection_access']);
    expect(MIG).toContain("('public.mcp_authorize_approve(text,bytea,text,bytea)', 'bddeb78139828a444715cc77d4482d78')");
    expect(MIG).toContain("('public.mcp_authorize_view(text,bytea)', '18bd5cc8788ff45288733b57ce9d4d65')");
  });
});

describe('BACKLOG-4263 T-N rollback file', () => {
  it('lock_timeout first, the same lock, then the refusal while any connection holds version 2 or later', () => {
    const c = code(RB);
    expect(c.trim().startsWith("SET LOCAL lock_timeout = '3s';\nLOCK TABLE public.mcp_authorization_requests IN EXCLUSIVE MODE;")).toBe(true);
    expect(RB).toContain('SELECT count(*) INTO n FROM public.mcp_connections c WHERE c.notice_version >= 2;');
    expect(RB).toMatch(/IF n > 0 THEN\n\s+RAISE EXCEPTION 'ROLLBACK 20261123150000: % connection\(s\) hold approval page version 2 or later/);
    expect(c.indexOf('IF n > 0 THEN')).toBeLessThan(c.indexOf('UPDATE public.mcp_settings'));
  });

  it('sets the version back to 1 and drops both triggers and the three functions, checking the bodies it drops first', () => {
    expect(RB).toContain('UPDATE public.mcp_settings s SET notice_version = 1, updated_at = now() WHERE s.id AND s.notice_version = 2;');
    expect(RB).toContain('DROP TRIGGER IF EXISTS mcp_connections_version_fixed ON public.mcp_connections;');
    expect(RB).toContain('DROP TRIGGER IF EXISTS mcp_settings_notice_change_expires_requests ON public.mcp_settings;');
    for (const f of NEW_FUNCS) {
      expect(RB).toContain(`DROP FUNCTION IF EXISTS public.${f};`);
      const name = f.slice(0, f.indexOf('('));
      expect(RB).toContain(`('public.${f}', '${md5(fnBody(MIG, name))}')`);
    }
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123150000';");
  });
});

describe('BACKLOG-4263 T-N harness files are current', () => {
  it.each(['harness-n.sql', 'harness-n-structure.sql', 'harness-n-fixtures.sql'])('%s names the migration md5 it was generated from', (f) => {
    const t = read(`${DIR}/${f}`);
    expect(t).toContain(`(file md5 ${md5(MIG)})`);
    expect(t.split('\n')[1]).toContain('must never be run on production');
    expect(t).toContain("SET LOCAL statement_timeout = '240s';");
  });

  it('the full call carries every control, every mutant once and the negative control', () => {
    const t = read(`${DIR}/harness-n.sql`);
    const controls = [...t.matchAll(/^CREATE FUNCTION pg_temp\.(c_n\w+)\(\)/gm)].map((m) => m[1]);
    expect(controls.length).toBeGreaterThanOrEqual(15);
    for (const c of controls) expect(t).toContain(`res := pg_temp.${c}();`);
    const mutants = [...t.matchAll(/PERFORM pg_temp\.rec\('mutant:(\w+)'/g)].map((m) => m[1]);
    expect(mutants).toContain('noop_probe');
    expect(new Set(mutants).size).toBe(mutants.length);
    expect(mutants.length).toBeGreaterThanOrEqual(16);
    for (const m of ['backfill_before_trigger', 'expire_trigger_dropped', 'fixed_trigger_dropped', 'reader_granted_service_role']) expect(mutants).toContain(m);
  });

  it('the answer report is current and has no finding', () => {
    const rep = read(`${DIR}/answers-report.txt`);
    expect(rep).toMatch(/^findings 0$/m);
    for (const m of rep.matchAll(/^input ([0-9a-f]{32}) (\S+)$/gm)) expect(`${m[2]} ${md5(read(m[2]))}`).toBe(`${m[2]} ${m[1]}`);
  });

  it('every harness helper that reads a public table is VOLATILE', () => {
    const h = read(`${DIR}/lib/helpers.sql`);
    for (const m of h.matchAll(/CREATE FUNCTION pg_temp\.(\w+)\([^)]*\) RETURNS [^\n]*? LANGUAGE sql (\w+ )?AS \$h\$([\s\S]*?)\$h\$/g)) {
      if (/FROM public\./.test(m[3])) expect(`${m[1]} ${(m[2] ?? '').trim()}`).toBe(`${m[1]} VOLATILE`);
    }
  });
});
