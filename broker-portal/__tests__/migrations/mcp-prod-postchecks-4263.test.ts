/**
 * BACKLOG-4263 — CI tripwire for the production post-checks in supabase/tests/backlog-4263-prod/.
 *
 * WHAT THIS CAN PROVE: that the post-check files agree with the migration files at HEAD. CI has no database.
 * - one post-check per hosted-MCP migration (a new one without a post-check turns this red);
 * - every function body a post-check pins has the md5 of the body in the migration text (extracted here,
 *   independently of gen.py), and each file pins exactly the functions its migration defines;
 * - each post-check is one read-only SELECT: no data-changing or schema-changing keyword outside string
 *   literals, no count(*), no literal UUID;
 * - labels: only four kinds may be REPORT ONLY, and no assertion about PUBLIC, anon, authenticated, service_role or
 *   mcp_reader is REPORT ONLY (one named service_role exception for tables created before the lane).
 * The post-checks themselves were run on the test project (supabase/tests/backlog-4263-prod-verify/verify-run.sql and
 * verify-controls.sql).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS = join(REPO, 'supabase/migrations');
const DIR = join(REPO, 'supabase/tests/backlog-4263-prod');
const VERIFY_DIR = join(REPO, 'supabase/tests/backlog-4263-prod-verify');
const FIRST = '20261118100000';
const LAST = '20261118190000';
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/**
 * The lane's migrations: every file in the version range, and every later migration that names an mcp_, _mcp_,
 * cloud_, _cloud_ or ai_app_ object (it needs its own post-check, or an entry in NOT_LANE with the reason).
 */
const NOT_LANE: Record<string, string> = {};
const LANE_OBJECT = /\b_?(mcp|cloud)_\w+|\bai_app_\w+/;
const LANE = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= FIRST && !(f in NOT_LANE))
  .filter((f) => f.slice(0, 14) <= LAST || LANE_OBJECT.test(readFileSync(join(MIGRATIONS, f), 'utf8')))
  .sort();
const VERSIONS = LANE.map((f) => f.slice(0, 14));

