/**
 * The macOS importer's reads and writes over `messages` / `attachments`, in the
 * two modes it runs in — BACKLOG-2990 chunk 5.
 *
 * Every statement here has the same shape: in DELTA mode it addresses the live
 * table directly, and in FORCE mode it addresses "survivors of the clear UNION
 * what this run has staged", built from a `MacOSForceSet` by
 * `macosForceReadView`. The old code expressed that with a ternary at each call
 * site and a shared `readParams` array, which was only correct while every view
 * bound the same single value.
 *
 * ## Why a mode object rather than a nullable staging argument
 *
 * `ImportTarget` makes the invalid state unrepresentable: there is no way to
 * pass a staging table without being in force mode, or to be in force mode
 * without one. That is the same move `EmailWriteTarget` made on the email side.
 *
 * These functions EXECUTE, and they take a force set and branded table names —
 * never SQL text — so none has the combination the layer rule forbids. The one
 * exception is `columns`, which is a column list rather than a predicate and is
 * returned as text by `macosForceReadView` without being executed there.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import {
  macosForceReadView,
  survivingAttachments,
  type MacOSForceSet,
} from "./macosForceSetSql";
import type { StagingTableName } from "./stagingDdlSql";

/**
 * Which tables this run reads and writes.
 *
 * `delta` is the ordinary incremental import. `force` is a full rebuild, where
 * the live rows are still present until the swap, so every read must union the
 * survivors with what has been staged so far.
 */
export type ImportTarget =
  | { readonly mode: "delta" }
  | {
      readonly mode: "force";
      readonly set: MacOSForceSet;
      readonly messagesTable: StagingTableName;
      readonly attachmentsTable: StagingTableName;
    };

interface View {
  readonly sql: string;
  readonly params: readonly string[];
}

const messagesView = (t: ImportTarget, columns: string): View =>
  t.mode === "delta"
    ? { sql: "messages", params: [] }
    : macosForceReadView(t.set, "messages", t.messagesTable, columns);

const attachmentsView = (t: ImportTarget, columns: string): View =>
  t.mode === "delta"
    ? { sql: "attachments", params: [] }
    : macosForceReadView(t.set, "attachments", t.attachmentsTable, columns);

/** The table this run WRITES messages to: live in delta mode, staging in force mode. */
export const messagesWriteTable = (t: ImportTarget): string =>
  t.mode === "delta" ? "messages" : `"${t.messagesTable}"`;

/** The table this run WRITES attachments to. */
export const attachmentsWriteTable = (t: ImportTarget): string =>
  t.mode === "delta" ? "attachments" : `"${t.attachmentsTable}"`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The external ids this run must not insert again.
 *
 * Binding is POSITIONAL and the order follows the text: the view sits in FROM,
 * so its parameters precede the outer WHERE's user id. better-sqlite3 refuses to
 * mix `?` with `@name` in one statement, which is why the old force and delta
 * paths had to be spelled as two different queries.
 */
export function selectExistingExternalIds(
  db: DatabaseType,
  target: ImportTarget,
  userId: string,
): string[] {
  const view = messagesView(target, "external_id, user_id");
  const rows = db
    .prepare(
      `
      SELECT external_id FROM ${view.sql}
      WHERE user_id = ? AND external_id IS NOT NULL
    `,
    )
    .all(...view.params, userId) as Array<{ external_id: string }>;
  return rows.map((r) => r.external_id);
}

/** Attachments already stored, keyed by the pair the importer deduplicates on. */
export function selectStoredAttachmentKeys(
  db: DatabaseType,
  target: ImportTarget,
): Array<{ external_message_id: string; filename: string }> {
  const view = attachmentsView(target, "external_message_id, filename");
  return db
    .prepare(
      `SELECT external_message_id, filename FROM ${view.sql} WHERE external_message_id IS NOT NULL`,
    )
    .all(...view.params) as Array<{ external_message_id: string; filename: string }>;
}

/** Messages stored by PREVIOUS runs — the only other rows an attachment can link to. */
export function selectExistingMessageIds(
  db: DatabaseType,
  target: ImportTarget,
): Array<{ id: string; external_id: string }> {
  const view = messagesView(target, "id, external_id");
  return db
    .prepare(`SELECT id, external_id FROM ${view.sql} WHERE external_id IS NOT NULL`)
    .all(...view.params) as Array<{ id: string; external_id: string }>;
}

