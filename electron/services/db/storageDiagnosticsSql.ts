/**
 * SQL for the support-ticket storage diagnostics block — BACKLOG-2989 PR 2.
 *
 * Moved out of `electron/services/storageDiagnostics.ts` so the text lives in
 * `electron/services/db/**` (the rule and CI gate are BACKLOG-2959).
 *
 * ## Two shapes, and why this module has both constants and functions
 *
 * Most of what moved is a plain constant the caller passes to `.prepare()`.
 * Four statements cannot be: they interpolate a TABLE or COLUMN name, which is
 * not bindable as a parameter in SQLite. For those the `.prepare()` call itself
 * lives here, and `storageDiagnostics.ts` calls a function instead — it keeps
 * no SQL verb at all.
 *
 * ## The identifiers are constrained by TYPE, not by a comment
 *
 * The code this replaced carried:
 *
 *     // Table names come from COUNTED_TABLES / sqlite_master, never from input.
 *     db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
 *
 * A comment is not a constraint. Every interpolated identifier below is a
 * member of `DIAGNOSABLE_TABLES` / `DIAGNOSABLE_DATE_COLUMNS`, enforced by a
 * union type at compile time AND by a runtime check that throws. The runtime
 * half matters because a union type is erased: nothing at run time would stop a
 * string that reached here through an `as` cast or a JSON boundary.
 *
 * Callers already wrap these in `try`/`catch` and degrade to `null`, so a
 * rejected identifier reports "unavailable" rather than crashing a support
 * ticket — which is the same thing that already happens when a table is absent.
 *
 * ## Error policy deliberately stays with the caller
 *
 * These functions execute and return rows. They do not catch. Whether a failed
 * count becomes `null`, a skipped section, or a re-throw is a diagnostics
 * decision, and `storageDiagnostics.ts` already makes it — see its
 * "an absent window is not an empty one" comments. Duplicating that policy here
 * would give the same question two answers.
 */

/**
 * The minimal synchronous handle these queries need (better-sqlite3-shaped).
 *
 * Defined here rather than in `storageDiagnostics.ts` because this is now where
 * the statements are prepared. `storageDiagnostics.ts` re-exports the type so
 * existing importers are unaffected.
 */
export interface StorageQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma(sql: string, options?: { simple?: boolean }): unknown;
}

/**
 * Every table name this module will interpolate into SQL. A closed set, not a
 * convention: `countRowsIn` and friends reject anything outside it.
 *
 * This is a SAFETY allow-list and is deliberately WIDER than the diagnostics
 * block's `COUNTED_TABLES` display list, which is a separate editorial choice
 * about what is worth showing a human. `emails` and `messages` appear here and
 * not there for exactly that reason — they are queried for coverage windows,
 * but a bare `messages=0` in the counts list would re-assert the very thing the
 * coverage line exists to deny.
 */
export const DIAGNOSABLE_TABLES = [
  "contacts",
  "contact_phones",
  "contact_emails",
  "external_contacts",
  "email_participants",
  "attachments",
  "transactions",
  "transaction_contacts",
  "communications",
  "emails",
  "messages",
  "email_sync_state",
  "message_import_state",
] as const;

export type DiagnosableTable = (typeof DIAGNOSABLE_TABLES)[number];

/** Date columns this module will interpolate. Same closed-set reasoning. */
export const DIAGNOSABLE_DATE_COLUMNS = [
  "sent_at",
  "oldest_cached_at",
  "deepest_import_start",
] as const;

export type DiagnosableDateColumn = (typeof DIAGNOSABLE_DATE_COLUMNS)[number];

const TABLE_SET: ReadonlySet<string> = new Set(DIAGNOSABLE_TABLES);
const DATE_COLUMN_SET: ReadonlySet<string> = new Set(DIAGNOSABLE_DATE_COLUMNS);

/**
 * The runtime half of the constraint. Throws rather than returning a value,
 * because there is no safe fallback: a table name that is not on the list is
 * either a programming error or an injection attempt, and both should stop.
 */
function assertTable(table: string): asserts table is DiagnosableTable {
  if (!TABLE_SET.has(table)) {
    throw new Error(`storageDiagnosticsSql: table "${table}" is not diagnosable`);
  }
}

function assertDateColumn(column: string): asserts column is DiagnosableDateColumn {
  if (!DATE_COLUMN_SET.has(column)) {
    throw new Error(`storageDiagnosticsSql: column "${column}" is not a diagnosable date column`);
  }
}

// ---------------------------------------------------------------------------
// Static statements — the caller keeps the `.prepare()`
// ---------------------------------------------------------------------------

