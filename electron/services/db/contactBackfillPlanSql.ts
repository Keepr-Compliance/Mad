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
 * This list is the REGISTER for these duplicate families — the place someone looks
 * before writing a fourth copy. It was stale within two months of being written, so
 * treat the note below about re-measuring as part of the register, not a caveat.
 *
 * **Re-measured 2026-09-04 by BACKLOG-3044 PR 3**, by AST over cooked text rather than
 * by grep, because a grep finds a NAME and these copies do not share one:
 *
 *   `IMPORTED_CONTACT_IDS_SQL`      **NO LONGER DUPLICATED.** Its twin was
 *                                   `contactHandlers.ts:901` behind `unsafeSql`;
 *                                   BACKLOG-3044 PR 3 moved that statement and pointed
 *                                   the handler at THIS constant. One occurrence in the
 *                                   tree. The convergence this register asked for
 *                                   happened.
 *
 *   `CONTACT_EXISTING_EMAILS_SQL`   2 occurrences — `:64` here, and
 *                                   `electron/services/db/contactDbService.ts:977`
 *                                   (local `existingSql`, `sql` tag).
 *                                   The old entry said `:978`; it is `:977`.
 *
 *   `CONTACT_EXISTING_PHONES_SQL`   **3 occurrences, not 2** — `:74` here,
 *                                   `electron/services/db/contactDbService.ts:1041`
 *                                   (local `existingSql`), and
 *                                   `electron/services/db/contactIdentityEvidenceSql.ts:48`
 *                                   (`CONTACT_PHONES_SQL`).
 *                                   The old entry named `contactIdentityEvidence.ts:387`
 *                                   "behind `unsafeSql`" — that site moved into the layer
 *                                   in BACKLOG-3044 PR 2 and is no longer an escape, but
 *                                   it is still a copy. **`contactDbService.ts:1041` was
 *                                   never listed at all.**
 *
 * **Not consolidated, deliberately.** SR's ruling on the identical question for the
 * six-fold `default_role` UPDATE applies here: a consolidation waits for the next real
 * edit to one of these statements, so it rides with a change that has a reason and a
 * test, rather than becoming a standalone diff that touches several services to save
 * characters. The register exists so that edit finds all of them.
 *
 * A name-based search will NOT find this family — the three phone copies are called
 * `CONTACT_EXISTING_PHONES_SQL`, `existingSql` and `CONTACT_PHONES_SQL`. Search by
 * TEXT.
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
