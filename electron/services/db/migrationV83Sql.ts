/**
 * SQL for migration v83 — BACKLOG-4263 PR-4c (a Keepr Cloud user's deleted deal can be restored for 30 days).
 *
 * Same SQL boundary rule as migrationV81Sql.ts: SQL text is DEFINED under `electron/services/db/` and imported,
 * never inlined in the migration body. The table's DDL lives in cloudSyncDealArchive.ts, the only module that
 * reads or writes it (plan §14 F7); this file re-exports it.
 *
 * Creates one table, empty, with CREATE TABLE IF NOT EXISTS (a fresh install already has it from schema.sql,
 * which runs before the chain). No existing row is written; no trigger, index or view names the table.
 */
export { DEAL_ARCHIVE_DDL as V83_DEAL_ARCHIVE_DDL } from "./cloudSyncDealArchive";
