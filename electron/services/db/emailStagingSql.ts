/**
 * SQL for the email force re-cache staging lifecycle — BACKLOG-2989 chunk 5.
 *
 * The last of BACKLOG-2989's move set. Everything here came out of
 * `electron/services/emailForceStaging.ts`, which is the stage-and-swap for
 * Force Re-cache (BACKLOG-2856): the rebuild writes into EPHEMERAL staging
 * tables while live `emails` stays readable, and ONE transaction at the end
 * deletes the force set from live and inserts the staged rows.
 *
 * ## Why so much of this is execution rather than constants
 *
 * Nearly every statement names a staging table, and those names are generated
 * per run from a random token — so the text cannot be a constant a caller
 * passes in. The `.prepare()`/`.exec()` moved here, and the caller passes a
 * `StagingTableName`, which the compiler will not let it fabricate.
 *
 * ## The invariant, carried from chunk 4
 *
 * Every declaration between a staging name's construction and its use in SQL
 * preserves the brand. In this module that means: no function below takes a
 * table name as `string`. Where one does, the brand has been lost upstream.
 *
 * ## The rule
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter. Every
 * function here executes, and none of them takes SQL — only branded names,
 * identifiers, and bound values.
 */

import type { Database as DatabaseType } from "better-sqlite3";

import {
  columnList,
  deriveStagingIndexDdl,
  deriveStagingTableDdl,
  checkedStagingTable,
  emailTableDdl,
  type StagingTableName,
} from "./stagingDdlSql";

/**
 * Staging tables left behind by a previous run, found by prefix.
 *
 * `ESCAPE '\\'` with the prefix escaped in the SAME pass as `_`: escaping only
 * `_` leaves a backslash in the input free to pair with the character after it,
 * which is the incomplete-sanitization shape CodeQL flags. The input is a
 * module constant with neither a backslash nor a `%`, so nothing is exploitable
 * today; it is written correctly anyway because "the input happens to be safe"
 * is a property of a caller, not of this function.
 */
export const STALE_STAGING_TABLES_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`;

/** The indexes on a live table, so staging can mirror them under new names. */
export const LIVE_TABLE_INDEXES_SQL = `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`;

/**
 * Drop one staging table.
 *
 * Takes a `StagingTableName`: this is `DROP TABLE`, and it is the single place
 * in the email path where an unchecked name would be catastrophic rather than
 * merely wrong.
 */
export function dropStagingTable(db: DatabaseType, table: StagingTableName): void {
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

/**
 * Create a staging table mirroring a live one.
 *
 * Derived from `sqlite_master` rather than `CREATE TABLE … AS SELECT * … WHERE
 * 0`: the insert names a subset of the columns and lets the table supply the
 * rest from its DEFAULTs (`has_attachments INTEGER DEFAULT 0`, …). `AS SELECT`
 * copies names and types and drops every default, so staging would store NULL
 * where live stores 0 — and the swap would carry those NULLs into live.
 *
 * This is where BACKLOG-2989's `expr:2394cf8691a7` closes: the DDL is derived
 * and executed inside the layer, so the caller holds no verb.
 */
export function createStagingTable(
  db: DatabaseType,
  liveTable: string,
  stagingTable: StagingTableName,
): void {
  db.exec(deriveStagingTableDdl(emailTableDdl(db, liveTable), liveTable, stagingTable));
}

/**
 * Mirror every index of a live table onto its staging table, under unique
 * names built from the run's token.
 *
 * Closes `expr:6577adc2a954` for the same reason as above.
 */
export function mirrorStagingIndexes(
  db: DatabaseType,
  liveTable: string,
  stagingTable: StagingTableName,
  indexNamePrefix: string,
): void {
  const indexes = db.prepare(LIVE_TABLE_INDEXES_SQL).all(liveTable) as Array<{
    name: string;
    sql: string;
  }>;
  for (const index of indexes) {
    db.exec(
      deriveStagingIndexDdl(
        index.sql,
        index.name,
        liveTable,
        stagingTable,
        checkedStagingTable(`${indexNamePrefix}${index.name}`, "email-recache"),
      ),
    );
  }
}

/** Ids of staged emails from one provider — the rows a narrowing drops. */
export function selectStagedIdsBySource(
  db: DatabaseType,
  stagingEmails: StagingTableName,
  source: string,
): Array<{ id: string }> {
  return db
    .prepare(`SELECT id FROM "${stagingEmails}" WHERE source = ?`)
    .all(source) as Array<{ id: string }>;
}

/**
 * Drop one provider's staged rows, participants FIRST, in ONE transaction.
 *
 * Order is load-bearing: the participants reference the staged email rows, so
 * deleting emails first leaves the participant delete's subquery finding
 * nothing, and its rows orphaned.
 *
 * ## The transaction is a FIX, not a formality
 *
 * These two deletes ran unwrapped before this move, and
 * `restrictForceSetToRebuiltProviders`'s caller holds no transaction either —
 * verified at `emailSyncService.ts:2362`. So a crash between them left a
 * dropped provider's EMAIL rows staged while its PARTICIPANT rows were gone,
 * and the swap then inserted that half-narrowed set into live.
 *
 * The defect predates BACKLOG-2989; grouping the pair into one function is what
 * made `writeAtomicity.guard.test.ts` (BACKLOG-2530) able to see it, and the
 * guard flagged it on the first run. Silencing it by adding an entry to the
 * known list would have preserved a real bug to keep a refactor tidy.
 *
 * Nested-safe: better-sqlite3 runs an inner `transaction()` as a SAVEPOINT, so
 * this is correct whether or not a caller later wraps it.
 */
export function deleteStagedProviderRows(
  db: DatabaseType,
  stagingEmails: StagingTableName,
  stagingParticipants: StagingTableName,
  source: string,
): void {
  const deleteParticipants = db.prepare(
    `DELETE FROM "${stagingParticipants}" WHERE email_id IN ` +
      `(SELECT id FROM "${stagingEmails}" WHERE source = ?)`,
  );
  const deleteEmails = db.prepare(`DELETE FROM "${stagingEmails}" WHERE source = ?`);
  db.transaction((provider: string) => {
    deleteParticipants.run(provider);
    deleteEmails.run(provider);
  })(source);
}

/**
 * The swap's inserts: staged rows into live, column-for-column.
 *
 * The column list is read from the LIVE table at swap time rather than written
 * out, so a migration that adds a column is carried automatically instead of
 * being silently dropped on the next force re-cache.
 */
export function insertStagedEmails(
  db: DatabaseType,
  stagingEmails: StagingTableName,
): number {
  const cols = columnList(db, "emails");
  return db
    .prepare(`INSERT INTO emails (${cols}) ` + `SELECT ${cols} FROM "${stagingEmails}"`)
    .run().changes;
}

export function insertStagedParticipants(
  db: DatabaseType,
  stagingParticipants: StagingTableName,
): number {
  const cols = columnList(db, "email_participants");
  return db
    .prepare(
      `INSERT INTO email_participants (${cols}) ` +
        `SELECT ${cols} FROM "${stagingParticipants}"`,
    )
    .run().changes;
}
