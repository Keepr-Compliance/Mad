/**
 * SQL for the email force re-cache staging lifecycle — BACKLOG-2989 chunk 5.
 *
 * The last of BACKLOG-2989's move set. Everything here came out of
 * `electron/services/emailForceStaging.ts`, which is the stage-and-swap for
 * Force Re-cache (BACKLOG-2856): the rebuild writes into EPHEMERAL staging
 * tables while live `emails` stays readable, and ONE transaction at the end
 * applies them. BACKLOG-3910a: that transaction removes the unprotected live
 * rows, refreshes the protected ones in place from their fresh copy, and
 * inserts the rest.
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
import { computeParticipantHash, type ParticipantRole } from "../../utils/emailAddress";

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

/** A staged email's identity, as the swap's pairing step reads it. */
export interface StagedEmailIdentity {
  readonly id: string;
  readonly external_id: string | null;
  readonly message_id_header: string | null;
  readonly account_id: string | null;
  readonly source: string | null;
  readonly thread_id: string | null;
}

/** Every staged email's identity — the fresh copies the swap pairs. */
export function selectStagedIdentities(
  db: DatabaseType,
  stagingEmails: StagingTableName,
): StagedEmailIdentity[] {
  return db
    .prepare(
      `SELECT id, external_id, message_id_header, account_id, source, thread_id
         FROM "${stagingEmails}" ORDER BY id`,
    )
    .all() as StagedEmailIdentity[];
}

/**
 * Throw away staged copies (and their staged participants) — the fresh copy
 * of an email on a LOCKED deal is never applied (BACKLOG-3910a).
 *
 * Participants FIRST: they reference the staged email rows. One transaction
 * (a SAVEPOINT when nested inside the swap), so no half-discarded state exists.
 */
export function discardStagedEmails(
  db: DatabaseType,
  stagingEmails: StagingTableName,
  stagingParticipants: StagingTableName,
  stagedIds: readonly string[],
): void {
  if (stagedIds.length === 0) return;
  const deleteParticipants = db.prepare(
    `DELETE FROM "${stagingParticipants}" WHERE email_id = ?`,
  );
  const deleteEmail = db.prepare(`DELETE FROM "${stagingEmails}" WHERE id = ?`);
  db.transaction((ids: readonly string[]) => {
    for (const id of ids) {
      deleteParticipants.run(id);
      deleteEmail.run(id);
    }
  })(stagedIds);
}

/**
 * Is an (account_id, provider id / Message-ID) identity already held by a live
 * email OTHER than `liveId`? The refresh writes a fresh copy's identity onto a
 * kept row only when it is free, so an identity clash can never fail the swap
 * on the partial unique indexes.
 *
 * NULL account_id never clashes: SQLite treats NULL as distinct in a UNIQUE
 * index, which is exactly the index this check stands in front of.
 */
export function liveEmailIdentityTaken(
  db: DatabaseType,
  liveId: string,
  identity: {
    accountId: string | null;
    externalId: string | null;
    messageIdHeader: string | null;
  },
): boolean {
  if (identity.accountId === null) return false;
  const byExternal =
    identity.externalId !== null &&
    db
      .prepare(`SELECT 1 FROM emails WHERE account_id = ? AND external_id = ? AND id <> ? LIMIT 1`)
      .get(identity.accountId, identity.externalId, liveId) !== undefined;
  const byHeader =
    identity.messageIdHeader !== null &&
    db
      .prepare(
        `SELECT 1 FROM emails WHERE account_id = ? AND message_id_header = ? AND id <> ? LIMIT 1`,
      )
      .get(identity.accountId, identity.messageIdHeader, liveId) !== undefined;
  return byExternal || byHeader;
}

/** Filenames of a live email's attachment rows (SR S3 dedupe on account change). */
export function selectEmailAttachmentFilenames(db: DatabaseType, emailId: string): string[] {
  return (
    db.prepare(`SELECT filename FROM attachments WHERE email_id = ?`).all(emailId) as Array<{
      filename: string;
    }>
  ).map((r) => r.filename);
}

