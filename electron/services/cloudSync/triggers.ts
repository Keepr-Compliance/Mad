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
import { CLOUD_SYNC_TRIGGERS, MARK_ALL_ELIGIBLE_ENABLED_SQL } from "../db/cloudSyncSql";
import { tableColumns, type SqlDb } from "./sqlDb";

export interface TriggerLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const silentLog: TriggerLog = { warn: () => undefined };

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

/** Drops every Keepr Cloud trigger. Returns false (and warns) on failure. */
export function dropCloudSyncTriggers(db: SqlDb, log: TriggerLog = silentLog): boolean {
  try {
    for (const t of CLOUD_SYNC_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
    return true;
  } catch (error) {
    log.warn("[CloudSync] Could not drop triggers", { code: errorCode(error) });
    return false;
  }
}

export interface EnsureResult {
  ok: boolean;
  created: number;
  skipped: string[];
}

/** Drops and re-creates every Keepr Cloud trigger whose tables and columns exist. */
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
    for (const t of CLOUD_SYNC_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
      const ready = Object.entries(t.requires).every(([table, needed]) => {
        const have = cols(table);
        return have.size > 0 && needed.every((c) => have.has(c));
      });
      if (!ready) {
        skipped.push(t.name);
        continue;
      }
      db.exec(t.sql);
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
