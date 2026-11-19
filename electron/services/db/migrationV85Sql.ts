/**
 * SQL for migration v85 — BACKLOG-4263 PR-11c (who last wrote an item's done and note parts).
 *
 * Same SQL boundary rule as migrationV81Sql.ts: SQL text is DEFINED under `electron/services/db/` and imported,
 * never inlined in the migration body.
 *
 * Eight nullable columns on `transaction_checklist_items`, each behind v81's column-exists guard (a fresh install
 * already has all eight from schema.sql, which runs before the chain). Each ALTER below is identical to its column in
 * schema.sql, and the order here is the order there (appended at the end of the table). Column-level vocabulary
 * CHECKs only: every existing row is NULL in all eight, so every CHECK passes on the ALTER. No existing row is
 * written. No index, trigger or view names any of them. Re-runnable.
 *
 *   done_by_kind / note_by_kind     'agent' or 'ai_app'
 *   done_by_app / note_by_app       'anthropic' or 'openai'
 *   done_by_at / note_by_at         the time of the change
 *   done_by_stamp                   the exact checked_at text written by the same statement
 *   note_by_digest                  sha256 hex of the note text written by the same statement
 */
export const V85_ITEMS_TABLE_INFO_SQL = "PRAGMA table_info(transaction_checklist_items)";

/** [column name, ALTER statement], in schema.sql order. */
export const V85_ADD_AUTHOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  [
    "done_by_kind",
    "ALTER TABLE transaction_checklist_items ADD COLUMN done_by_kind TEXT CHECK (done_by_kind IS NULL OR done_by_kind IN ('agent', 'ai_app'));",
  ],
  [
    "done_by_app",
    "ALTER TABLE transaction_checklist_items ADD COLUMN done_by_app TEXT CHECK (done_by_app IS NULL OR done_by_app IN ('anthropic', 'openai'));",
  ],
  ["done_by_at", "ALTER TABLE transaction_checklist_items ADD COLUMN done_by_at TEXT;"],
  ["done_by_stamp", "ALTER TABLE transaction_checklist_items ADD COLUMN done_by_stamp TEXT;"],
  [
    "note_by_kind",
    "ALTER TABLE transaction_checklist_items ADD COLUMN note_by_kind TEXT CHECK (note_by_kind IS NULL OR note_by_kind IN ('agent', 'ai_app'));",
  ],
  [
    "note_by_app",
    "ALTER TABLE transaction_checklist_items ADD COLUMN note_by_app TEXT CHECK (note_by_app IS NULL OR note_by_app IN ('anthropic', 'openai'));",
  ],
  ["note_by_at", "ALTER TABLE transaction_checklist_items ADD COLUMN note_by_at TEXT;"],
  ["note_by_digest", "ALTER TABLE transaction_checklist_items ADD COLUMN note_by_digest TEXT;"],
];
