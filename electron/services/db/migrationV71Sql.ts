/**
 * SQL for migration v71 — BACKLOG-2551 + BACKLOG-2839.
 *
 * Moved out of `electron/services/databaseService.ts` for the SQL boundary rule:
 * SQL text is DEFINED under `electron/services/db/` and imported. The migration
 * body's own constraint — "use raw `d.prepare`/`d.exec`, never call a `db/`
 * service" — is about not CALLING a service: the body runs synchronously inside
 * `currentDb.transaction(...)` with `foreign_keys` OFF, on the handle the runner
 * hands it, so it must not reach for `ensureDb()` or open anything of its own.
 * Importing a `const` string opens nothing and runs nothing at import time, so
 * the two rules do not conflict.
 *
 * Every statement here is parameterised or fully static; nothing is built by
 * interpolating a caller's value.
 */

/**
 * The whitespace set the non-blank CHECK trims before measuring length.
 *
 * LOAD-BEARING, and measured rather than assumed: SQLite's one-argument `trim()`
 * strips SPACES ONLY — `SELECT length(trim(char(9)))` returns 1 on the bundled
 * driver — so `length(trim(display_name)) > 0` would ACCEPT a tab-only name that
 * both JS writers reject and the card renders blank.
 *
 * This is a FLOOR, not parity with JS `.trim()`: U+2000-U+200A, U+3000 and U+FEFF
 * pass it and are empty to `.trim()`. SQLite's `trim()` takes a character set, not
 * a Unicode class, so parity is unreachable in SQL. `normalizeChatDisplayName`
 * (importHelpers.ts) and `getThreadDisplayName` (MessageThreadCard.tsx) remain
 * canonical; this is a backstop against writers that do not go through them.
 *
 * The SAME constant builds the CHECK and the copy filter below, so the constraint
 * and the rows admitted through it can never disagree.
 */
export const THREAD_NAME_TRIM_SET =
  "' '||char(9)||char(10)||char(13)||char(11)||char(12)||char(160)";

/** Does `attachments` already carry the v71 column? A fresh install does. */
export const V71_ATTACHMENTS_TABLE_INFO_SQL = "PRAGMA table_info(attachments)";

export const V71_ADD_PROVIDER_COLUMN_SQL =
  "ALTER TABLE attachments ADD COLUMN provider_attachment_id TEXT";

/**
 * The duplicate rows, and the survivor each one merges into.
 *
 * Keys on `storage_path`, NEVER on `filename`: the on-disk file is named by
 * content hash, so two rows sharing `(email_id, storage_path)` are ONE file
 * downloaded twice, while two rows with different `storage_path` are different
 * files and both stay even when identically named.
 *
 * `ORDER BY loser.rowid` makes "earliest wins" true for losers as well as for the
 * keeper. Without it SQLite may return the group in any order, so a group holding
 * two `'user'` losers would have an unspecified survivor — the same input could
 * resolve differently on two machines. NOTE: removing this clause is NOT
 * observable from a single run (SQLite happens to choose ascending rowid on a
 * plain scan), which is why the control that protects it asserts on this text.
 *
 * `loser.storage_path IS NOT NULL` is defence in depth, not load-bearing: the join
 * is an equality and NULL never equals NULL, so metadata-only rows are already
 * excluded. It is kept because the hazard IS real for the other natural spelling —
 * `GROUP BY email_id, storage_path` collapses all NULLs into one group.
 */
export const V71_SELECT_DUPLICATE_ATTACHMENTS_SQL = `SELECT loser.id AS loser, keeper.id AS keep
       FROM attachments loser
       JOIN attachments keeper
         ON keeper.email_id = loser.email_id
        AND keeper.storage_path = loser.storage_path
        AND keeper.rowid = (SELECT MIN(k.rowid) FROM attachments k
                             WHERE k.email_id = loser.email_id
                               AND k.storage_path = loser.storage_path)
      WHERE loser.storage_path IS NOT NULL
        AND loser.email_id IS NOT NULL
        AND loser.rowid <> keeper.rowid
      ORDER BY loser.rowid`;

