/**
 * SQL the database service runs on the database's OWN state — BACKLOG-2991.
 *
 * ## What belongs here, and what does not
 *
 * These statements are not application queries. They are the three things
 * `databaseService` asks of a database as an object in its own right:
 *
 *   - **migration bookkeeping** — recording which schema version a file is at,
 *     and asking whether the table that records it exists yet
 *   - **restore verification** — proving a restored file answers at all
 *
 * That distinction is why they are separated from the larger set that STAYS in
 * `databaseService.ts`. Of that file's 49 gate sites, **38** are
 * connection-configuration and maintenance PRAGMAs, `sqlite_master` reflection,
 * bootstrap DDL, and four `exec` sites that replay text the database itself
 * produced — none of which is query text a `db/` module can own. The full
 * classification, with per-site evidence, is on BACKLOG-2991.
 *
 * **This header said 42 until the probe below moved.** Those 38 are now owned by
 * BACKLOG-2992, the deferred item whose scope is exactly that class — recorded in
 * `scripts/ci/sql-boundary-baseline.json` and in the `OWNERS` map of
 * `scripts/ci/check-sql-boundary.mjs`, which is what `--update-baseline` reads.
 *
 * ## The one reflection statement that is NOT in that 38, and why
 *
 * `SCHEMA_VERSION_TABLE_EXISTS_SQL` below is `sqlite_master` reflection, which is
 * the class this header just said stays. It moved anyway, and the reason is not
 * that reflection changed category — it is that at **all four** of its call sites
 * it is the GUARD for a statement that had already moved:
 *
 *     const svTableRow = currentDb.prepare(SCHEMA_VERSION_TABLE_EXISTS_SQL).get();
 *     if (svTableRow) {
 *       currentDb.prepare(SCHEMA_VERSION_SQL)                 // moved in PR #2484
 *
 * Before this change `databaseService.ts` imported the version read from `db/` and
 * authored its existence probe inline five lines above it, four times over. That
 * seam is precisely what the `*Sql.ts` pattern exists to remove, and it was SR's
 * one non-blocking finding on PR #2484. A class boundary that separates a
 * statement from its own guard is not a boundary worth keeping.
 *
 * The other twelve reflection prepares in `databaseService.ts` guard nothing that
 * moved, and stay with their class.
 *
 * ## The schema_version READ is deliberately not here
 *
 * `SELECT version FROM schema_version WHERE id = 1` already exists in the layer,
 * as `SCHEMA_VERSION_SQL` in `./storageDiagnosticsSql` (BACKLOG-2989). Its text
 * is byte-identical to the four call sites this item moved — verified by hash
 * (`1ddb16d1edc29131`), not by reading — so those four import the existing
 * constant. Minting a second copy of a sentence the layer already spells would
 * recreate exactly the drift hazard the `*Sql.ts` pattern removes, and
 * relocating the existing one would edit a module this item does not own.
 *
 * The read and the write therefore sit in different modules. That is a real
 * seam and it is recorded rather than tidied away: moving `SCHEMA_VERSION_SQL`
 * to sit beside `SCHEMA_VERSION_UPDATE_SQL` is a change to
 * `storageDiagnosticsSql.ts` and its other consumers, which is not this item's.
 */

import { sql } from "./core/sqlText";

/**
 * Stamps a completed migration onto the single `schema_version` row.
 *
 * One bound parameter: the version just applied. `updated_at` and `migrated_at`
 * are computed by SQLite rather than by the caller — `CURRENT_TIMESTAMP` and
 * `datetime('now')` are both UTC, and both were already in this statement
 * before it moved. The text is byte-identical to what
 * `databaseService._runVersionedMigrations` prepared (`e30e26e15f743e2e`);
 * substituting a JavaScript timestamp here would change what reaches SQLite,
 * which is the one thing a move must not do.
 */
export const SCHEMA_VERSION_UPDATE_SQL = sql`UPDATE schema_version SET version = ?, updated_at = CURRENT_TIMESTAMP, migrated_at = datetime('now') WHERE id = 1`;

/**
 * Does this file have a `schema_version` table at all?
 *
 * The guard in front of every read of that table. A database that predates the
 * schema baseline, or a fresh empty file, has no such table, and
 * `SELECT version FROM schema_version` on it does not return zero rows — it
 * throws. So the probe is not a nicety: it is what makes the read legal.
 *
 * Four call sites in `databaseService.ts` ask it, for four different decisions —
 * refuse a pre-baseline file, decide whether a migration is about to run, decide
 * whether to take the pre-junction snapshot, and decide whether to create the
 * table or to widen it. One text, four questions.
 *
 * Byte-identical to the literal those four sites authored inline before it moved.
 * `sha256` of the COOKED value — what reaches SQLite, not the source slice — is
 * `97199d038b7fcd99c95d4e792297e1adcb47cf1cd2b199f8aa5372d8f5a6333f` at all four
 * old sites and at this constant. Measured on both sides of the move rather than
 * asserted. Its first 16 hex are `97199d038b7fcd99`, the
 * key SR's independently built extractor named in the #2484 review — two
 * extractors, same identifier.
 *
 * The gate's own `text:a73cb4792d87` key is NOT that check. It hashes
 * whitespace-NORMALISED source (`sha256(src.replace(/\s+/g,' ').trim())`), so a
 * whitespace-only edit leaves it unchanged — which is exactly the difference a
 * move must not make. Do not cite the gate key as evidence of byte identity.
 *
 * No bound parameters: the table name is a constant of the schema, not an input.
 */
export const SCHEMA_VERSION_TABLE_EXISTS_SQL = sql`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`;

/**
 * The cheapest question that still proves a connection answers: no tables, no
 * schema, no rows on disk. Used after an automatic restore, where "the file
 * opened" is not evidence — an encrypted file opens fine under the wrong key
 * and fails on the first real read.
 *
 * No bound parameters. Returns `{ ok: 1 }`; anything else, including no row at
 * all, means the restored file is not usable.
 */
export const CONNECTIVITY_PROBE_SQL = sql`SELECT 1 AS ok`;