/** Every table name in the schema. Used to test existence before querying. */
export const EXISTING_TABLE_NAMES_SQL = "SELECT name FROM sqlite_master WHERE type='table'";

/** The store's migration version. One row, or none on a pre-migration file. */
export const SCHEMA_VERSION_SQL = "SELECT version FROM schema_version WHERE id = 1";

/**
 * `PRAGMA quick_check`. Not a query — connection-level integrity verification,
 * passed to `.pragma()`. Bounded by file size at the call site: it is
 * synchronous and O(database size), and it runs on the main process the moment
 * a user hits Submit on a support ticket.
 */
export const QUICK_CHECK_PRAGMA = "quick_check";

/**
 * Ticket 100 — contacts reachable by phone. `DISTINCT` is load-bearing here,
 * unlike in `submissionEmailSql`: a contact with three phone numbers joins to
 * three rows, and counting them would report more contacts than exist.
 */
export const CONTACTS_WITH_PHONE_SQL = `SELECT COUNT(DISTINCT c.id) AS n FROM contacts c
             JOIN contact_phones p ON p.contact_id = c.id`;

/** Ticket 100 — contacts reachable by email. Same `DISTINCT` reasoning. */
export const CONTACTS_WITH_EMAIL_SQL = `SELECT COUNT(DISTINCT c.id) AS n FROM contacts c
             JOIN contact_emails e ON e.contact_id = c.id`;

/**
 * Contacts with neither a phone nor an email. These are the rows that can never
 * match an incoming message, so a large number here IS the answer to "why
 * weren't my texts linked".
 */
export const CONTACTS_WITH_NEITHER_SQL = `SELECT COUNT(*) AS n FROM contacts c
               WHERE NOT EXISTS (SELECT 1 FROM contact_phones p WHERE p.contact_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id)`;

/**
 * Ticket 94 — phone rows that actually carry a normalized form. The gap between
 * this and the raw `contact_phones` count is the bug report: search cannot match
 * what was never normalized. The `<> ''` half matters as much as the NULL check,
 * because an empty string is stored, not absent, and counts as normalized
 * without it.
 */
export const PHONES_NORMALIZED_SQL = `SELECT COUNT(*) AS n FROM contact_phones
             WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''`;

// ---------------------------------------------------------------------------
// Interpolated identifiers — the `.prepare()` lives here
// ---------------------------------------------------------------------------

/** `SELECT COUNT(*)` for one diagnosable table. Throws on an unknown table. */
export function countRowsIn(
  db: StorageQueryable,
  table: DiagnosableTable,
): { n: number } | undefined {
  assertTable(table);
  return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as
    | { n: number }
    | undefined;
}

/**
 * Row counts grouped by `source`, densest first.
 *
 * `ORDER BY n DESC, source ASC` — the tiebreak is load-bearing. Two sources
 * with equal counts otherwise come back in whatever order the planner picks,
 * and a diagnostics line that reorders itself between two runs is the same
 * class of defect BACKLOG-2392 removed from address-book discovery.
 */
export function countBySourceIn(
  db: StorageQueryable,
  table: DiagnosableTable,
): Array<{ source: string; n: number }> {
  assertTable(table);
  return db
    .prepare(
      `SELECT COALESCE(source, '(null)') AS source, COUNT(*) AS n
           FROM "${table}" GROUP BY COALESCE(source, '(null)')
           ORDER BY n DESC, source ASC`,
    )
    .all() as Array<{ source: string; n: number }>;
}

/** Oldest and newest value of a date column — the coverage window's ends. */
export function selectDateRangeIn(
  db: StorageQueryable,
  table: DiagnosableTable,
  dateColumn: DiagnosableDateColumn,
): { lo: unknown; hi: unknown } | undefined {
  assertTable(table);
  assertDateColumn(dateColumn);
  return db
    .prepare(
      `SELECT MIN("${dateColumn}") AS lo, MAX("${dateColumn}") AS hi
           FROM "${table}"`,
    )
    .get() as { lo: unknown; hi: unknown } | undefined;
}

/**
 * How far back a scan actually reached — distinct from the oldest row FOUND.
 * Without this, "nothing found" and "never looked that far back" are the same
 * line, which is the distinction ticket 99 turned on.
 */
export function selectDeepestScannedIn(
  db: StorageQueryable,
  table: DiagnosableTable,
  column: DiagnosableDateColumn,
): { d: unknown } | undefined {
  assertTable(table);
  assertDateColumn(column);
  return db.prepare(`SELECT MIN("${column}") AS d FROM "${table}"`).get() as
    | { d: unknown }
    | undefined;
}
