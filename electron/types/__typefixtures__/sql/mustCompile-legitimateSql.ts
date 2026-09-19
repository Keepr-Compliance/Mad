/**
 * CONTROL 4 — SATISFIABILITY, the must-NOT-fire case. BACKLOG-3064.
 *
 * A brand nothing can satisfy passes every "must not compile" control and is
 * worthless. Worse: a brand that makes ORDINARY WORK awkward gets cast away
 * everywhere within a week, at which point the repo carries the ceremony and none
 * of the guarantee. The repo already owns that failure — `sqlFieldWhitelist.ts`
 * (BACKLOG-2739) was a whitelist whose types had silently widened to `string`,
 * proven by execution: a guard that looked like a constraint and constrained
 * nothing.
 *
 * So this fixture is deliberately as long as the failing ones, and it must compile
 * with **exit 0 and zero casts**, under the same compiler settings as they use —
 * which is also what proves they fail because of the brand rather than because the
 * fixture environment is broken.
 *
 * Three things are under test:
 *   1. Every conduit verb accepts a tagged statement, with no cast.
 *   2. Fragments COMPOSE. This is what makes the tag usable for the 39 conduit
 *      sites that interpolate a clause, a column list or a placeholder list today
 *      — every one of which is a SQL fragment, not a value. (Measured at the base
 *      commit: 39 interpolating conduit sites, zero of them splicing a value.)
 *   3. Erasure at the type level: a `SafeSql` is still a `string` everywhere a
 *      string is legitimate. Runtime erasure is proved separately, from emitted
 *      output, in `sqlText.runtimeIdentity.test.ts`.
 */
import { dbAll, dbExec, dbGet, dbRun } from "../../../services/db/core/dbConnection";
import { sql, type SafeSql } from "../../../services/db/core/sqlText";

// ---------------------------------------------------------------------------
// 1. Every verb takes a tagged statement. No cast anywhere in this file.
// ---------------------------------------------------------------------------

export function readOne(id: string): { id: string } | undefined {
  return dbGet<{ id: string }>(sql`SELECT id FROM contacts WHERE id = ?`, [id]);
}

export function readMany(userId: string): Array<{ id: string }> {
  return dbAll<{ id: string }>(sql`SELECT id FROM contacts WHERE user_id = ?`, [userId]);
}

export function write(id: string, name: string): number {
  return dbRun(sql`UPDATE contacts SET display_name = ? WHERE id = ?`, [name, id]).changes;
}

export function createTable(): void {
  dbExec(sql`CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY)`);
}

// ---------------------------------------------------------------------------
// 2. COMPOSITION — a fragment interpolated into a statement stays branded.
//    This is the shape all 39 live interpolating sites have.
// ---------------------------------------------------------------------------

/** A reusable predicate, exactly like `ACTIVE_CONTACTS_CLAUSE_C` in the real tree. */
const ACTIVE_ONLY: SafeSql = sql`c.deleted_at IS NULL AND c.merged_into IS NULL`;

/** A generated placeholder list — `contactCompare.ts:393`'s shape. */
function placeholders(n: number): SafeSql {
  return sql`${listOf(n)}`;
}

/** Building a list of `?` is string work; it becomes SQL by passing through the tag. */
function listOf(n: number): SafeSql {
  const marks: SafeSql[] = [];
  for (let i = 0; i < n; i += 1) marks.push(sql`?`);
  return marks.reduce((acc, mark, i) => (i === 0 ? mark : sql`${acc}, ${mark}`), sql``);
}

export function readActive(userId: string, ids: string[]): Array<{ id: string }> {
  return dbAll<{ id: string }>(
    sql`SELECT c.id FROM contacts c
         WHERE c.user_id = ?
           AND ${ACTIVE_ONLY}
           AND c.id IN (${placeholders(ids.length)})`,
    [userId, ...ids],
  );
}

/** Nesting to two levels — composition is not special-cased at depth 1. */
export function nested(userId: string): Array<{ id: string }> {
  const inner: SafeSql = sql`SELECT id FROM transactions WHERE user_id = ?`;
  const middle: SafeSql = sql`c.transaction_id IN (${inner})`;
  return dbAll<{ id: string }>(
    sql`SELECT c.id FROM communications c WHERE ${middle}`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// 3. ERASURE — a branded statement is still a string.
// ---------------------------------------------------------------------------

declare const statement: SafeSql;
declare function takesAPlainString(value: string): void;
declare function logContext(context: Record<string, unknown>): void;

takesAPlainString(statement);
logContext({ statement });

export const serialised = JSON.stringify({ statement });
export const width: number = statement.length;
export const upper: string = statement.toUpperCase();
export const trimmed: string = statement.trim();
export const startsWithSelect: boolean = statement.startsWith("SELECT");
export const inATemplate = `about to run: ${statement}`;
export const collected: string[] = [statement];
export const asAKey: Record<string, number> = { [statement]: 1 };
export const inAMap = new Map<string, number>([[statement, 1]]);
export const inASet = new Set<string>([statement]);
