/**
 * SQL for the email body re-derivation backfill — BACKLOG-2989 chunk 4.
 *
 * Moved out of `electron/services/emailDerivationReprocessService.ts`. The rule
 * and its CI gate are BACKLOG-2959.
 *
 * ## What this backfill is for
 *
 * BACKLOG-2857 stamps `emails.derived_version` at write time so a later fix to
 * the body-derivation logic can tell a row it produced apart from one produced
 * by superseded logic. This is the sweep that finds the stale rows and re-runs
 * them.
 *
 * ## Two writers, deliberately
 *
 * A row whose re-derived text is unchanged costs a version stamp and nothing
 * more — `STAMP_DERIVATION_VERSION_SQL`. Only a row whose text actually changed
 * pays for a body rewrite — `UPDATE_BODY_AND_VERSION_SQL`. Collapsing them into
 * one UPDATE would rewrite every body on every run, which on a large mailbox is
 * the difference between a stamp sweep and a full-table rewrite.
 *
 * Neither writes `updated_at`: this is a repair of stored derivation, not a
 * change the user made, and touching the timestamp would misreport it as one.
 *
 * ## The selection statement has exactly two shapes
 *
 * `selectStaleEmails` optionally scopes to one user. That is ONE conditional
 * clause, so the statement has two forms and no more — a closed set, which is
 * what lets the PR prove text-equivalence across the whole space rather than
 * sampling it.
 *
 * It takes `userId` and derives both the clause and the bound parameters from
 * it, so the clause cannot be present while its parameter is missing. The code
 * this replaced built the SQL in one place (`options.userId ? "AND user_id = ?"
 * : ""`) and the params in another (`selectParams()`), which cannot disagree
 * today but is not structurally prevented from doing so.
 *
 * All four constants are byte-identical to the text they replaced.
 */

/** The minimal handle these statements need (better-sqlite3-shaped). */
export interface DerivationQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Row shape the sweep reads. */
export interface StaleDerivationRow {
  id: string;
  body_plain: string | null;
  body_html: string | null;
  derived_version: number;
}

/** Rewrites the body AND stamps the version. Params: body, version, id. */
export const UPDATE_BODY_AND_VERSION_SQL =
  "UPDATE emails SET body_plain = ?, derived_version = ? WHERE id = ?";

/** Stamps the version only, for a row whose text did not change. Params: version, id. */
export const STAMP_DERIVATION_VERSION_SQL =
  "UPDATE emails SET derived_version = ? WHERE id = ?";

/**
 * Whether the `emails` table exists at all.
 *
 * Absent in some minimal fixtures, and its absence is not an error worth
 * failing an import over — hence a probe rather than a try/catch around the
 * real query.
 */
export const EMAILS_TABLE_EXISTS_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name = 'emails'";

/**
 * Column list of `emails`, used to detect whether migration v67 has added
 * `derived_version` yet. A PRAGMA rather than a query: it answers even when the
 * column is missing, which is exactly the case being tested.
 */
export const EMAILS_TABLE_INFO_SQL = "PRAGMA table_info(emails)";

/**
 * Emails whose stored derivation predates `version`, oldest batch first.
 *
 * PREPARED ONCE, then run per batch — the caller loops until a batch comes back
 * empty, and re-preparing inside that loop would be a behaviour change this
 * mechanical move has no business making.
 *
 * `userId` is captured once, and BOTH the optional clause and the bound
 * parameters are derived from that single capture. The code this replaced built
 * them in two places — `options.userId ? "AND user_id = ?" : ""` for the SQL and
 * a separate `selectParams()` for the values. Those cannot disagree today, but
 * nothing structural stopped them: a clause without its parameter throws
 * loudly, while a parameter without its clause binds the batch size into the
 * version slot and returns a plausible wrong answer.
 */
export function prepareStaleEmailSelect(
  db: DerivationQueryable,
  userId: string | undefined,
): { all: (version: number, batchSize: number) => StaleDerivationRow[] } {
  const stmt = db.prepare(`
    SELECT id, body_plain, body_html, derived_version
    FROM emails
    WHERE derived_version < ?
    ${userId ? "AND user_id = ?" : ""}
    LIMIT ?
  `);
  return {
    all: (version, batchSize) =>
      (userId
        ? stmt.all(version, userId, batchSize)
        : stmt.all(version, batchSize)) as StaleDerivationRow[],
  };
}