/** name -> body (dollar-quoted text exactly as written) of each top-level CREATE FUNCTION, last definition wins. */
function bodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const as = /\bAS (\$[A-Za-z_]*\$)/g;
    as.lastIndex = m.index;
    const a = as.exec(sql);
    if (!a) throw new Error(`${m[1]}: no body`);
    const start = a.index + a[0].length;
    const end = sql.indexOf(a[1], start);
    if (end < 0) throw new Error(`${m[1]}: body not closed`);
    out.set(m[1], sql.slice(start, end));
  }
  return out;
}
const dropped = (sql: string): string[] => [...sql.matchAll(/^DROP FUNCTION (?:IF EXISTS )?public\.(\w+)\(/gm)].map((m) => m[1]);

/** The function rows a post-check pins: name -> md5. */
function pinned(pc: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of pc.matchAll(/^ {4}\('public\.(\w+)\([^)]*\)', '([0-9a-f]{32})',/gm)) {
    if (out.has(m[1])) throw new Error(`${m[1]} pinned twice`);
    out.set(m[1], m[2]);
  }
  return out;
}
const absent = (pc: string): string[] =>
  [...pc.slice(pc.indexOf('gone(sig)'), pc.indexOf('rel(name')).matchAll(/\('public\.(\w+)\(/g)].map((m) => m[1]);

/**
 * The SQL with comments and string literals removed: `--` to end of line, `/* ... *\/` blocks, '...' literals (with ''
 * escapes) and "..." identifiers. A dollar-quoted body is kept as code (so a DO block's or function's text stays
 * visible to the keyword scan), and the files here must hold none.
 */
function code(pc: string): string {
  let out = '';
  let i = 0;
  while (i < pc.length) {
    if (pc.startsWith('--', i)) {
      const j = pc.indexOf('\n', i);
      i = j < 0 ? pc.length : j;
    } else if (pc.startsWith('/*', i)) {
      const j = pc.indexOf('*/', i + 2);
      if (j < 0) throw new Error('unclosed comment');
      out += ' ';
      i = j + 2;
    } else if (pc[i] === '"') {
      const j = pc.indexOf('"', i + 1);
      if (j < 0) throw new Error('unclosed identifier');
      out += '""';
      i = j + 1;
    } else if (pc[i] === "'") {
      let j = i + 1;
      for (;;) {
        j = pc.indexOf("'", j);
        if (j < 0) throw new Error('unclosed literal');
        if (pc[j + 1] === "'") j += 2;
        else break;
      }
      out += "''";
      i = j + 1;
    } else {
      out += pc[i];
      i += 1;
    }
  }
  return out;
}

const REPORT_KINDS = [
  'grants to other roles',
  'check definition text',
  'index predicate text',
  'pre-lane table grants to service_role',
];
const API = ['PUBLIC', 'anon', 'authenticated', 'service_role', 'mcp_reader'];
/** The rows of one VALUES CTE, each as its list of single-quoted values. */
function cte(pc: string, head: string): string[][] {
  const i = pc.indexOf(`${head} AS (VALUES\n`);
  if (i < 0) return [];
  const body = pc.slice(i, pc.indexOf(')),\n', i) + 2);
  return [...body.matchAll(/^ {4}\((.*)\),?$/gm)].map((m) => [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]));
}

/** Write statements and anything that can change state; matched after comments and literals are removed. */
const WRITE =
  /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE|SET\s+ROLE|SET|DO|COMMENT|SECURITY\s+LABEL|CALL|COPY|REFRESH|VACUUM|LOCK)\b/gi;

const MIG = new Map(LANE.map((f) => [f.slice(0, 14), read(join(MIGRATIONS, f))]));
const FILE = (k: string): string => join(DIR, `postcheck-${k}.sql`);

describe('BACKLOG-4263 production post-checks', () => {
  it('has one post-check per hosted-MCP migration, and no other', () => {
    expect(VERSIONS.length).toBeGreaterThanOrEqual(10);
    const files = readdirSync(DIR)
      .filter((f) => /^postcheck-\d{14}\.sql$/.test(f))
      .map((f) => f.slice(10, 24))
      .sort();
    expect(files).toEqual(VERSIONS);
    expect(existsSync(FILE('final'))).toBe(true);
  });

  it.each(VERSIONS)('postcheck-%s pins exactly the functions its migration defines, at the body md5 of the migration text', (v) => {
    const pc = read(FILE(v));
    const defined = bodies(MIG.get(v)!);
    const pins = pinned(pc);
    expect(defined.size).toBeGreaterThan(0);
    expect([...pins.keys()].sort()).toEqual([...defined.keys()].sort());
    for (const [name, body] of defined) expect(`${name} ${pins.get(name)}`).toBe(`${name} ${md5(body)}`);
    expect(absent(pc).sort()).toEqual(dropped(MIG.get(v)!).filter((n) => !defined.has(n)).sort());
    expect(pc).toContain(`(migration file md5 ${md5(MIG.get(v)!)})`);
  });

  it('postcheck-final pins every function of the lane at its latest body, and the dropped ones as absent', () => {
    const latest = new Map<string, string>();
    for (const v of VERSIONS) {
      for (const n of dropped(MIG.get(v)!)) latest.delete(n);
      for (const [n, b] of bodies(MIG.get(v)!)) latest.set(n, b);
    }
    const pc = read(FILE('final'));
    const pins = pinned(pc);
    expect([...pins.keys()].sort()).toEqual([...latest.keys()].sort());
    for (const [name, body] of latest) expect(`${name} ${pins.get(name)}`).toBe(`${name} ${md5(body)}`);
    const everDropped = VERSIONS.flatMap((v) => dropped(MIG.get(v)!)).filter((n) => !latest.has(n));
    expect(absent(pc).sort()).toEqual([...new Set(everDropped)].sort());
    for (const v of VERSIONS) expect(pc).toContain(`('${v}')`);
  });

  it('the production folder holds only read-only files: no verify-* file, and no write statement in any .sql file', () => {
    const files = readdirSync(DIR);
    expect(files.filter((f) => f.startsWith('verify-'))).toEqual([]);
    const sql = files.filter((f) => f.endsWith('.sql')).sort();
    expect(sql.length).toBe(VERSIONS.length + 1);
    for (const f of sql) {
      const c = code(read(join(DIR, f)));
      expect(`${f}: ${(c.match(WRITE) || []).join(',')}`).toBe(`${f}: `);
      expect(`${f}: ${c.includes('$')}`).toBe(`${f}: false`);
    }
  });

  it('the test-database controls file starts with the guard that refuses production, before any write', () => {
    const vc = read(join(VERIFY_DIR, 'verify-controls.sql'));
    const first = code(vc).trimStart();
    expect(first.startsWith('DO $guard4263verify$')).toBe(true);
    const g = vc.slice(vc.indexOf('DO $guard4263verify$'), vc.indexOf('$guard4263verify$;') + 18);
    expect(code(vc.slice(0, vc.indexOf('DO $guard4263verify$'))).trim()).toBe('');
    expect(g).toContain("to_regclass('public.pm_backlog_items')");
    expect(g).toMatch(/IF n > 100 THEN\n\s+RAISE EXCEPTION 'verify-controls\.sql refuses to run: TEST DATABASE ONLY/);
    expect(g).toMatch(/IF NOT EXISTS \(SELECT 1 FROM auth\.users u WHERE md5\(u\.id::text\) = '[0-9a-f]{32}'\) THEN\n\s+RAISE EXCEPTION/);
    expect(vc.split('\n')[0]).toContain('must never be run on production');
    expect(read(join(VERIFY_DIR, 'verify-run.sql')).split('\n')[0]).toContain('must never be run on production');
  });

  it.each([...VERSIONS, 'final'])('postcheck-%s is one read-only SELECT', (k) => {
    const pc = read(FILE(k));
    const c = code(pc);
    expect(c).not.toMatch(new RegExp(WRITE.source, 'i'));
    expect(c).not.toMatch(/\b(EXECUTE|PERFORM|BEGIN|COMMIT|RESET|MERGE)\b/i);
    expect(c).not.toContain('$');
    expect(pc).not.toMatch(/count\s*\(/i);
    expect(pc).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(pc).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(c.trim()).toMatch(/^WITH\b/);
    expect(c.split(';').length).toBe(2);
    expect(c.trim().endsWith(';')).toBe(true);
    expect(pc).toContain(`'POSTCHECK ${k} FAILED: '`);
  });

  it.each([...VERSIONS, 'final'])('postcheck-%s labels: report-only only for the four named kinds, never for an API role', (k) => {
    const pc = read(FILE(k));
    const rules = [...pc.slice(pc.indexOf('rule(kind, must) AS (VALUES'), pc.indexOf('checks(id, kind')).matchAll(/\('([^']+)', (true|false)\)/g)];
    expect(rules.length).toBeGreaterThan(5);
    const report = rules.filter((r) => r[2] === 'false').map((r) => r[1]);
    for (const kind of report) expect(REPORT_KINDS).toContain(kind);
    expect(pc).toContain('coalesce(r.must, true)');
    const isReport = (kind: string): boolean => report.includes(kind);
    const fx = cte(pc, 'fx(sig, role, want, kind)');
    const rx = cte(pc, 'rx(name, src, role, want, kind)');
    expect(fx.length + rx.length).toBeGreaterThan(0);
    for (const [sig, role, , kind] of fx) {
      if (API.includes(role)) expect(`${sig} ${role} ${isReport(kind)}`).toBe(`${sig} ${role} false`);
    }
    for (const [name, src, role, , kind] of rx) {
      const allowed = role === 'service_role' && src === 'table' && kind === 'pre-lane table grants to service_role';
      if (API.includes(role) && !allowed) expect(`${name} ${role} ${isReport(kind)}`).toBe(`${name} ${role} false`);
    }
    expect(pc).toMatch(/AS postcheck,\n\s+coalesce\(f\.rep, ''\) AS report_only/);
  });

  it('the apply file for 20261118100000 holds the migration as it is at HEAD', () => {
    const apply = read(join(REPO, 'supabase/tests/backlog-4263/apply-20261118100000.sql'));
    const mig = MIG.get(FIRST)!;
    expect(apply).toContain(`file md5 ${md5(mig)}`);
    expect(apply.includes(mig)).toBe(true);
    expect(apply).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
