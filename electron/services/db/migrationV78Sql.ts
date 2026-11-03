/**
 * SQL for migration v78 — BACKLOG-3968: a checklist item may link to texts.
 *
 * Two tables change, and SQLite cannot alter a CHECK, so both arrive by table
 * rebuild:
 *   - `transaction_checklist_links.kind` CHECK gains 'text';
 *   - `transaction_checklist_link_members` gains `message_id` (FK to
 *     `messages(id)` ON DELETE CASCADE, the same decision as attachments and
 *     emails — see schema.sql), a third arm in the exactly-one-member CHECK,
 *     and UNIQUE (link_id, message_id).
 *
 * ## Order (load-bearing)
 *
 *   1. drop the empty-group trigger (its body names both tables; a RENAME
 *      while it points at a dropped table would fail the schema re-parse);
 *   2. create both new tables under temporary names;
 *   3. copy links, then members, with explicit column lists;
 *   4. drop the old members table, then the old links table;
 *   5. rename the new tables to the real names;
 *   6. recreate every index and the trigger.
 *
 * Never rename an old table aside first: with `legacy_alter_table` OFF (the
 * driver default) RENAME rewrites every child's REFERENCES to follow it, and
 * dropping the renamed table would leave the members pointing at nothing
 * (migrationV72Sql.ts records the same trap). The new members table names
 * `transaction_checklist_links` from the start, so after step 5 it references
 * the rebuilt links table.
 *
 * The body runs inside the runner's transaction with `foreign_keys` OFF, so
 * no DROP cascades. Every statement is fully static.
 *
 * The two CREATE statements must stay identical to schema.sql's DDL for the
 * same tables: databaseService.migration-v78.test.ts compares the stored SQL
 * of a fresh database and an upgraded one, so a drift goes red.
 */

/** Does the members table already carry `message_id`? A fresh install does. */
export const V78_MEMBERS_TABLE_INFO_SQL = "PRAGMA table_info(transaction_checklist_link_members)";

export const V78_DROP_EMPTY_LINK_TRIGGER_SQL =
  "DROP TRIGGER IF EXISTS trg_checklist_link_members_drop_empty_link";

export const V78_CREATE_LINKS_NEW_SQL = `CREATE TABLE transaction_checklist_links_new (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('attachment', 'email', 'text')),
  label      TEXT NOT NULL CHECK (length(trim(label)) >= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- BACKLOG-3764 (migration v75 adds it to existing databases): 1 when the
  -- agent chose to send this group although its evidence is dated outside the
  -- deal's audit dates. No index/trigger/view may name it here (see v75).
  include_outside_dates INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, kind),
  FOREIGN KEY (item_id) REFERENCES transaction_checklist_items(id) ON DELETE CASCADE
)`;

export const V78_CREATE_MEMBERS_NEW_SQL = `CREATE TABLE transaction_checklist_link_members_new (
  id            TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  attachment_id TEXT,
  email_id      TEXT,
  message_id    TEXT,
  CHECK ((kind = 'attachment' AND attachment_id IS NOT NULL AND email_id IS NULL AND message_id IS NULL)
      OR (kind = 'email' AND email_id IS NOT NULL AND attachment_id IS NULL AND message_id IS NULL)
      OR (kind = 'text' AND message_id IS NOT NULL AND attachment_id IS NULL AND email_id IS NULL)),
  UNIQUE (link_id, attachment_id),
  UNIQUE (link_id, email_id),
  UNIQUE (link_id, message_id),
  FOREIGN KEY (link_id, kind) REFERENCES transaction_checklist_links(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
)`;

/** Explicit column lists: every existing link keeps its id, flag and order. */
export const V78_COPY_LINKS_SQL = `INSERT INTO transaction_checklist_links_new
  (id, item_id, kind, label, sort_order, created_at, include_outside_dates)
  SELECT id, item_id, kind, label, sort_order, created_at, include_outside_dates
  FROM transaction_checklist_links`;

/** Every existing member is an attachment or an email; `message_id` starts NULL. */
export const V78_COPY_MEMBERS_SQL = `INSERT INTO transaction_checklist_link_members_new
  (id, link_id, kind, attachment_id, email_id, message_id)
  SELECT id, link_id, kind, attachment_id, email_id, NULL
  FROM transaction_checklist_link_members`;

export const V78_DROP_MEMBERS_SQL = "DROP TABLE transaction_checklist_link_members";
export const V78_DROP_LINKS_SQL = "DROP TABLE transaction_checklist_links";

export const V78_RENAME_LINKS_SQL =
  "ALTER TABLE transaction_checklist_links_new RENAME TO transaction_checklist_links";
export const V78_RENAME_MEMBERS_SQL =
  "ALTER TABLE transaction_checklist_link_members_new RENAME TO transaction_checklist_link_members";

/**
 * Every index and the trigger, as schema.sql states them (IF NOT EXISTS, so a
 * fresh install — where only the message index is missing — is a no-op for the
 * rest). The message index lives ONLY here: schema.sql runs before this
 * migration against the old members table, which has no message_id.
 */
export const V78_INDEXES_AND_TRIGGER_SQL = `
CREATE INDEX IF NOT EXISTS idx_checklist_links_item
  ON transaction_checklist_links(item_id);
CREATE INDEX IF NOT EXISTS idx_checklist_members_attachment
  ON transaction_checklist_link_members(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_members_email
  ON transaction_checklist_link_members(email_id) WHERE email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_members_message
  ON transaction_checklist_link_members(message_id) WHERE message_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_checklist_link_members_drop_empty_link
AFTER DELETE ON transaction_checklist_link_members
WHEN NOT EXISTS (SELECT 1 FROM transaction_checklist_link_members m WHERE m.link_id = OLD.link_id)
BEGIN
  DELETE FROM transaction_checklist_links WHERE id = OLD.link_id;
END;
`;
