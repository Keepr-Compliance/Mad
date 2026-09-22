/**
 * BACKLOG-3503 — the CI tripwire for the commission-agreements migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour, or what a database actually runs. CI has no
 * database. Three of the most consequential mistakes this migration could make
 * — leaving the default ACL's table-wide grant in place, forgetting to switch
 * row-level security on, and leaving TRUNCATE grantable — are about PRIVILEGES
 * and CATALOG STATE, and no assertion over file text can see any of them
 * happening. They are proved by the executable controls in
 * supabase/tests/backlog-3503/, run against a real Postgres.
 *
 * Its job is narrower and worth doing: it pins the decisions a later edit to
 * this file is most likely to undo quietly —
 *
 *   - the ordering contract (`seq DESC`, and NOT `set_at DESC`), which was
 *     reversed on measured evidence and is BACKLOG-3504's read contract;
 *   - the writer role list `('broker', 'admin')`, and that the migration does
 *     not reach for is_org_admin, which is the inverse set;
 *   - SECURITY DEFINER on the write rule and on NEITHER read helper;
 *   - the absence of GRANT UPDATE / GRANT DELETE, and of set_by / set_at from
 *     the INSERT column lists;
 *   - the presence of REVOKE ALL and ENABLE ROW LEVEL SECURITY on both tables,
 *     which are the two omissions with the largest blast radius and which no
 *     other CI check can see at all.
 *
 * Every assertion below was made to FAIL before it was trusted: each mutation
 * was applied to the committed file, this suite run, the failing `it()`
 * recorded, and the file restored. The table is in the BACKLOG-3503 record.
 *
 * Limits, stated:
 *   - It reads repo text only. Whether production matches the repo is the
 *     harness gate's job (supabase/tests/backlog-3503/run.sh gate).
 *   - Comments are stripped before matching, so a rule written only in a
 *     comment cannot satisfy any assertion here. That matters: the file's
 *     header discusses `set_at DESC`, `is_org_admin` and `GRANT UPDATE` in
 *     prose, and without stripping, four of these assertions would be red on a
 *     correct file and green on nothing.
 *   - Comment removal is line-based and quote-aware for single-quoted strings;
 *     a string literal spanning lines and containing `--` would confuse it.
 *     This file has none.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SCHEMA_FILE = '20260922220719_backlog_3503_commission_agreements.sql';

const TABLES = ['agent_commission_agreements', 'organization_franchise_fees'] as const;
const READ_HELPERS = ['commission_agreement_in_force', 'franchise_fee_in_force'] as const;

/** Read a migration with CRLF normalised (Windows CI checks out with CRLF). */
const readMigration = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n?/g, '\n');

/** Remove block comments, then `--` comments (whole-line and trailing) outside single quotes. */
function stripSqlComments(sql: string): string {
  const noBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '-' && line[i + 1] === '-') return line.slice(0, i).replace(/\s+$/, '');
      }
      return line;
    })
    .join('\n');
}

/** Collapse runs of whitespace so multi-line SQL can be matched as one string. */
const flatten = (sql: string): string => sql.replace(/\s+/g, ' ');

const RAW = readMigration(SCHEMA_FILE);
const SQL = stripSqlComments(RAW);
const FLAT = flatten(SQL);

/**
 * The text between a function's opening and closing dollar-quote tags.
 * Throws rather than returning empty: a silently-empty body would make every
 * assertion about that body vacuously true.
 */
function functionBody(name: string): string {
  const header = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i');
  const m = header.exec(SQL);
  if (!m) throw new Error(`${SCHEMA_FILE}: no definition of ${name}`);
  const rest = SQL.slice(m.index);
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
  if (!open) throw new Error(`${SCHEMA_FILE}: ${name} has no opening dollar-quote tag`);
  const bodyStart = open.index + open[0].length;
  const close = rest.indexOf(open[0], bodyStart);
  if (close === -1) throw new Error(`${SCHEMA_FILE}: ${name} has no closing ${open[0]}`);
  const body = rest.slice(bodyStart, close);
  if (body.trim() === '') throw new Error(`${SCHEMA_FILE}: ${name} has an empty body`);
  return body;
}

/** The clause between a function's argument list and its opening dollar quote. */
function functionHeader(name: string): string {
  const header = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i');
  const m = header.exec(SQL);
  if (!m) throw new Error(`${SCHEMA_FILE}: no definition of ${name}`);
  const rest = SQL.slice(m.index);
  const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
  if (!open) throw new Error(`${SCHEMA_FILE}: ${name} has no opening dollar-quote tag`);
  return flatten(rest.slice(0, open.index));
}

/** The parenthesised column list of `GRANT INSERT (...) ON public.<table>`. */
function insertGrantColumns(table: string): string[] {
  const re = new RegExp(`GRANT INSERT \\(([^)]*)\\) ON public\\.${table} TO`, 'i');
  const m = re.exec(FLAT);
  if (!m) throw new Error(`${SCHEMA_FILE}: no column-list GRANT INSERT on ${table}`);
  return m[1].split(',').map((c) => c.trim()).filter(Boolean);
}

