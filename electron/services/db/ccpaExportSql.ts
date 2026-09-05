/**
 * SQL for the CCPA subject-access export — BACKLOG-3044.
 *
 * Moved out of `electron/services/ccpaExportService.ts` (5 sites). The service builds
 * a complete copy of one user's data for a privacy request; before this move it
 * authored all five reads itself and handed the text to the `dbAll` conduit, which is
 * exactly the shape the SQL boundary gate cannot see.
 *
 * ## Every statement here is scoped by `user_id`, and that is the point
 *
 * This is the export that answers "give me everything you hold about me". A read that
 * lost its `WHERE user_id = ?` would disclose one person's messages to another, so
 * the scoping predicate is a correctness property of each statement rather than an
 * optimisation. Keeping the five texts in one place makes that property reviewable in
 * one screen instead of spread across a 316-line service.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";

/** Electronic activity: every message, newest first. One bound parameter: user id. */
export const CCPA_MESSAGES_SQL = sql`SELECT * FROM messages WHERE user_id = ? ORDER BY sent_at DESC`;

/** Inferences: the user's own classification feedback. One bound parameter. */
export const CCPA_CLASSIFICATION_FEEDBACK_SQL = sql`SELECT * FROM classification_feedback WHERE user_id = ?`;

/**
 * Inferences: learned feedback.
 *
 * The caller wraps this read in try/catch because `feedback_learning` may not exist on
 * every install. That is a property of the CALL, not of the text, so it stays at the
 * call site.
 */
export const CCPA_FEEDBACK_LEARNING_SQL = sql`SELECT * FROM feedback_learning WHERE user_id = ?`;

/**
 * Stored preferences. Also wrapped in try/catch at the call site — the table's shape
 * has varied across versions.
 */
export const CCPA_USER_PREFERENCES_SQL = sql`SELECT * FROM user_preferences WHERE user_id = ?`;

/**
 * Authentication: connected accounts, WITHOUT the tokens.
 *
 * The column list is explicit and must stay explicit. `SELECT *` on `oauth_tokens`
 * would put live access and refresh tokens into a file handed to the data subject —
 * and, being an export, one that leaves the machine. The named columns are the
 * disclosure; the omitted ones are the security boundary. One bound parameter.
 */
export const CCPA_OAUTH_TOKENS_SQL = sql`SELECT provider, purpose, scopes_granted, connected_email_address, permissions_granted_at, created_at FROM oauth_tokens WHERE user_id = ? AND is_active = 1`;