/**
 * Five INERT DESCRIPTIVE columns, merged onto the survivor. Both rows point at the
 * same content-hash-named file, so each value was equally true of the survivor.
 *
 * `sync_session_id` is DELIBERATELY ABSENT. It is a lifecycle tag that drives a
 * destructive rollback: `deleteAttachmentsBySessionId` (db/syncDbService.ts)
 * deletes by it and returns storage paths no row references any more, which
 * iPhoneSyncStorageService then unlinks from disk. Copying it would enrol the
 * keeper in a session it was never part of. LATENT today — neither
 * `INSERT INTO attachments` in this codebase writes that column on an `email_id`
 * row, so the merge would always have copied NULL — but the rule holds regardless:
 * merge columns that DESCRIBE the file, never columns that ENROL the row in a
 * process. If a column appears in the WHERE of any DELETE, it is not copied.
 */
export const V71_COALESCE_DESCRIPTIVE_COLUMNS_SQL = `UPDATE attachments SET
         mime_type           = COALESCE(mime_type,           (SELECT mime_type           FROM attachments WHERE id = ?)),
         file_size_bytes     = COALESCE(file_size_bytes,     (SELECT file_size_bytes     FROM attachments WHERE id = ?)),
         external_message_id = COALESCE(external_message_id, (SELECT external_message_id FROM attachments WHERE id = ?)),
         text_content        = COALESCE(text_content,        (SELECT text_content        FROM attachments WHERE id = ?)),
         analysis_metadata   = COALESCE(analysis_metadata,   (SELECT analysis_metadata   FROM attachments WHERE id = ?))
       WHERE id = ?`;

/**
 * The classification TRIPLE, moved AS A UNIT by SOURCE PRECEDENCE — never field by
 * field, in any branch: a `'user'` source paired with a `'pattern'` type is a
 * classification nobody made.
 *
 *   loser is 'user' and keeper is not -> loser's triple wins. This is what protects
 *     a human correction from being replaced by a machine guess.
 *     `COALESCE(...,'') <> 'user'` also covers a keeper whose source is NULL, which
 *     is reachable because the column is nullable and its CHECK only constrains
 *     non-NULL values.
 *   else keeper's document_type IS NULL -> take the loser's triple
 *   else                                -> keeper wins
 *   both 'user' -> keeper wins; it is the MIN(rowid) row, the earlier correction.
 */
export const V71_MERGE_CLASSIFICATION_TRIPLE_SQL = `UPDATE attachments SET
         document_type            = (SELECT document_type            FROM attachments WHERE id = ?),
         document_type_confidence = (SELECT document_type_confidence FROM attachments WHERE id = ?),
         document_type_source     = (SELECT document_type_source     FROM attachments WHERE id = ?)
       WHERE id = ?
         AND (SELECT document_type FROM attachments WHERE id = ?) IS NOT NULL
         AND ( ((SELECT document_type_source FROM attachments WHERE id = ?) = 'user'
                AND COALESCE(document_type_source, '') <> 'user')
               OR document_type IS NULL )`;

/**
 * Re-point the one soft reference to `attachments` before its row is deleted.
 *
 * The runner turns `foreign_keys` OFF around the whole migration loop, so the
 * `ON DELETE SET NULL` on `classification_feedback.attachment_id` does NOT fire —
 * a plain DELETE would leave the feedback row pointing at a row that no longer
 * exists. Re-pointing also preserves the link rather than nulling it.
 */
export const V71_REPOINT_CLASSIFICATION_FEEDBACK_SQL =
  "UPDATE classification_feedback SET attachment_id = ? WHERE attachment_id = ?";

export const V71_DELETE_ATTACHMENT_SQL = "DELETE FROM attachments WHERE id = ?";

