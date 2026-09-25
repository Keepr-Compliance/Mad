/**
 * BACKLOG-3519 — the CI tripwire for the commission-figures migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour, or what a database actually runs. CI has no
 * database. The most consequential mistake this migration could make — the
 * split-sum CHECK admitting an asymmetric fill because a Postgres CHECK is
 * satisfied on NULL, not just on TRUE — is about CONSTRAINT EVALUATION, and no
 * assertion over file text can see that happening. It is proved by the
 * executable probes in supabase/tests/backlog-3519/, run against a real
 * Postgres (see that harness's README for the measured before/after).
 *
 * Its job is narrower and worth doing: it pins the decisions a later edit to
 * this file is most likely to undo quietly —
 *
 *   - the split-sum CHECK requires BOTH `split_agent_pct` and
 *     `split_brokerage_pct` to be explicitly `IS NOT NULL` before comparing
 *     their sum. This is the actual shipped fix for a real bug found by
 *     executing the migration: `agent_pct + brokerage_pct = 100` alone
 *     evaluates to NULL (not FALSE) when one side is NULL, and a CHECK only
 *     REJECTS an expression that is FALSE — so the "obviously equivalent"
 *     simplification back to a bare sum comparison would silently reopen the
 *     defect;
 *   - the rate precision split: `commission_offered_rate` /
 *     `commission_actual_rate` are `numeric(6,3)`, while
 *     `split_agent_pct` / `split_brokerage_pct` are `numeric(5,2)` — a
 *     deliberate asymmetry (the former can carry a real 3-decimal market
 *     rate like 2.375%; the latter mirrors what they are copied from), and
 *     exactly the kind of "inconsistency" a later cleanup pass would merge
 *     without reading why;
 *   - `split_agreement_id`'s FK carries no `ON DELETE` clause, i.e. Postgres
 *     default `NO ACTION` — the correct semantics for a frozen compliance
 *     snapshot (deleting a referenced agreement must be refused, not cascade
 *     or null out the frozen split), easy to lose if someone adds
 *     `ON DELETE CASCADE` thinking it tidies up orphan prevention;
 *   - the reason CHECK's bounds are `BETWEEN 1 AND 2000` — a zero-length
 *     (post-`btrim`) string is REJECTED, not accepted, matching
 *     `agent_split_agreements.note`'s own convention;
 *   - the migration wraps itself in its own `BEGIN`/`COMMIT` (unlike
 *     BACKLOG-3503's file, which deliberately opens none because ITS harness
 *     supplies the transaction) — this file has no such harness at apply
 *     time, so losing the wrapper would mean a mid-file failure leaves a
 *     partial column/constraint set on a real table;
 *   - the apply-ordering note survives in the header, in some form — it is
 *     the only place a human applying migrations by hand will read it (see
 *     pm_comments on BACKLOG-3503 for the durable, mechanically-findable
 *     copy).
 *
 * Every assertion below was made to FAIL before it was trusted: each mutation
 * was applied to the committed file, this suite run, the failing `it()`
 * recorded, and the file restored.
 *
 * Limits, stated (same as commission-agreements-3503.test.ts, which this
 * mirrors):
 *   - It reads repo text only. Whether production matches the repo is the
 *     harness's job (supabase/tests/backlog-3519/run.sh).
 *   - Comments are stripped before matching, so a rule written only in a
 *     comment cannot satisfy any assertion here.
 *   - Comment removal is line-based and quote-aware for single-quoted
 *     strings; a string literal spanning lines and containing `--` would
 *     confuse it. This file has none.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SCHEMA_FILE = '20260925070000_backlog_3519_commission_figures.sql';

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

/** The full text of a named `ADD CONSTRAINT ... CHECK (...)` clause, up to the next comma or the closing `;`. */
function checkConstraint(name: string): string {
  const start = FLAT.indexOf(`ADD CONSTRAINT ${name}`);
  if (start === -1) throw new Error(`${SCHEMA_FILE}: no constraint named ${name}`);
  // The clause ends at the next top-level ", ADD CONSTRAINT" or the statement's ";" --
  // whichever comes first. A CHECK's own parens are always balanced by then in this file.
  const rest = FLAT.slice(start);
  const nextComma = rest.indexOf(', ADD CONSTRAINT');
  const semi = rest.indexOf(';');
  const end = nextComma === -1 ? semi : Math.min(nextComma, semi === -1 ? Infinity : semi);
  return rest.slice(0, end);
}

