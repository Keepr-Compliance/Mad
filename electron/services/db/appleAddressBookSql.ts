/**
 * SQL for Apple's AddressBook database — BACKLOG-2990 chunk 1.
 *
 * Moved out of `electron/services/iosContactsParser.ts`. The rule and its CI
 * gate are BACKLOG-2959.
 *
 * ## A foreign schema, and the rule still applies
 *
 * `AddressBook.sqlitedb` is Apple's, not Keepr's — this app reads it and never
 * writes or migrates it. The rule is about where SQL TEXT is DEFINED, not which
 * database answers it, and the access path is already `db/`-owned:
 * `openSqliteReadOnly` (`db/readOnlySqlite.ts`) is the single, ESLint-enforced
 * entry point for these handles. The text follows the access.
 *
 * Named for the schema it speaks to, so nobody mistakes `ABPerson` for a Keepr
 * table. Apple's identifiers deliberately do NOT enter Keepr's branded-name
 * types.
 *
 * ## Every column is aliased `X AS X`, and that is not style
 *
 * SQLite resolves an identifier case-insensitively but names the RESULT column
 * after the case it was DECLARED with — and an IMPLICIT rowid has no declared
 * case at all. So a bare `SELECT ROWID` comes back under the key `rowid`,
 * `row.ROWID` is `undefined`, and the id is undefined.
 *
 * The consequence is not cosmetic. `buildLookupIndexes()` then misses on
 * `multiValuesByContact.get(undefined)`, so EVERY contact imports with zero
 * phones and zero emails, while `contactCache.set(undefined, …)` collapses the
 * whole address book to a single entry — and the import reports success.
 *
 * `First`/`Last`/`Organization` have the same trap in a milder form: declared
 * lowercase in some backups, so `row.First` is undefined and the display name
 * degrades to "Unknown".
 *
 * The aliases pin the result keys the parser reads. Changing one is a
 * behaviour change, not a rename.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

/**
 * NOTE ON THE DRIVER, because this file's name invites the wrong assumption.
 *
 * `iosContactsParser` opens `AddressBook.sqlitedb` with BETTER-SQLITE3, not the
 * node-sqlite3 path `openSqliteReadOnly` provides. Apple's schema, this app's
 * usual driver. The handle is typed as better-sqlite3's `Database` for that
 * reason, and these statements are enumerated by the gate's original matcher
 * rather than the node-sqlite3 one BACKLOG-3059 added.
 */

/** Which ABPerson columns exist varies by backup; this is what we look for. */
export const ABPERSON_OPTIONAL_COLUMNS = [
  "ExternalUUID",
  "ExternalIdentifier",
  "ExternalModificationTag",
  "ModificationDate",
  "CreationDate",
  "StoreID",
] as const;

export type AbPersonOptionalColumn = (typeof ABPERSON_OPTIONAL_COLUMNS)[number];

/** Always present. Aliased for the reason in the module header. */
const ABPERSON_REQUIRED_COLUMNS =
  "ROWID AS ROWID, First AS First, Last AS Last, Organization AS Organization";

/** What columns this backup's ABPerson actually has. */
export const ABPERSON_TABLE_INFO_SQL = "PRAGMA table_info(ABPerson)";

/**
 * The identity select list.
 *
 * Takes the PRESENT SET as data — a set of column names from a closed union,
 * never a SQL fragment. A missing column is emitted as `NULL AS X` rather than
 * omitted, so the result shape is the same whatever the backup contains and the
 * parser never has to ask which columns it got.
 */
function identitySelectList(present: ReadonlySet<string>): string {
  return ABPERSON_OPTIONAL_COLUMNS.map((col) =>
    present.has(col) ? `        ${col} AS ${col}` : `        NULL AS ${col}`,
  ).join(",\n");
}

/**
 * Every person in the backup.
 *
 * BACKLOG-2407: this and `abPersonSelectById` are built from the SAME list.
 * `getContactById()` falls through to the by-id form on a cache miss, so
 * widening one and not the other would leave that path returning contacts whose
 * identity fields were silently undefined.
 */
function abPersonSelectAllSql(present: ReadonlySet<string>): string {
  return `
      SELECT
        ${ABPERSON_REQUIRED_COLUMNS},
${identitySelectList(present)}
      FROM ABPerson
      ORDER BY ROWID
    `;
}

/** One person by ROWID. Same column list, for the reason above. */
function abPersonSelectByIdSql(present: ReadonlySet<string>): string {
  return `
      SELECT
        ${ABPERSON_REQUIRED_COLUMNS},
${identitySelectList(present)}
      FROM ABPerson
      WHERE ROWID = ?
    `;
}

/**
 * Phones and emails for every person.
 *
 * `COALESCE(mvl.value, 'other')` because a multivalue row can carry a label id
 * that has no row in `ABMultiValueLabel`; without it the label is NULL and the
 * value is dropped by a downstream filter rather than kept as an unlabelled one.
 * Two bound parameters: the phone and email property ids.
 */
export const AB_MULTIVALUE_ALL_SQL = `
      SELECT
        mv.record_id,
        mv.property,
        COALESCE(mvl.value, 'other') as label,
        mv.value
      FROM ABMultiValue mv
      LEFT JOIN ABMultiValueLabel mvl ON mv.label = mvl.ROWID
      WHERE mv.property IN (?, ?)
      ORDER BY mv.record_id
    `;

/**
 * Phones and emails for ONE person. Three bound parameters: the record id, then
 * the phone and email property ids.
 *
 * A near-duplicate of `AB_MULTIVALUE_ALL_SQL` and deliberately not folded into
 * it. The bulk form drives `buildLookupIndexes()` for a whole import; this one
 * serves `getContactById()` on a cache miss. Parameterising the difference
 * would mean a runtime-optional WHERE clause on the hot path of an import that
 * reads every row in the table.
 */
export const AB_MULTIVALUE_BY_RECORD_SQL = `
      SELECT
        mv.record_id,
        mv.property,
        COALESCE(mvl.value, 'other') as label,
        mv.value
      FROM ABMultiValue mv
      LEFT JOIN ABMultiValueLabel mvl ON mv.label = mvl.ROWID
      WHERE mv.record_id = ?
        AND mv.property IN (?, ?)
    `;

/**
 * The two ABPerson statements, PREPARED HERE.
 *
 * The column list is assembled from a runtime probe, so the text cannot be a
 * constant the caller passes to `.prepare()`. Handing the caller a built string
 * instead would leave `db.prepare(abPersonSelectAllSql(...))` at the call site —
 * a call expression as argument 0, which the boundary gate classifies
 * UNRESOLVABLE and which is therefore a violation, not a fix. So the `.prepare()`
 * moves in here and the caller keeps no SQL verb at all.
 *
 * Both are returned together, deliberately: BACKLOG-2407's finding is that they
 * must be built from the SAME list, and `getContactById()` falls through to the
 * by-id form on a cache miss. Returning them as a pair makes preparing one
 * without the other unrepresentable rather than merely discouraged.
 */
export function prepareAbPersonStatements(
  db: DatabaseType,
  present: ReadonlySet<string>,
): { all: Statement; byId: Statement } {
  return {
    all: db.prepare(abPersonSelectAllSql(present)),
    byId: db.prepare(abPersonSelectByIdSql(present)),
  };
}