/**
 * Columns of a kept email the refresh never overwrites: its own identity in
 * this database and the provenance of its first download.
 */
const REFRESH_KEEPS_COLUMNS = new Set([
  "id",
  "user_id",
  "created_at",
  "updated_at",
  "classification",
  "ingest_source",
  "validated_at",
]);

/** Identity columns, written only when `liveEmailIdentityTaken` says they are free. */
const REFRESH_IDENTITY_COLUMNS = new Set([
  "external_id",
  "account_id",
  "message_id_header",
  "source",
]);

/**
 * Refresh one KEPT live email from its fresh staged copy, IN PLACE
 * (BACKLOG-3910a).
 *
 * An UPDATE on the same id, never remove+insert or INSERT OR REPLACE: both of
 * those fire the ON DELETE CASCADEs and would take the deal's links with them.
 * `emails` has no UPDATE trigger, so this statement touches nothing else.
 *
 * The column list is read from the live table (minus the kept columns), so a
 * migration-added column is carried — same reasoning as `insertStagedEmails`.
 *
 * Participants are REPLACED with the staged ones, re-keyed to the live id with
 * the hash RECOMPUTED: the hash includes the email id, so a copied staged hash
 * would be wrong. When the thread id changed, the deal links that carry it are
 * moved with it (SR R2). Finally the staged copy is dropped.
 *
 * One transaction — a SAVEPOINT inside the swap — so a throw anywhere here
 * propagates and the swap rolls back whole.
 */
export function refreshLiveEmailFromStaged(
  db: DatabaseType,
  stagingEmails: StagingTableName,
  stagingParticipants: StagingTableName,
  args: {
    liveId: string;
    stagedId: string;
    writeIdentity: boolean;
    previousThreadId: string | null;
  },
): void {
  const columns = (db.prepare(`PRAGMA table_info(emails)`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((name) => !REFRESH_KEEPS_COLUMNS.has(name))
    .filter((name) => args.writeIdentity || !REFRESH_IDENTITY_COLUMNS.has(name));
  const quoted = columns.map((c) => `"${c}"`).join(", ");

  db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE emails SET (${quoted}) = (SELECT ${quoted} FROM "${stagingEmails}" WHERE id = ?),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(args.stagedId, args.liveId).changes;
    if (updated !== 1) {
      throw new Error(`Refresh in place matched ${updated} live rows for one kept email`);
    }

    db.prepare(`DELETE FROM email_participants WHERE email_id = ?`).run(args.liveId);
    const staged = db
      .prepare(
        `SELECT role, position, email_address, display_name, resolved_contact_id
           FROM "${stagingParticipants}" WHERE email_id = ?`,
      )
      .all(args.stagedId) as Array<{
      role: ParticipantRole;
      position: number;
      email_address: string;
      display_name: string | null;
      resolved_contact_id: string | null;
    }>;
    const insertParticipant = db.prepare(
      `INSERT INTO email_participants
         (email_id, role, position, participant_hash, email_address, display_name, resolved_contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of staged) {
      insertParticipant.run(
        args.liveId,
        p.role,
        p.position,
        computeParticipantHash(args.liveId, p.role, p.position, p.email_address),
        p.email_address,
        p.display_name,
        p.resolved_contact_id,
      );
    }

    const thread = db.prepare(`SELECT thread_id FROM emails WHERE id = ?`).get(args.liveId) as {
      thread_id: string | null;
    };
    if (thread.thread_id !== args.previousThreadId) {
      db.prepare(`UPDATE communications SET thread_id = ? WHERE email_id = ?`).run(
        thread.thread_id,
        args.liveId,
      );
      db.prepare(`UPDATE ignored_communications SET email_thread_id = ? WHERE email_id = ?`).run(
        thread.thread_id,
        args.liveId,
      );
    }

    db.prepare(`DELETE FROM "${stagingParticipants}" WHERE email_id = ?`).run(args.stagedId);
    db.prepare(`DELETE FROM "${stagingEmails}" WHERE id = ?`).run(args.stagedId);
  })();
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
