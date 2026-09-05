/**
 * SQL for macOS-imported thread display names — BACKLOG-2990 chunk 1.
 *
 * Moved out of `electron/services/macOSMessagesImportService/importHelpers.ts`.
 * Keepr's own schema, unlike this chunk's other module.
 *
 * `message_thread_names` holds the human name for a text thread — the group
 * chat's title, or the participant list a one-to-one thread is shown under.
 * The macOS importer owns every row whose `thread_id` starts `macos-chat-`,
 * which is why the reconciliation statements below are prefix-scoped rather
 * than user-scoped alone: a user can have thread names from other sources, and
 * a macOS re-import must not touch them.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Upsert one thread's display name.
 *
 * `ON CONFLICT ... DO UPDATE` rather than delete-then-insert: a re-import that
 * deleted first would leave the name missing for the window between the two
 * statements, and the UI reads this table live.
 *
 * `updated_at` is stamped by the statement, not passed in, so a caller cannot
 * accidentally preserve a stale timestamp on a real change.
 */
export const UPSERT_THREAD_NAME_SQL = `INSERT INTO message_thread_names (user_id, thread_id, display_name, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, thread_id) DO UPDATE SET
       display_name = excluded.display_name,
       updated_at = CURRENT_TIMESTAMP`;

/** Every macOS-owned thread name for a user. One bound parameter. */
export const DELETE_MACOS_THREAD_NAMES_SQL = `DELETE FROM message_thread_names
            WHERE user_id = ? AND thread_id LIKE 'macos-chat-%'`;

/** The macOS-owned thread ids for a user, so a caller can diff before deleting. */
export const SELECT_MACOS_THREAD_IDS_SQL = `SELECT thread_id FROM message_thread_names
            WHERE user_id = ? AND thread_id LIKE 'macos-chat-%'`;

/**
 * Delete a specific set of thread names.
 *
 * Takes the VALUES and derives the `IN` width from them, so a same-length
 * different-values divergence is unrepresentable rather than merely unlikely —
 * the lesson from BACKLOG-2989 chunk 4a, where the width and the bound values
 * were computed in two places.
 *
 * An empty set is answered without touching the database: `IN ()` is valid
 * SQLite that matches nothing, so building one would delete nothing by accident
 * rather than by design.
 */
export function deleteThreadNamesByIds(
  db: DatabaseType,
  userId: string,
  threadIds: readonly string[],
): number {
  if (threadIds.length === 0) return 0;
  const placeholders = threadIds.map(() => "?").join(", ");
  return db
    .prepare(
      `DELETE FROM message_thread_names
              WHERE user_id = ? AND thread_id IN (${placeholders})`,
    )
    .run(userId, ...threadIds).changes;
}
