/**
 * SQL the database service runs on the database's OWN state — BACKLOG-2991.
 *
 * ## What belongs here, and what does not
 *
 * These statements are not application queries. They are the two things
 * `databaseService` asks of a database as an object in its own right:
 *
 *   - **migration bookkeeping** — recording which schema version a file is at
 *   - **restore verification** — proving a restored file answers at all
 *
 * That distinction is why they are separated from the far larger set that
 * STAYS in `databaseService.ts`. Of that file's 49 gate sites, 42 are
 * connection-configuration and maintenance PRAGMAs, `sqlite_master` reflection,
 * bootstrap DDL, and four `exec` sites that replay text the database itself
 * produced — none of which is query text a `db/` module can own. The full
 * classification, with per-site evidence, is on BACKLOG-2991.
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
 * The cheapest question that still proves a connection answers: no tables, no
 * schema, no rows on disk. Used after an automatic restore, where "the file
 * opened" is not evidence — an encrypted file opens fine under the wrong key
 * and fails on the first real read.
 *
 * No bound parameters. Returns `{ ok: 1 }`; anything else, including no row at
 * all, means the restored file is not usable.
 */
export const CONNECTIVITY_PROBE_SQL = sql`SELECT 1 AS ok`;
