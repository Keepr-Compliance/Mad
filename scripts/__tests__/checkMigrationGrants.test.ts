/**
 * Tests for scripts/ci/check-migration-grants.mjs (BACKLOG-3611).
 *
 * Runs in CI: jest.config.js `testMatch` includes '<rootDir>/scripts/__tests__/**'.
 * The guard is spawned as a subprocess (same as auditGuard.test.ts), so the
 * exact CLI that CI runs is what is tested.
 *
 * ## Fixtures are transcripts, not inventions
 *
 *   fixtures/migration-grants/real/       Verbatim copies of real migrations. Must PASS.
 *     20261001044453_backlog_3611_function_execute_grants.sql   supabase/migrations
 *     20261001044523_backlog_3646_support_agent_checks.sql      supabase/migrations
 *     20261001050116_backlog_3549_revoke_truncate.sql           supabase/migrations
 *     20261001054306_backlog_3618_agent_checklist_templates.sql supabase/migrations
 *     20261003030219_backlog_3611_license_self_only.sql         branch fix/BACKLOG-3611-license-self-only @ cee77b925
 *     20261003030614_backlog_3611_r1_service_only_grants.sql    branch fix/BACKLOG-3611-r1-service-only @ 521355fb8
 *   fixtures/migration-grants/base/       Verbatim copies of the older migrations that first
 *                                         created the five functions 3646 re-creates. This is
 *                                         the "base branch" catalog for the re-create exemption.
 *   fixtures/migration-grants/negative/
 *     20260308_cleanup_expired_impersonation_sessions.sql  verbatim: REVOKE ALL ... FROM PUBLIC
 *                                         only, anon not named -> FAIL; definer body with no
 *                                         auth.uid()/auth.role() -> WARN.
 *     new_function_no_revoke.sql          044453 lines 1-22, function renamed, REVOKE removed.
 *     new_function_intentionally_public.sql       the same plus an `-- Intentionally callable by anon:` marker.
 *     new_table_no_truncate_revoke.sql    20260906000000_backlog_2077 lines 47-75, renamed.
 *     new_table_with_truncate_revoke.sql  the same plus the TRUNCATE revoke.
 *
 * The inline cases below are built from the new_function_no_revoke.sql text so the SQL
 * shape (dollar-quoted plpgsql body, SECURITY DEFINER, DEFAULT args) is the real one.
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
const GUARD = path.join(REPO, 'scripts', 'ci', 'check-migration-grants.mjs');
const FIX = path.join(__dirname, 'fixtures', 'migration-grants');
const BASE = path.join(FIX, 'base');
const EMPTY_CATALOG = path.join(FIX, 'negative'); // has none of the 3646 functions

interface Finding {
  line: number;
  rule: string;
  object: string;
  message: string;
}
interface FileResult {
  file: string;
  failures: Finding[];
  warnings: Finding[];
  passes: { line: number; object: string; reason: string }[];
}
interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  json?: { files: FileResult[]; failCount: number; warnCount: number };
}

/**
 * The environment with every GIT_* variable removed.
 *
 * A git hook (pre-push) runs with GIT_DIR, GIT_INDEX_FILE etc. exported. A git
 * command in a child process inherits them and acts on THAT repository instead
 * of the one in its cwd. Measured during this PR: the scratch-repo `git init`
 * below, run from the pre-push hook, re-initialised the real repository and set
 * `core.bare = true` in its shared config. Every git call this file makes, and
 * every guard it spawns, gets this scrubbed environment.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GITHUB_ACTIONS = '';
  return env;
}

function run(args: string[], cwd = REPO): Result {
  const res = spawnSync(process.execPath, [GUARD, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  const out: Result = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  if (args.includes('--json') && res.status !== 2) out.json = JSON.parse(res.stdout);
  return out;
}

function check(files: string[], catalogDir?: string): Result {
  const args = ['--json', '--files', ...files];
  if (catalogDir) args.push('--catalog-dir', catalogDir);
  return run(args);
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'migration-grants-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let counter = 0;
function sqlFile(sql: string, name?: string): string {
  counter += 1;
  const p = path.join(tmp, name ?? `case_${counter}.sql`);
  writeFileSync(p, sql);
  return p;
}

const NEW_FN = readFileSync(path.join(FIX, 'negative', 'new_function_no_revoke.sql'), 'utf8');
const SIG = 'public.support_update_template_copy(uuid, text, text, text, boolean)';

function rules(r: Result): string[] {
  return r.json!.files.flatMap((f) => f.failures.map((x) => x.rule));
}

describe('real migrations pass', () => {
  const real = [
    '20261001044453_backlog_3611_function_execute_grants.sql',
    '20261001044523_backlog_3646_support_agent_checks.sql',
    '20261001050116_backlog_3549_revoke_truncate.sql',
    '20261001054306_backlog_3618_agent_checklist_templates.sql',
    '20261003030219_backlog_3611_license_self_only.sql',
    '20261003030614_backlog_3611_r1_service_only_grants.sql',
  ];
  it.each(real)('%s', (name) => {
    const r = check([path.join(FIX, 'real', name)], BASE);
    expect(r.json!.failCount).toBe(0);
    expect(r.status).toBe(0);
  });

  it('3646 passes through the re-create exemption, one pass per function', () => {
    const r = check([path.join(FIX, 'real', real[1])], BASE);
    const reasons = r.json!.files[0].passes.map((p) => `${p.object} | ${p.reason}`);
    expect(reasons).toEqual([
      'public.support_search_requesters(text) | re-create of an existing function; its grants are unchanged',
      'public.support_requester_recent_tickets(text) | re-create of an existing function; its grants are unchanged',
      'public.support_agent_analytics(integer) | re-create of an existing function; its grants are unchanged',
      'public.support_get_related_tickets(uuid) | re-create of an existing function; its grants are unchanged',
      'public.support_search_tickets_for_link(text,uuid) | re-create of an existing function; its grants are unchanged',
    ]);
  });

  it('3646 FAILS without the base catalog: the exemption is what passes it', () => {
    const r = check([path.join(FIX, 'real', real[1])], EMPTY_CATALOG);
    expect(r.status).toBe(1);
    expect(rules(r)).toEqual(Array(5).fill('function-missing-revoke'));
  });

  it('044453 matches a REVOKE written without parameter names or DEFAULTs', () => {
    const r = check([path.join(FIX, 'real', real[0])]);
    expect(r.json!.files[0].passes[0].reason).toBe('EXECUTE revoked from PUBLIC and anon');
  });
});

describe('negative fixtures', () => {
  it('a new function with no REVOKE fails', () => {
    const r = check([path.join(FIX, 'negative', 'new_function_no_revoke.sql')], BASE);
    expect(r.status).toBe(1);
    expect(rules(r)).toEqual(['function-missing-revoke']);
  });

  it('a REVOKE naming PUBLIC but not anon fails, and the definer warning fires', () => {
    const r = check([path.join(FIX, 'negative', '20260308_cleanup_expired_impersonation_sessions.sql')]);
    expect(r.status).toBe(1);
    const f = r.json!.files[0];
    expect(f.failures.map((x) => x.rule)).toEqual(['function-missing-revoke']);
    expect(f.failures[0].message).toContain('FROM anon in this file');
    expect(f.warnings.map((x) => x.rule)).toEqual(['definer-without-caller-check']);
  });

  it('the intentionally-public marker passes', () => {
    const r = check([path.join(FIX, 'negative', 'new_function_intentionally_public.sql')]);
    expect(r.status).toBe(0);
    expect(r.json!.files[0].passes[0].reason).toBe('intentionally-public marker');
  });

  it('a new table with no TRUNCATE revoke fails', () => {
    const r = check([path.join(FIX, 'negative', 'new_table_no_truncate_revoke.sql')]);
    expect(r.status).toBe(1);
    expect(rules(r)).toEqual(['table-missing-truncate-revoke']);
  });

  it('a new table with the TRUNCATE revoke passes', () => {
    const r = check([path.join(FIX, 'negative', 'new_table_with_truncate_revoke.sql')]);
    expect(r.status).toBe(0);
  });
});

describe('lexing: REVOKE text that is not a statement does not count', () => {
  it('a REVOKE inside a dollar-quoted body', () => {
    const sql = NEW_FN.replace(
      'RETURN jsonb_build_object',
      `EXECUTE 'REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon';\n  RETURN jsonb_build_object`,
    );
    expect(sql).not.toBe(NEW_FN);
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a REVOKE statement inside a plpgsql function body', () => {
    // Directly after a `;` inside the body, so a lexer that splits bodies on
    // semicolons would see a statement starting with REVOKE.
    const sql = NEW_FN.replace('  END IF;\n', `  END IF;\n  REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;\n`);
    expect(sql).not.toBe(NEW_FN);
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a REVOKE inside a DO block', () => {
    const sql = `${NEW_FN}\nDO $$ BEGIN PERFORM 1; REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon; END $$;\n`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a REVOKE in a line comment and in a block comment', () => {
    const sql = `${NEW_FN}\n-- REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;\n/* REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon; */\n`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a REVOKE inside a string literal', () => {
    const sql = `${NEW_FN}\nCOMMENT ON FUNCTION ${SIG} IS 'REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;';\n`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });
});

describe('REVOKE / GRANT replay', () => {
  it('PUBLIC and anon revoked in two statements passes', () => {
    const sql = `${NEW_FN}\nREVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC;\nREVOKE ALL ON FUNCTION ${SIG} FROM anon;\n`;
    expect(check([sqlFile(sql)]).status).toBe(0);
  });

  it('a GRANT to anon after the REVOKE fails', () => {
    const sql = `${NEW_FN}\nREVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION ${SIG} TO anon, authenticated;\n`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-granted-to-anon']);
  });

  it('REVOKE GRANT OPTION FOR does not count', () => {
    const sql = `${NEW_FN}\nREVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;\n`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('REVOKE ... ON ALL FUNCTIONS IN SCHEMA public counts', () => {
    const sql = `${NEW_FN}\nREVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;\n`;
    expect(check([sqlFile(sql)]).status).toBe(0);
  });
});

describe('re-creating an existing function (catalog = base/)', () => {
  // support_agent_analytics(p_period_days INT DEFAULT 30) is created in
  // base/20260313_support_analytics_rpc.sql.
  const RECREATE = readFileSync(path.join(FIX, 'real', '20261001044523_backlog_3646_support_agent_checks.sql'), 'utf8')
    .split('\n')
    .slice(71, 131)
    .join('\n');

  it('the slice is the support_agent_analytics statement', () => {
    expect(RECREATE).toMatch(/^CREATE OR REPLACE FUNCTION public\.support_agent_analytics\(/);
    expect(RECREATE.trimEnd()).toMatch(/\$function\$\n;$/);
  });

  it('plain re-create passes (INT in the base, integer in the re-create)', () => {
    expect(check([sqlFile(RECREATE)], BASE).status).toBe(0);
  });

  it('re-create after DROP FUNCTION fails (DROP resets the grants)', () => {
    const sql = `DROP FUNCTION IF EXISTS public.support_agent_analytics(integer);\n${RECREATE}`;
    const r = check([sqlFile(sql)], BASE);
    expect(rules(r)).toEqual(['function-missing-revoke']);
    expect(r.json!.files[0].failures[0].message).toContain('drops and re-creates');
  });

  it('re-create with a GRANT to PUBLIC fails', () => {
    const sql = `${RECREATE}\nGRANT EXECUTE ON FUNCTION public.support_agent_analytics(integer) TO PUBLIC;\n`;
    expect(rules(check([sqlFile(sql)], BASE))).toEqual(['function-granted-to-anon']);
  });

  it('a changed argument list is a NEW overload and fails', () => {
    const sql = RECREATE.replace(
      'support_agent_analytics(p_period_days integer DEFAULT 30)',
      'support_agent_analytics(p_period_days integer DEFAULT 30, p_agent uuid DEFAULT NULL)',
    );
    expect(sql).not.toBe(RECREATE);
    expect(rules(check([sqlFile(sql)], BASE))).toEqual(['function-missing-revoke']);
  });

  it('CREATE without OR REPLACE is never treated as a re-create', () => {
    const sql = RECREATE.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
    expect(rules(check([sqlFile(sql)], BASE))).toEqual(['function-missing-revoke']);
  });
});

describe('overloads and identifiers', () => {
  const second = NEW_FN.replace(
    /\(p_id uuid, p_name text, p_body text, p_category text DEFAULT NULL::text, p_is_active boolean DEFAULT true\)/,
    '(p_id uuid, p_name text)',
  );

  it('two overloads, REVOKE names one signature: the other fails', () => {
    expect(second).not.toBe(NEW_FN);
    const sql = `${NEW_FN}\n${second}\nREVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon;\n`;
    const r = check([sqlFile(sql)]);
    expect(r.json!.files[0].failures.map((f) => f.object)).toEqual([
      'public.support_update_template_copy(uuid,text)',
    ]);
  });

  it('a REVOKE without an argument list covers every overload', () => {
    const sql = `${NEW_FN}\n${second}\nREVOKE EXECUTE ON FUNCTION public.support_update_template_copy FROM PUBLIC, anon;\n`;
    expect(check([sqlFile(sql)]).status).toBe(0);
  });

  it('quoted identifier: matching quoted REVOKE passes, unquoted REVOKE fails', () => {
    const quoted = NEW_FN.replace('public.support_update_template_copy(', 'public."Support_Copy"(');
    const ok = `${quoted}\nREVOKE EXECUTE ON FUNCTION public."Support_Copy"(uuid, text, text, text, boolean) FROM PUBLIC, anon;\n`;
    const bad = `${quoted}\nREVOKE EXECUTE ON FUNCTION public.support_copy(uuid, text, text, text, boolean) FROM PUBLIC, anon;\n`;
    expect(check([sqlFile(ok)]).status).toBe(0);
    expect(rules(check([sqlFile(bad)]))).toEqual(['function-missing-revoke']);
  });

  it('a function in another schema is not checked', () => {
    const sql = NEW_FN.replace('public.support_update_template_copy(', 'private.support_update_template_copy(');
    expect(check([sqlFile(sql)]).status).toBe(0);
  });
});

describe('markers and exemptions', () => {
  it('the retired `-- anon-allowed:` spelling does not pass', () => {
    const sql = `-- anon-allowed: public support form\n${NEW_FN}`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a marker with no reason does not pass', () => {
    const sql = `-- Intentionally callable by anon:\n${NEW_FN}`;
    expect(rules(check([sqlFile(sql)]))).toEqual(['function-missing-revoke']);
  });

  it('a trigger function needs no REVOKE', () => {
    const sql = `CREATE OR REPLACE FUNCTION public.touch_updated_at()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$\nBEGIN NEW.updated_at = now(); RETURN NEW; END;\n$$;\n`;
    const r = check([sqlFile(sql)]);
    expect(r.status).toBe(0);
    expect(r.json!.warnCount).toBe(0);
  });
});

describe('tables', () => {
  const TABLE = readFileSync(path.join(FIX, 'negative', 'new_table_no_truncate_revoke.sql'), 'utf8');

  it('REVOKE ALL counts; REVOKE ... ON ALL TABLES IN SCHEMA public counts', () => {
    expect(check([sqlFile(`${TABLE}\nREVOKE ALL ON TABLE public.account_suspensions_copy FROM anon, authenticated;\n`)]).status).toBe(0);
    expect(check([sqlFile(`${TABLE}\nREVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;\n`)]).status).toBe(0);
  });

  it('naming only anon fails', () => {
    const r = check([sqlFile(`${TABLE}\nREVOKE TRUNCATE ON public.account_suspensions_copy FROM anon;\n`)]);
    expect(rules(r)).toEqual(['table-missing-truncate-revoke']);
  });

  it('a GRANT ALL to authenticated after the revoke fails', () => {
    const r = check([
      sqlFile(
        `${TABLE}\nREVOKE TRUNCATE ON public.account_suspensions_copy FROM anon, authenticated;\nGRANT ALL ON public.account_suspensions_copy TO authenticated;\n`,
      ),
    ]);
    expect(rules(r)).toEqual(['table-missing-truncate-revoke']);
  });

  it('temp tables and other schemas are not checked', () => {
    const temp = TABLE.replace('CREATE TABLE IF NOT EXISTS public.account_suspensions_copy', 'CREATE TEMP TABLE account_suspensions_copy');
    const other = TABLE.replace('CREATE TABLE IF NOT EXISTS public.', 'CREATE TABLE IF NOT EXISTS audit.');
    expect(temp).not.toBe(TABLE);
    expect(other).not.toBe(TABLE);
    expect(check([sqlFile(temp)]).status).toBe(0);
    expect(check([sqlFile(other)]).status).toBe(0);
  });
});

describe('PR mode (--base): only files ADDED under supabase/migrations', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanEnv(),
    });

  beforeAll(() => {
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(repo, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(path.join(repo, 'supabase', 'parked'), { recursive: true });
    git('init', '-q', '-b', 'base');
    // Belt and braces: the scratch repo must be its own top level, never the real repo.
    expect(path.resolve(git('rev-parse', '--show-toplevel').trim())).toBe(path.resolve(fs.realpathSync(repo)));
    // An old migration with no REVOKE (grandfathered) that also creates support_agent_analytics.
    writeFileSync(
      path.join(repo, 'supabase', 'migrations', '20260313_support_analytics_rpc.sql'),
      readFileSync(path.join(BASE, '20260313_support_analytics_rpc.sql'), 'utf8'),
    );
    writeFileSync(path.join(repo, 'supabase', 'parked', '20261005_parked.sql'), NEW_FN);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'head');
  });

  it('no added migration: exit 0, nothing to check', () => {
    const r = run(['--base', 'base'], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no migration files added');
  });

  it('a modified existing migration is not checked; an added one is; a re-create uses the base catalog', () => {
    const old = path.join(repo, 'supabase', 'migrations', '20260313_support_analytics_rpc.sql');
    writeFileSync(old, `${readFileSync(old, 'utf8')}\n-- edited\n`);
    const recreate = readFileSync(path.join(FIX, 'real', '20261001044523_backlog_3646_support_agent_checks.sql'), 'utf8')
      .split('\n')
      .slice(71, 131)
      .join('\n');
    writeFileSync(path.join(repo, 'supabase', 'migrations', '20261004_recreate.sql'), recreate);
    writeFileSync(path.join(repo, 'supabase', 'migrations', '20261004_new.sql'), NEW_FN);
    git('add', '-A');
    git('commit', '-q', '-m', 'head');
    const r = run(['--json', '--base', 'base'], repo);
    expect(r.status).toBe(1);
    const byFile = Object.fromEntries(r.json!.files.map((f) => [f.file, f.failures.map((x) => x.rule)]));
    expect(byFile).toEqual({
      'supabase/migrations/20261004_new.sql': ['function-missing-revoke'],
      'supabase/migrations/20261004_recreate.sql': [],
    });
  });

  it('a file moved in from supabase/parked counts as added', () => {
    renameSync(
      path.join(repo, 'supabase', 'parked', '20261005_parked.sql'),
      path.join(repo, 'supabase', 'migrations', '20261005_parked.sql'),
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'move');
    const r = run(['--json', '--base', 'base'], repo);
    expect(r.json!.files.map((f) => f.file)).toContain('supabase/migrations/20261005_parked.sql');
  });

  it('an unresolvable base ref exits 2', () => {
    expect(run(['--base', 'no-such-ref'], repo).status).toBe(2);
  });
});

describe('usage', () => {
  it('no arguments exits 2', () => {
    expect(run([]).status).toBe(2);
  });
  it('an unreadable file exits 2', () => {
    expect(run(['--files', path.join(tmp, 'missing.sql')]).status).toBe(2);
  });
});
