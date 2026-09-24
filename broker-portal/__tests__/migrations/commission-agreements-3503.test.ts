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
 *   - the own-row SELECT policy's TWO terms -- the caller's own rows AND active
 *     membership of the organization that wrote them. A bare
 *     `agent_user_id = auth.uid()` is the shape this pins shut, and it is the
 *     one an edit is most likely to arrive back at, because it reads as
 *     obviously correct on its own;
 *   - `license_status = 'active'` as the spelling of "an active member" -- not a
 *     `NOT IN (...)` list, which would fail OPEN on a state added later -- in
 *     ALL THREE places it is asked: the agent's own-row rule, the broker/admin
 *     rule which fronts all four policies, and the INSERT policy's clause about
 *     the SUBJECT an agreement is written for. A deactivated broker is no more
 *     entitled to the office's splits than a deactivated agent is to their own,
 *     and neither may an agreement be recorded for a deactivated agent;
 *   - SECURITY DEFINER on BOTH RLS helpers and on NEITHER read helper;
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
const RLS_HELPERS = ['can_write_commission_agreements', 'is_active_commission_member'] as const;

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

/**
 * A named policy's whole statement, whitespace-flattened. Throws rather than
 * returning empty: a policy renamed or deleted would otherwise make every
 * assertion about it vacuously true.
 */
