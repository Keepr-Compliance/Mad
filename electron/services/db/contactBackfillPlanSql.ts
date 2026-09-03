/**
 * SQL for the imported-contact backfill PLAN — BACKLOG-3043.
 *
 * ## Why this module exists
 *
 * `electron/workers/contactQueryWorker.ts` authored these three statements at its
 * own `prepare` call sites. Its entry in `DECLARED_EXCEPTIONS`
 * (`scripts/ci/check-sql-boundary.mjs`) is **`pragma`-only** by BACKLOG-2959
 * ruling 3 — the worker opens its own readonly handle at `:69` and must
 * configure it — and that exception never covered query text. The three sites
 * classified `sql-text-authored-outside-db-layer` and were baselined with
 * `owner: BACKLOG-3043`.
 *
 * The file was described in BACKLOG-2989's disposition table as "already
 * compliant — imports its SQL text from `db/*Sql.ts`". That is true of three of
 * its six `prepare` sites and false of the other three. **"Imports from
 * `db/*Sql.ts`" is not the compliance property. "Argument 0 is a bare identifier
 * resolving to a `db/` import" is.**
 *
 * ## The tag, not a bare template literal
 *
 * These are declared with the `sql` tag from `./core/sqlText` (BACKLOG-3064), so
 * their type is `SafeSql` rather than `string`. `SafeSql` is an intersection with
 * `string`, so each constant is still accepted by `better-sqlite3`'s
 * `prepare(source: string)` — which is what the worker calls on its own handle.
 * Nothing is wrapped and no character changes; the tag's `strings` argument is
 * the COOKED array, so the text produced is byte-identical to the template
 * literal it replaced.
 *
 * All three take their values as positional `?` parameters. None interpolates,
 * so none would have compiled if it did — the tag refuses to splice a value.
 *
 * ## The statements are duplicated elsewhere, and this module does not fix that
 *
 * Recorded so a later convergence is discoverable rather than re-derived. These
 * files were deliberately NOT edited by BACKLOG-3043, whose scope is the worker:
 *
 *   `IMPORTED_CONTACT_IDS_SQL`      byte-identical to `electron/handlers/contactHandlers.ts:901`
 *                                   (the main-thread backfill twin, behind `unsafeSql`)
 *   `CONTACT_EXISTING_EMAILS_SQL`   byte-identical to `electron/services/db/contactDbService.ts:978`
 *   `CONTACT_EXISTING_PHONES_SQL`   byte-identical to `electron/services/contactIdentityEvidence.ts:387`
 *                                   (behind `unsafeSql`)
 *
 * The worker copy is the one that runs in production whenever the worker pool is
 * warm (see `contactSourceLinkSql.ts`'s header on the same two-implementation
 * hazard), so it is the copy that had to move first.
 */

import { sql } from "./core/sqlText";

/**
 * Every imported contact for a user — the backfill plan's outer loop.
 *
 * Params: `[userId]`.
 */
export const IMPORTED_CONTACT_IDS_SQL = sql`SELECT id FROM contacts WHERE user_id = ? AND is_imported = 1`;

/**
 * The email addresses a contact already holds, lower-cased in SQLite so the
 * caller's `Set` membership test needs no second normalisation pass.
 *
 * Params: `[contactId]`.
 */
export const CONTACT_EXISTING_EMAILS_SQL = sql`SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?`;

/**
 * The phone numbers a contact already holds, in E.164. The caller reduces each
 * to its last 10 digits before comparing — that key derivation is deliberately
 * NOT in SQL, because the same reduction has to be applied to the incoming
 * candidate values, which are not in the database yet.
 *
 * Params: `[contactId]`.
 */
export const CONTACT_EXISTING_PHONES_SQL = sql`SELECT phone_e164 FROM contact_phones WHERE contact_id = ?`;
