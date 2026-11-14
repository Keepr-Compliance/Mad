/**
 * Keepr Cloud dirty-mark trigger lifecycle — BACKLOG-4243 PR-2 (plan §7.2).
 *
 * `dropCloudSyncTriggers` runs before schema.sql and the versioned migrations;
 * `ensureCloudSyncTriggers` runs after them (in a finally, so a migration that
 * throws still ends with the triggers present) and on a restored file. Neither
 * ever throws: a failure is one WARN and the database still opens.
 *
 * Each trigger is created only when every table and column it names exists. A
 * trigger naming a missing column would make every write to its table fail
 * (plan fact 7), whether or not Keepr Cloud is on.
 */
import { CLOUD_SYNC_TRIGGERS, MARK_ALL_ELIGIBLE_ENABLED_SQL } from "./cloudSyncSql";
import { tableColumns, type SqlDb } from "./cloudSyncSqlDb";
import { resetSyncStateAfterRestore } from "./cloudSyncDbService";

export interface TriggerLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const silentLog: TriggerLog = { warn: () => undefined };

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

const EXISTING_TRIGGERS_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%'";

function existingTriggers(db: SqlDb): Map<string, string> {
  const rows = db.prepare(EXISTING_TRIGGERS_SQL).all() as Array<{ name: string; sql: string | null }>;
  return new Map(rows.map((r) => [r.name, r.sql ?? ""]));
}

function sameBody(stored: string, wanted: string): boolean {
  const norm = (x: string) => x.trim().replace(/;\s*$/, "");
  return norm(stored) === norm(wanted);
}

/**
 * Drops every Keepr Cloud trigger. Called before schema.sql and the chain only
 * when a versioned migration is about to run (a migration may rebuild a table
 * a trigger reads; schema.sql alone never rebuilds a table). Returns false
 * (and warns) on failure.
 */
export function dropCloudSyncTriggers(db: SqlDb, log: TriggerLog = silentLog): boolean {
  try {
    for (const name of existingTriggers(db).keys()) db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    return true;
  } catch (error) {
    log.warn("[CloudSync] Could not drop triggers", { code: errorCode(error) });
    return false;
  }
}

export interface EnsureResult {
  ok: boolean;
  /** Triggers created or replaced by this call. */
  created: number;
  skipped: string[];
}

/**
 * Makes the Keepr Cloud triggers exactly CLOUD_SYNC_TRIGGERS: a missing or
 * changed trigger is (re)created, an unknown one dropped, an identical one left
 * alone (no DDL on a normal launch). A trigger whose tables or columns are
 * missing is dropped and not created.
 */
export function ensureCloudSyncTriggers(db: SqlDb, log: TriggerLog = silentLog): EnsureResult {
  const skipped: string[] = [];
  let created = 0;
  try {
    const cache = new Map<string, Set<string>>();
    const cols = (t: string) => {
      let c = cache.get(t);
      if (!c) {
        c = tableColumns(db, t);
        cache.set(t, c);
      }
      return c;
    };
    const existing = existingTriggers(db);
    const wanted = new Set(CLOUD_SYNC_TRIGGERS.map((t) => t.name));
    for (const name of existing.keys()) {
      if (!wanted.has(name)) db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    }
    for (const t of CLOUD_SYNC_TRIGGERS) {
      const ready = Object.entries(t.requires).every(([table, needed]) => {
        const have = cols(table);
        return have.size > 0 && needed.every((c) => have.has(c));
      });
      const stored = existing.get(t.name);
      if (!ready) {
        if (stored !== undefined) db.prepare(`DROP TRIGGER IF EXISTS ${t.name}`).run();
        skipped.push(t.name);
        continue;
      }
      if (stored !== undefined && sameBody(stored, t.sql)) continue;
      if (stored !== undefined) db.prepare(`DROP TRIGGER IF EXISTS ${t.name}`).run();
      db.prepare(t.sql).run();
      created++;
    }
    if (skipped.length > 0) log.warn("[CloudSync] Some triggers not created", { skipped: skipped.length });
    return { ok: true, created, skipped };
  } catch (error) {
    log.warn("[CloudSync] Could not create triggers", { code: errorCode(error) });
    return { ok: false, created, skipped };
  }
}

/**
 * After an open in which a versioned migration ran: the triggers were absent
 * during it, so every eligible deal of every enabled user is marked (plan N3).
 */
export function markAllEligibleAfterMigration(db: SqlDb, log: TriggerLog = silentLog): boolean {
  try {
    if (tableColumns(db, "cloud_sync_settings").size === 0 || tableColumns(db, "cloud_sync_dirty").size === 0) {
      return false;
    }
    db.prepare(MARK_ALL_ELIGIBLE_ENABLED_SQL).run();
    return true;
  } catch (error) {
    log.warn("[CloudSync] Could not mark deals after a migration", { code: errorCode(error) });
    return false;
  }
}

/**
 * Every path that replaces this database with a restored copy ends here: the
 * triggers are made exact, then the restored file's Keepr Cloud records are
 * reset (resetSyncStateAfterRestore). Never throws.
 */
export function prepareRestoredFile(db: SqlDb, log: TriggerLog = silentLog): boolean {
  ensureCloudSyncTriggers(db, log);
  try {
    return resetSyncStateAfterRestore(db);
  } catch (error) {
    log.warn("[CloudSync] Could not reset state after a restore", { code: errorCode(error) });
    return false;
  }
}