function policyBody(name: string): string {
  const start = FLAT.indexOf(`CREATE POLICY ${name} `);
  if (start === -1) throw new Error(`${SCHEMA_FILE}: no policy named ${name}`);
  const end = FLAT.indexOf(';', start);
  if (end === -1) throw new Error(`${SCHEMA_FILE}: policy ${name} is unterminated`);
  const body = FLAT.slice(start, end);
  if (!/USING|WITH CHECK/i.test(body)) throw new Error(`${SCHEMA_FILE}: policy ${name} has no predicate`);
  return body;
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

  it('marks both RLS helpers SECURITY DEFINER with a pinned search_path, and neither read helper', () => {
    for (const fn of RLS_HELPERS) {
      const header = functionHeader(fn);
      expect(header).toMatch(/SECURITY DEFINER/i);
      expect(header).toMatch(/SET search_path = public/i);
    }
    for (const fn of READ_HELPERS) {
      expect(functionHeader(fn)).not.toMatch(/SECURITY DEFINER/i);
    }
  });

  it('gates the own-row read on active membership, never on auth.uid() alone', () => {
    // The reversed decision (BACKLOG-3503). A removed agent has no
    // organization_members row; a deactivated one has a row at
    // license_status 'suspended'. Neither may read, so the policy needs both
    // terms and the membership rule needs the status filter.
    const own = policyBody('agent_commission_agreements_select_own');
    expect(own).toContain('agent_user_id = (SELECT auth.uid())');
    expect(own).toContain('public.is_active_commission_member(');
    // the bare predicate, as the whole USING clause, is what this forbids
    expect(own).not.toMatch(/USING \(agent_user_id = \(SELECT auth\.uid\(\)\)\)/i);
  });

  it('spells active membership as license_status = active, and scopes it to the row\'s org', () => {
    const body = flatten(functionBody('is_active_commission_member'));
    expect(body).toMatch(/m\.license_status = 'active'/i);
    // not a fail-open exclusion list: organization_members.license_status also
    // admits 'pending' and 'expired', and a future fifth state must be denied.
    expect(body).not.toMatch(/license_status\s+(NOT\s+IN|<>|!=)/i);
    expect(body).toMatch(/m\.organization_id = p_org_id/i);
    expect(body).toMatch(/m\.user_id = \(SELECT auth\.uid\(\)\)/i);
  });

  it('names exactly broker and admin as writers, and never reaches for is_org_admin', () => {
    const body = flatten(functionBody('can_write_commission_agreements'));
    expect(body).toMatch(/m\.role IN \('broker', 'admin'\)/i);
    expect(SQL).not.toMatch(/is_org_admin/i);
    // no other role may appear in the write rule
    expect(body).not.toMatch(/'it_admin'|'agent'|'owner'/i);
  });

  it('gates the broker and admin read and write on active membership too', () => {
    // The ruling extended (BACKLOG-3503): a deactivated broker or admin loses
    // the office-wide read and the write, not only the agent their own row. One
    // helper fronts all four policies -- both SELECT and both INSERT, on both
    // tables -- so the term belongs here and nowhere else.
    const body = flatten(functionBody('can_write_commission_agreements'));
    expect(body).toMatch(/m\.license_status = 'active'/i);
    // same fail-closed spelling as the own-row rule: not an exclusion list
    expect(body).not.toMatch(/license_status\s+(NOT\s+IN|<>|!=)/i);
    // ...and in the SAME EXISTS as the role term, so one membership row must
    // carry both. Two separate EXISTS could be satisfied by two different rows:
    // a broker by one, an active member by another.
    expect(body).toMatch(/m\.role IN \('broker', 'admin'\) AND m\.license_status = 'active'\)/i);
    expect(body).toMatch(/m\.organization_id = p_org_id/i);
  });

  it('carries the split-sum and cadence CHECK constraints', () => {
    expect(FLAT).toContain('CHECK (agent_pct + brokerage_pct = 100)');
    expect(FLAT).toContain("CHECK (office_fee_cadence IN ('monthly', 'annual'))");
  });

  it('writes the INSERT policy member check against the NEW ROW, not against itself', () => {
    expect(FLAT).toContain('m.organization_id = agent_commission_agreements.organization_id');
    expect(FLAT).not.toMatch(/m\.organization_id = m\.organization_id/i);
  });

  it('judges the INSERT policy subject by their active period, in the same EXISTS', () => {
    // The founder's rule, refined 2026-09-23 (BACKLOG-3503), which relaxed what
    // this file shipped first: a broker may record an agreement for an agent who
    // has left, as long as its effective date falls inside the period that agent
    // was active. Nothing new may be dated after they left. A REMOVED agent has
    // no membership row at all and is refused by the EXISTS finding nothing.
    //
    // It is pinned here as well as in the executable harness (controls C25 and
    // C27-C29, mutants m36 and m40-m42) because the harness needs a database and
    // CI has none. This assertion is the CI red if the clause is ever flattened.
    const insert = policyBody('agent_commission_agreements_insert_writer');
    expect(insert).toContain('m.user_id = agent_commission_agreements.agent_user_id');
    // Both arms sit in the SAME EXISTS as the subject term, so ONE membership row
    // must carry the whole test: separate EXISTS clauses could be satisfied by
    // the subject's row and by somebody else's active row.
    expect(insert).toMatch(
      /m\.user_id = agent_commission_agreements\.agent_user_id AND \(m\.license_status = 'active' OR \(m\.license_status = 'suspended'/i,
    );
    // The boundary is INCLUSIVE, and the comparison is pinned to UTC rather than
    // left to resolve against whatever timezone the connection happens to carry.
    expect(insert).toMatch(
      /effective_from\s*<=\s*\(m\.deactivated_at AT TIME ZONE 'UTC'\)::date/i,
    );
    // same fail-closed spelling as the other two rules: not an exclusion list
    expect(insert).not.toMatch(/license_status\s+(NOT\s+IN|<>|!=)/i);
  });

  it('keeps the NULL guard on the date arm, which no mutant can pin', () => {
    // `m.deactivated_at IS NOT NULL` is an EQUIVALENT-mutant case: deleting it
    // changes no behaviour, because NULL propagates through the comparison to
    // NULL, NULL is not TRUE, and the row is refused either way. That was
    // measured -- the mutant was written, run against the whole suite, and
    // reddened NOTHING -- so it was removed from the harness rather than shipped
    // as a permanently green mutant.
    //
    // The guard still earns its place: it states the refusal as the INTENT (a
    // suspended row with no recorded date fails closed, deliberately) and keeps
    // that refusal if the comparison is ever rewritten in a form where NULL does
    // not propagate. Since no mutant can hold it, this assertion does.
    const insert = policyBody('agent_commission_agreements_insert_writer');
    expect(insert).toMatch(/m\.deactivated_at IS NOT NULL/i);
  });

  it('records the end of the active period with a TRANSITION-guarded trigger', () => {
    // The date rule rests on deactivated_at meaning "the day they left", which
    // holds only if the column is written once on the move INTO 'suspended'.
    // The SCIM DELETE handler writes 'suspended' unconditionally and both SCIM
    // and directory-sync bump scim_synced_at on already-suspended rows, so a
    // trigger that tested the NEW VALUE would push the date forward on every one
    // of those and silently widen the period. Control C26 and mutant m38 hold
    // this in the harness; this is its CI red.
    expect(FLAT).toContain('ALTER TABLE public.organization_members ADD COLUMN deactivated_at timestamptz');
    const trg = FLAT.slice(FLAT.indexOf('CREATE TRIGGER org_members_track_deactivation'));
    expect(trg).toMatch(/BEFORE UPDATE OF license_status ON public\.organization_members/i);
    expect(trg).toMatch(/WHEN \(OLD\.license_status IS DISTINCT FROM NEW\.license_status\)/i);
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
