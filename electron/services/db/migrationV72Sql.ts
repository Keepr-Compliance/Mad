/**
 * SQL for migration v72 — BACKLOG-3476: a transaction may hold several
 * checklists.
 *
 * `transaction_checklists` shipped (BACKLOG-3475, never in a packaged build)
 * with `transaction_id … UNIQUE`. SQLite has no `ALTER TABLE DROP CONSTRAINT`,
 * so the new shape — `UNIQUE (transaction_id, template_id)` plus a
 * `sort_order` column — arrives by table rebuild.
 *
 * ## The rebuild order is load-bearing: create new, copy, drop old, rename new
 *
 * Never rename the old table aside first. With `legacy_alter_table` OFF (the
 * driver default), `ALTER TABLE … RENAME` rewrites every child's
 * `REFERENCES transaction_checklists` to follow the renamed table; dropping it
 * afterwards would leave `transaction_checklist_items` pointing at a table that
 * no longer exists, and every cascade below it silently dead.
 *
 * The body runs inside the runner's transaction with `foreign_keys` OFF, so
 * `DROP TABLE` does not cascade into the items. SQL text is defined here and
 * imported, per the SQL boundary rule (see `migrationV71Sql.ts`).
 */

/**
 * The indexes on `transaction_checklists`. `origin = 'u'` marks one created by
 * a UNIQUE constraint. Empty when the table does not exist.
 */
export const V72_CHECKLIST_INDEX_LIST_SQL =
  "SELECT name, origin FROM pragma_index_list('transaction_checklists')";

/** The columns of one index, in index order. One bound parameter: the index name. */
export const V72_INDEX_COLUMNS_SQL =
  "SELECT name FROM pragma_index_info(?) ORDER BY seqno";

/**
 * The new table, under a temporary name. Must stay identical to the
 * `transaction_checklists` DDL in schema.sql — the fresh-vs-upgraded
 * fingerprint test and the CHECK test in databaseService.migration-v72.test.ts
 * hold that.
 */
export const V72_CREATE_CHECKLISTS_NEW_SQL = `CREATE TABLE transaction_checklists_new (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  template_id    TEXT NOT NULL,
  template_name  TEXT NOT NULL CHECK (length(trim(template_name)) BETWEEN 1 AND 200),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  selected_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (transaction_id, template_id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
)`;

/** Explicit column lists. The old shape held at most one checklist per transaction, so every copied row takes position 0. */
export const V72_COPY_CHECKLISTS_SQL = `INSERT INTO transaction_checklists_new
  (id, transaction_id, template_id, template_name, sort_order, selected_at)
  SELECT id, transaction_id, template_id, template_name, 0, selected_at
  FROM transaction_checklists`;

export const V72_DROP_CHECKLISTS_SQL = "DROP TABLE transaction_checklists";

export const V72_RENAME_CHECKLISTS_SQL =
  "ALTER TABLE transaction_checklists_new RENAME TO transaction_checklists";
