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
 * Delete a specific set of thread names — THE SYNCHRONOUS PRIMITIVE.
 *
 * Takes the VALUES and derives the `IN` width from them, so a same-length
 * different-values divergence is unrepresentable rather than merely unlikely —
 * the lesson from BACKLOG-2989 chunk 4a, where the width and the bound values
 * were computed in two places.
 *
 * An empty set is answered without touching the database: `IN ()` is valid
 * SQLite that matches nothing, so building one would delete nothing by accident
 * rather than by design.
 *
 * WHY THIS ONE IS THE PRIMITIVE AND `deleteThreadNamesByIds` IS THE WRAPPER
 * (BACKLOG-2960). Its only production caller is inside the `db.transaction(...)`
 * body that `syncMacChatThreadNames` opens
 * (`macOSMessagesImportService/importHelpers.ts`). `better-sqlite3` commits when
 * that callback RETURNS, so the body must stay synchronous, and so must every
 * `db/**` call it makes. Never the reverse: a wrapper that awaits cannot be
 * called from a body at all.
 */
export function deleteThreadNamesByIdsSync(
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

/**
 * The seam export (BACKLOG-2960): promise-returning, so a caller outside this
 * layer is written against an interface a non-`better-sqlite3` driver could
 * also satisfy. Every caller must `await` it —
 *
 *     const cleared = await deleteThreadNamesByIds(db, userId, doomed);
 *
 * — except a caller inside a transaction body, which must call
 * `deleteThreadNamesByIdsSync` instead.
 *
 * A PLAIN function, never `async`, and the difference is not cosmetic. Measured
 * on the real driver for this module (PR #2546, control (c); the same pair was
 * measured on `llmSettingsDbService` in the #2544 SR review):
 *
 *   - plain wrapper, floated inside a synchronous `db.transaction` body after an
 *     in-body write, throwing from the driver -> the throw propagates out of the
 *     body synchronously and the in-body write is ROLLED BACK.
 *   - the same probe with this function made `async` -> the transaction sees no
 *     error and COMMITS the in-body write; the failure arrives afterwards as a
 *     rejection.
 *
 * So `Promise.resolve(...)` over a synchronous primitive is the whole shape: the
 * work, and any throw, happen before the promise exists.
 *
 * WHAT PROTECTS THE CALL SITE, AND WHAT DOES NOT. The consuming body is a RAW
 * `db.transaction(...)`, not `dbTransaction`, so `dbTransaction`'s conditional
 * return type cannot see it. Each of these was measured in PR #2546 against
 * that body, which lives outside `db/**`:
 *
 *   - an `async` body -> REJECTED by `no-restricted-syntax` (eslint.config.js).
 *   - a sync body doing `cleared += deleteThreadNamesByIds(...)` -> TS2365, but
 *     only because that site consumes the count arithmetically. It is not a
 *     general property of calling the wrapper from a body.
 *   - a sync body that FLOATS the wrapper -> the rows are still deleted, because
 *     a plain wrapper's work is synchronous; only the returned count is lost.
 *     WHICH instrument sees that moved under this train, so the answer is
 *     stamped: everything below was re-planted at the call site and re-run on
 *     `int/epic9-close@434f9a04a`, which carries #2547's sync-twin guard repair
 *     (both boundary checks went from `isAsync` to `isPromiseReturning`).
 *       * `void deleteThreadNamesByIds(...)` -> `tsc` silent; `npm run lint`
 *         silent (`no-floating-promises` is scoped to `electron/services/db/**`
 *         and this body is not in it — BACKLOG-3150); the REPAIRED twin guard
 *         goes RED, 1 failed of 5, naming `deleteThreadNamesByIdsSync` a dead
 *         twin. Against this PR's original base it was GREEN on this shape, so
 *         any docblock in this train saying "the guard stays green" is stale
 *         rather than wrong when written — re-derive it, do not copy it.
 *       * `cleared += deleteThreadNamesByIds(...)` -> RED twice: TS2365 as in
 *         the bullet above, and the same twin-guard failure.
 *     So both float shapes are now caught without running a test. What is NOT
 *     caught is the COUNT. Drop only the accumulation — leave
 *     `deleteThreadNamesByIdsSync(...)` in place with no `cleared +=`, so the
 *     rows still go and no promise appears anywhere — and `tsc`, `npm run lint`
 *     and the repaired guard are ALL still green (the guard walks reachability,
 *     it does not read arithmetic). The one instrument that goes RED is
 *     `services/__tests__/importHelpers.threadNameSync-2960.test.ts`, 2 failed
 *     of 4. The count, not the float, is what that suite uniquely protects.
 */
export function deleteThreadNamesByIds(
  db: DatabaseType,
  userId: string,
  threadIds: readonly string[],
): Promise<number> {
  return Promise.resolve(deleteThreadNamesByIdsSync(db, userId, threadIds));
}
