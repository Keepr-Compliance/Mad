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
 */

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