describe('BACKLOG-3519 commission figures migration', () => {
  it('the file is not empty and the harness reads the same file', () => {
    expect(RAW.length).toBeGreaterThan(2000);
    expect(SQL).toContain('ALTER TABLE public.transaction_submissions');
    const runner = readFileSync(
      join(REPO, 'supabase/tests/backlog-3519/run.sh'),
      'utf8',
    );
    expect(runner).toContain(SCHEMA_FILE);
  });

  it('adds all four commission_* columns with the declared types', () => {
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_offered_rate\s+numeric\(6,3\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_actual_rate\s+numeric\(6,3\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_gross_amount\s+numeric\(12,2\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_adjustment_reason\s+text/i);
  });

  it('adds all five split_* snapshot columns, with the split percentages at numeric(5,2) -- NOT numeric(6,3)', () => {
    // The deliberate asymmetry: these mirror agent_split_agreements' own
    // precision, unlike the commission_* rates above.
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS split_agent_pct\s+numeric\(5,2\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS split_brokerage_pct\s+numeric\(5,2\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS split_effective_from\s+date/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS split_resolved_on\s+date/i);
    expect(FLAT).not.toMatch(/split_agent_pct\s+numeric\(6,3\)/i);
    expect(FLAT).not.toMatch(/split_brokerage_pct\s+numeric\(6,3\)/i);
  });

  it('the split_agreement_id FK targets agent_split_agreements(id) with NO ON DELETE clause (default NO ACTION)', () => {
    const col = FLAT.slice(FLAT.indexOf('split_agreement_id uuid'));
    const clause = col.slice(0, col.indexOf(','));
    expect(clause).toContain('REFERENCES public.agent_split_agreements(id)');
    expect(clause).not.toMatch(/ON DELETE/i);
  });

  it('creates an index on the FK column', () => {
    expect(FLAT).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_transaction_submissions_split_agreement_id\s+ON public\.transaction_submissions \(split_agreement_id\)/i,
    );
  });

  it('bounds both commission rates to 0-100 and the split percentages to 0-100', () => {
    expect(checkConstraint('transaction_submissions_offered_rate_check')).toMatch(
      /commission_offered_rate >= 0 AND commission_offered_rate <= 100/i,
    );
    expect(checkConstraint('transaction_submissions_actual_rate_check')).toMatch(
      /commission_actual_rate >= 0 AND commission_actual_rate <= 100/i,
    );
    expect(checkConstraint('transaction_submissions_split_agent_pct_check')).toMatch(
      /split_agent_pct >= 0 AND split_agent_pct <= 100/i,
    );
    expect(checkConstraint('transaction_submissions_split_brokerage_pct_check')).toMatch(
      /split_brokerage_pct >= 0 AND split_brokerage_pct <= 100/i,
    );
  });

  it('requires the gross amount to be non-negative when present', () => {
    expect(checkConstraint('transaction_submissions_gross_amount_check')).toMatch(
      /commission_gross_amount >= 0/i,
    );
  });

  it('bounds the adjustment reason to 1-2000 trimmed characters -- a zero-length string is REJECTED', () => {
    const clause = checkConstraint('transaction_submissions_adjustment_reason_check');
    expect(clause).toMatch(/char_length\(btrim\(commission_adjustment_reason\)\) BETWEEN 1 AND 2000/i);
  });

  it('THE FIX: the split-sum CHECK requires BOTH columns IS NOT NULL before comparing their sum', () => {
    // This is the actual bug: `agent_pct + brokerage_pct = 100` alone is
    // satisfied (not rejected) when one side is NULL, because a Postgres
    // CHECK only rejects FALSE, and NULL is not FALSE. A later "simplify
    // this" edit that drops the explicit IS NOT NULL pair would silently
    // reopen an asymmetric split fill. Measured against a real Postgres:
    // supabase/tests/backlog-3519/README.md, "What was actually run and found".
    const clause = checkConstraint('transaction_submissions_split_sum_check');
    expect(clause).toMatch(/split_agent_pct IS NOT NULL AND split_brokerage_pct IS NOT NULL/i);
    expect(clause).toMatch(/split_agent_pct \+ split_brokerage_pct = 100/i);
    // and the both-null "nothing resolved" case is admitted separately
    expect(clause).toMatch(/split_agent_pct IS NULL AND split_brokerage_pct IS NULL/i);
  });

  it('opens and closes its own transaction, with a bounded lock_timeout', () => {
    // Unlike BACKLOG-3503's file, which deliberately opens none because that
    // migration's own harness supplies the transaction: this file has no such
    // harness at real apply time, so losing the wrapper would let a mid-file
    // failure leave a partial column/constraint set on a live table.
    expect(SQL).toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(SQL).toMatch(/^\s*COMMIT\s*;\s*$/m);
    expect(FLAT).toMatch(/SET LOCAL lock_timeout = '5s'/i);
  });

  it('the header states the apply-ordering constraint with BACKLOG-3503', () => {
    expect(RAW).toMatch(/APPLY-ORDERING CONSTRAINT/);
    expect(RAW).toContain('BACKLOG-3503');
    // The corrected mechanism (SR review, pm_comments 701d1100 on BACKLOG-3519):
    // filename/stamp order does NOT guarantee sequencing on this project, so
    // the header must not claim that it does.
    expect(RAW).not.toMatch(/filename\/version order,\s*3503 is stamped earlier.*so the referenced table always exists/i);
  });

  it('says this migration is not applied to any environment by this PR', () => {
    expect(RAW).toContain('NOT APPLIED TO ANY ENVIRONMENT BY THIS PR');
  });
});