describe('BACKLOG-3503 commission agreements migration', () => {
  it('the file is not empty and the harness reads the same file CI does', () => {
    expect(RAW.length).toBeGreaterThan(2000);
    expect(SQL).toContain('CREATE TABLE public.agent_commission_agreements');
    // the executable harness points at this exact stamp
    const runner = readFileSync(join(REPO, 'supabase/tests/backlog-3503/run.sh'), 'utf8');
    expect(runner).toContain(SCHEMA_FILE);
  });

  it('creates both tables', () => {
    for (const t of TABLES) {
      expect(FLAT).toContain(`CREATE TABLE public.${t} (`);
    }
  });

  it('enables row level security on both tables', () => {
    for (const t of TABLES) {
      expect(FLAT).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(FLAT).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
  });

  it('revokes ALL from anon and authenticated on both tables', () => {
    // Not a narrower revoke: the default ACL grants arwdDxtm, and the D is
    // TRUNCATE, which row-level security never evaluates.
    for (const t of TABLES) {
      expect(FLAT).toMatch(new RegExp(`REVOKE ALL ON public\\.${t} FROM anon, authenticated`, 'i'));
    }
    expect(FLAT).not.toMatch(/REVOKE (INSERT|UPDATE|DELETE|SELECT)[^;]*ON public\.(agent_commission_agreements|organization_franchise_fees)/i);
  });

  it('grants no UPDATE and no DELETE on either table', () => {
    expect(FLAT).not.toMatch(/GRANT[^;]*\bUPDATE\b[^;]*ON public\.(agent_commission_agreements|organization_franchise_fees)/i);
    expect(FLAT).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*ON public\.(agent_commission_agreements|organization_franchise_fees)/i);
    expect(FLAT).not.toMatch(/GRANT ALL[^;]*ON public\.(agent_commission_agreements|organization_franchise_fees)/i);
    expect(FLAT).not.toMatch(/FOR (UPDATE|DELETE)\b/i); // no UPDATE/DELETE policy either
  });

  it('keeps set_by and set_at out of both INSERT column lists', () => {
    for (const t of TABLES) {
      const cols = insertGrantColumns(t);
      expect(cols.length).toBeGreaterThan(2);
      expect(cols).not.toContain('set_by');
      expect(cols).not.toContain('set_at');
      expect(cols).toContain('organization_id');
    }
  });

  it('gives set_by a NOT NULL default of auth.uid() on both tables', () => {
    for (const t of TABLES) {
      const create = FLAT.slice(FLAT.indexOf(`CREATE TABLE public.${t} (`));
      expect(create.slice(0, create.indexOf(');'))).toContain('set_by uuid NOT NULL DEFAULT auth.uid()');
    }
  });

  it('orders the read helpers by seq DESC, and never by set_at', () => {
    for (const fn of READ_HELPERS) {
      const body = flatten(functionBody(fn));
      expect(body).toMatch(/ORDER BY [a-z]\.effective_from DESC, [a-z]\.seq DESC/i);
      expect(body).not.toMatch(/set_at/i);
      expect(body).toContain('LIMIT 1');
    }
  });

  it('marks the write rule SECURITY DEFINER with a pinned search_path, and neither read helper', () => {
    const writeRule = functionHeader('can_write_commission_agreements');
    expect(writeRule).toMatch(/SECURITY DEFINER/i);
    expect(writeRule).toMatch(/SET search_path = public/i);
    for (const fn of READ_HELPERS) {
      expect(functionHeader(fn)).not.toMatch(/SECURITY DEFINER/i);
    }
  });

  it('names exactly broker and admin as writers, and never reaches for is_org_admin', () => {
    const body = flatten(functionBody('can_write_commission_agreements'));
    expect(body).toMatch(/m\.role IN \('broker', 'admin'\)/i);
    expect(SQL).not.toMatch(/is_org_admin/i);
    // no other role may appear in the write rule
    expect(body).not.toMatch(/'it_admin'|'agent'|'owner'/i);
  });

  it('carries the split-sum and cadence CHECK constraints', () => {
    expect(FLAT).toContain('CHECK (agent_pct + brokerage_pct = 100)');
    expect(FLAT).toContain("CHECK (office_fee_cadence IN ('monthly', 'annual'))");
  });

  it('writes the INSERT policy member check against the NEW ROW, not against itself', () => {
    expect(FLAT).toContain('m.organization_id = agent_commission_agreements.organization_id');
    expect(FLAT).not.toMatch(/m\.organization_id = m\.organization_id/i);
  });

  it('says in its header that it is not applied to production by this PR', () => {
    expect(RAW).toContain('NOT APPLIED TO PRODUCTION BY THIS PR');
  });

  it('opens no transaction of its own', () => {
    // The harness runs this file inside BEGIN ... ROLLBACK; a COMMIT here would
    // leave the tables on the shared venue and the gate would refuse every
    // later run. run.sh strips these defensively; this keeps the file honest.
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;\s*$/m);
  });
});
