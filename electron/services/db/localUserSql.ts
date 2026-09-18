/**
 * SQL for the single local user row — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/utils/userIdHelper.ts` (3 sites) and
 * `electron/handlers/messageImportHandlers.ts` (1 site). The rule and its CI
 * gate are BACKLOG-2959.
 *
 * ## Why one text is prepared in four places
 *
 * `users_local` holds exactly one row on a normal install: this is a
 * single-user desktop app, and the row is written once at onboarding. Four
 * different call sites need to answer "who is the local user", and before this
 * move each spelled the question out itself. The gate recorded the identical
 * text under two file keys (`text:e37e12ba8b64` in `userIdHelper.ts` at count 2
 * and in `messageImportHandlers.ts` at count 1) — three occurrences of one
 * sentence, which is precisely the drift hazard the `*Sql.ts` pattern removes.
 *
 * `LIMIT 1` is doing real work rather than defending against a duplicate: it
 * makes the read cheap and total. If a second row ever existed the result would
 * be arbitrary, but the schema's own `users_local` usage and the onboarding
 * path are what keep it single — not this clause.
 *
 * Both constants are byte-identical to the text they replaced, verified by the
 * gate's own content hashes (`e37e12ba8b64`, `ae88b2ae96f2`).
 *
 * ## 2026-09-09, BACKLOG-3254 — the counts above are history, not the state
 *
 * The `messageImportHandlers.ts` site described above is GONE, so the count
 * recorded for that file is now 0. That handler no longer asks "who is the
 * local user": an id it cannot confirm ends the call instead.
 *
 * `LOCAL_USER_ID_SQL` keeps its two callers in `userIdHelper.ts`, but they now
 * reach it only when the caller supplied NO id. It is never used to answer for
 * an id that was supplied and not found — that returns null.
 *
 * So the `LIMIT 1` paragraph above says something narrower than it did when it
 * was written. It no longer stands behind any path that had an id to check; it
 * answers "who is the local user" only for callers that never named one. For
 * that remaining path the arbitrary-result note stays accurate, and closing it
 * is BACKLOG-3254's follow-up F2 — it needs `electron/preload/outlookBridge.ts`
 * changed first, because those channels invoke with no argument at all.
 */

import { sql } from "./core/sqlText";

/** The local user's id. No bound parameters; returns `{ id }` or nothing. */
export const LOCAL_USER_ID_SQL = "SELECT id FROM users_local LIMIT 1";

/**
 * Confirms a specific id is the local user. One bound parameter.
 *
 * Distinct from `LOCAL_USER_ID_SQL` on purpose: this is the VALIDATION path —
 * a caller that already has an id and needs to know it is real before writing
 * rows that reference it — rather than the discovery path.
 */
export const LOCAL_USER_BY_ID_SQL = "SELECT id FROM users_local WHERE id = ?";

/**
 * The local user's id AND email — BACKLOG-2991, moved out of
 * `databaseService.runMigrations`, which reads it to attribute Sentry events
 * and breadcrumbs to a user before a migration runs.
 *
 * Deliberately a THIRD constant rather than a widening of `LOCAL_USER_ID_SQL`.
 * That constant's text is `SELECT id FROM users_local LIMIT 1`
 * (`f344b52a0ef5ca7e`); this one is `SELECT id, email FROM users_local LIMIT 1`
 * (`3b9b4568067d61f8`). They are not the same sentence, and the move that
 * brought this one into the layer had to keep its text byte-identical — so
 * bending either toward the other to save a constant would have been a
 * behaviour change disguised as a tidy-up. Its four callers do not want the
 * email; this caller does.
 */
export const LOCAL_USER_ID_AND_EMAIL_SQL = sql`SELECT id, email FROM users_local LIMIT 1`;

/**
 * Turn AI detection on or off for the local user — BACKLOG-3044, moved out of
 * `electron/handlers/licenseHandlers.ts`. Two bound parameters: the flag, then the
 * user id.
 *
 * Deliberately separate from `SET_LOCAL_USER_LICENSE_TYPE_SQL` below, and the reason
 * is a product rule rather than a style preference: entitlement here is PER FEATURE,
 * never inferred from a plan name. `ai_detection_enabled` works on any plan, so the
 * statement that sets it must not be reachable only through the one that sets the
 * plan.
 */
export const SET_LOCAL_USER_AI_DETECTION_SQL = sql`UPDATE users_local SET ai_detection_enabled = ? WHERE id = ?`;

/**
 * Set the local user's plan — BACKLOG-3044, moved out of
 * `electron/handlers/licenseHandlers.ts`. Two bound parameters: the license type,
 * then the user id.
 */
export const SET_LOCAL_USER_LICENSE_TYPE_SQL = sql`UPDATE users_local SET license_type = ? WHERE id = ?`;

/**
 * Read the AI-detection entitlement — BACKLOG-3044, moved out of
 * `electron/services/contactAutoLinkPolicy.ts`, which gates automatic contact
 * linking on it. One bound parameter: the user id.
 */
export const LOCAL_USER_AI_DETECTION_SQL = sql`SELECT ai_detection_enabled FROM users_local WHERE id = ?`;