/** Stored attachment paths, for content-hash deduplication. */
export function selectAttachmentStoragePaths(
  db: DatabaseType,
  target: ImportTarget,
): Array<{ storage_path: string }> {
  const view = attachmentsView(target, "storage_path");
  return db
    .prepare(`SELECT storage_path FROM ${view.sql} WHERE storage_path IS NOT NULL`)
    .all(...view.params) as Array<{ storage_path: string }>;
}

/** Stored attachment records, for message_id+filename deduplication. */
export function selectAttachmentRecords(
  db: DatabaseType,
  target: ImportTarget,
): Array<{ message_id: string; filename: string }> {
  const view = attachmentsView(target, "message_id, filename");
  return db
    .prepare(`SELECT message_id, filename FROM ${view.sql} WHERE message_id IS NOT NULL`)
    .all(...view.params) as Array<{ message_id: string; filename: string }>;
}

/**
 * Attachments by external id, carrying WHICH HALF each row came from.
 *
 * The only read that needs `in_staging`, because it is the only one whose result
 * is later WRITTEN to. A stale `message_id` on a row this run staged is fixed in
 * staging; the same repair aimed at a row that SURVIVED in the live table is held
 * back for the swap, so the live table stays untouched for the length of the
 * rebuild while the repair still becomes visible at exactly the moment it did
 * before — when the transaction carrying the whole re-import commits.
 *
 * It cannot use `attachmentsView`, which unions the two halves anonymously.
 */
export function selectAttachmentsByExternalId(
  db: DatabaseType,
  target: ImportTarget,
): Array<{
  id: string;
  message_id: string;
  external_message_id: string;
  filename: string;
  in_staging: number;
}> {
  if (target.mode === "delta") {
    return db
      .prepare(
        `SELECT id, message_id, external_message_id, filename, 0 AS in_staging
           FROM attachments WHERE external_message_id IS NOT NULL`,
      )
      .all() as ReturnType<typeof selectAttachmentsByExternalId>;
  }
  const surviving = survivingAttachments(target.set);
  return db
    .prepare(
      `SELECT id, message_id, external_message_id, filename, in_staging FROM (
           SELECT id, message_id, external_message_id, filename, 0 AS in_staging
             FROM attachments WHERE ${surviving.sql}
           UNION ALL
           SELECT id, message_id, external_message_id, filename, 1 AS in_staging
             FROM "${target.attachmentsTable}"
         ) WHERE external_message_id IS NOT NULL`,
    )
    .all(...surviving.params) as ReturnType<typeof selectAttachmentsByExternalId>;
}

// ---------------------------------------------------------------------------
// Writes — prepared once, run per row
// ---------------------------------------------------------------------------

/** TASK-1799: `message_type` differentiates voice messages, location and the rest in the UI. */
export function prepareInsertMessage(db: DatabaseType, target: ImportTarget): Statement {
  return db.prepare(`
      INSERT OR IGNORE INTO ${messagesWriteTable(target)} (
        id, user_id, channel, external_id, direction,
        body_text, participants, participants_flat, thread_id, sent_at,
        has_attachments, message_type, metadata,
        associated_message_type, associated_message_guid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
}

/**
 * BACKLOG-2302: self-heal for historical reactions.
 *
 * Reactions imported before BACKLOG-2280 were stored as ordinary text rows, so
 * GUID dedup skips them and a normal re-import never back-fills the reaction
 * columns — they keep rendering as plain bubbles. This UPDATEs the existing row
 * in place with the same columns the fresh-import path writes, so it partitions
 * to a pill on the next render WITHOUT a destructive force re-import.
 *
 * `associated_message_type IS NULL` makes it idempotent: once a row is tagged,
 * later imports re-tag nothing and never touch fresh reactions.
 */
export function prepareRetagReaction(db: DatabaseType, target: ImportTarget): Statement {
  return db.prepare(`
      UPDATE ${messagesWriteTable(target)}
      SET associated_message_type = ?,
          associated_message_guid = ?,
          message_type = NULL,
          body_text = ''
      WHERE user_id = ?
        AND external_id = ?
        AND associated_message_type IS NULL
    `);
}

/** TASK-1110: `external_message_id` is what makes the link survive a re-sync. */
export function prepareInsertAttachment(db: DatabaseType, target: ImportTarget): Statement {
  return db.prepare(`
      INSERT OR IGNORE INTO ${attachmentsWriteTable(target)} (
        id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
}

/** TASK-1122: repair a stale `message_id` on a row this run wrote. */
export function prepareUpdateAttachmentMessageId(
  db: DatabaseType,
  target: ImportTarget,
): Statement {
  return db.prepare(`
      UPDATE ${attachmentsWriteTable(target)} SET message_id = ? WHERE id = ?
    `);
}