/**
 * Created HERE and never in `schema.sql`. `runMigrations` execs `schema.sql`
 * unconditionally BEFORE the versioned migrations, and on an existing database
 * `CREATE TABLE IF NOT EXISTS` no-ops — so a standalone `CREATE INDEX` naming a
 * column only a migration adds throws `no such column`, and `exec()` skips every
 * statement after it. Green on a fresh install, fatal on every upgrade.
 *
 * A fresh install still receives this index: it seeds `schema_version` at the
 * baseline and then runs v71 like any other database.
 *
 * Legacy rows carry NULL and are excluded by the partial predicate, so nothing
 * pre-existing can collide.
 *
 * BACKLOG-3187 SUPERSEDES what this comment used to say next. Gmail rows carried
 * NULL when v71 shipped because no field of Gmail's had been established as a
 * durable identity. One has since: `partId`, which Google documents as immutable
 * and which was measured stable across fetches while `attachmentId` rotated. Gmail
 * rows written after 3187 therefore carry a `partId` and ARE covered by this index.
 *
 * Rows written BEFORE it keep NULL, and there is no migration that fills them:
 * `partId` is not stored locally, cannot be derived from any column, and a
 * migration cannot re-fetch. What happens to such a row depends on whether its
 * bytes are already on disk:
 *
 *   storage_path IS NULL — the next on-demand download resolves it through
 *     `findEmailAttachmentRow` step 2 and `setEmailAttachmentStorage` stamps the
 *     `partId`. The row enters this index at that point.
 *   storage_path SET     — `processAttachment` returns "already downloaded" BEFORE
 *     reaching the stamping call, so the row is NEVER stamped by any path. It keeps
 *     NULL permanently and stays on the filename-keyed lookup. Only a backfill that
 *     re-fetches part metadata from Gmail could reach it.
 */
export const V71_CREATE_PROVIDER_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_email_provider " +
  "ON attachments(email_id, provider_attachment_id) " +
  "WHERE provider_attachment_id IS NOT NULL";

/** The live DDL for `message_thread_names`, to test whether the rebuild already ran. */
export const V71_SELECT_THREAD_NAMES_DDL_SQL =
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='message_thread_names'";

/** SQLite has no `ALTER TABLE ADD CONSTRAINT`, so the CHECK arrives by rebuild. */
export const V71_CREATE_THREAD_NAMES_NEW_SQL = `CREATE TABLE message_thread_names_new (
         user_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         display_name TEXT NOT NULL
           CHECK (length(trim(display_name, ${THREAD_NAME_TRIM_SET})) > 0),
         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (user_id, thread_id),
         FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
       )`;

export const V71_COUNT_THREAD_NAMES_SQL =
  "SELECT COUNT(*) AS n FROM message_thread_names";

/**
 * Explicit column list, not `SELECT *`. Filters rather than throws: expected zero
 * rows (both writers already trim) but the migration must not fail if one exists.
 * Uses the SAME trim set as the CHECK above, so a row admitted here can never
 * violate the constraint it is being copied into.
 */
export const V71_COPY_THREAD_NAMES_SQL = `INSERT INTO message_thread_names_new (user_id, thread_id, display_name, updated_at)
       SELECT user_id, thread_id, display_name, updated_at
         FROM message_thread_names
        WHERE length(trim(display_name, ${THREAD_NAME_TRIM_SET})) > 0`;

export const V71_DROP_THREAD_NAMES_SQL = "DROP TABLE message_thread_names";

export const V71_RENAME_THREAD_NAMES_SQL =
  "ALTER TABLE message_thread_names_new RENAME TO message_thread_names";

/**
 * `DROP TABLE` took the table's indexes with it. Recreated here, or the table is
 * unindexed until the next launch re-execs `schema.sql`.
 */
export const V71_RECREATE_THREAD_NAME_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_message_thread_names_thread ON message_thread_names(thread_id)";
