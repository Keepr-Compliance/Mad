/**
 * SQL authored by the contact IPC handlers — BACKLOG-3044 PR 3.
 *
 * Moved out of `electron/handlers/contactHandlers.ts` (3 sites). A handler is the
 * renderer's entry point, which makes it the worst place in the tree for SQL text to
 * live: it is the layer furthest from the database and the one most often edited for
 * reasons that have nothing to do with the query.
 *
 * The fourth escape in that file did not move — `CONTACT_SOURCE_RECORDS_SQL` is
 * already `db/contactSourceLinkSql.ts`, and this PR removes its escape by BRANDING
 * that constant rather than by relocating anything.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";

/** Every imported contact for a user. One bound parameter: the user id. */
export const IMPORTED_CONTACT_IDS_SQL = sql`SELECT id FROM contacts WHERE user_id = ? AND is_imported = 1`;

/**
 * The transactions a contact appears on. One bound parameter: contact id.
 *
 * `DISTINCT` because `transaction_contacts` can carry a contact on one transaction
 * more than once (different roles), and the caller wants deals, not rows.
 */
export const TRANSACTION_IDS_FOR_CONTACT_SQL = sql`SELECT DISTINCT transaction_id FROM transaction_contacts WHERE contact_id = ?`;

/**
 * Set a contact's default role. Two bound parameters: the role, then the contact id.
 *
 * ## This sentence is written SIX times in the tree, and five of them are elsewhere
 *
 * Enumerated by AST over cooked text, not by grep, at `79fbbcca3`:
 *
 *   electron/handlers/contactHandlers.ts:3771          this one, the only escape
 *   electron/services/db/transactionContactDbService.ts:249, :350, :382   `sql` tag
 *   electron/services/db/transactionContactDbService.ts:700, :724         `db.prepare`
 *
 * This constant REPLACES the first, so the tree still holds six statements of the
 * sentence rather than seven — it does not add a copy. The other five are already
 * inside the layer, so they are not BACKLOG-3044's escapes and moving them is not this
 * item's work; they are recorded here and in the PR so the next person has the exact
 * list rather than a suspicion, and so this constant is the obvious thing for them to
 * adopt.
 *
 * That is a real drift hazard of the kind `db/localUserSql.ts` was created to remove —
 * "three occurrences of one sentence" was its stated justification, and this is six.
 * It is stated rather than fixed here because deduplicating five in-layer call sites
 * in a file this PR was not asked to touch is a separate change with its own review.
 */
export const SET_CONTACT_DEFAULT_ROLE_SQL = sql`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
