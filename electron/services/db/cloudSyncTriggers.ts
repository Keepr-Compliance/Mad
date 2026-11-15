/**
 * Keepr Cloud dirty-mark trigger lifecycle — BACKLOG-4243 PR-2 (plan §7.2), R1.
 *
 * THE RULE: the triggers exist on a profile if and only if some
 * `cloud_sync_settings` row has `enabled = 1` or `turn_off_owed_at` set
 * (CLOUD_SYNC_ACTIVE_SQL). Otherwise none exist. Every build type, no env term.
 *
 * - Turn-on creates them inside the transaction that sets `enabled = 1`,
 *   before every eligible deal is marked (`requireCloudSyncTriggers`).
 * - Every writer that clears the last qualifying row applies the rule in the
 *   same transaction (`applyCloudSyncTriggerRule`), so they are dropped then.
 * - `dropCloudSyncTriggers` runs before schema.sql and the versioned migrations
 *   whenever a migration will run; the rule is applied after them (also when a
 *   migration throws), on every open, and on a restored file.
 * - A pass re-checks them (`repairCloudSyncTriggersIfMissing`).
 *
 * None of these throws except `requireCloudSyncTriggers`, which must abort the
 * turn-on. Each trigger is created only when every table and column it names
 * exists: a trigger naming a missing column would make every write to its
 * table fail (plan fact 7).
 */
import {
  CLOUD_SYNC_ACTIVE_SQL,
  CLOUD_SYNC_TRIGGERS,
  MARK_ALL_ELIGIBLE_ENABLED_SQL,
  RESET_STATE_AFTER_RESTORE_SQL,
} from "./cloudSyncSql";
import { tableColumns, type SqlDb } from "./cloudSyncSqlDb";

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
 * Drops every Keepr Cloud trigger. Called before schema.sql and the chain
 * whenever a versioned migration is about to run (a migration may rebuild a
 * table a trigger reads; schema.sql alone never rebuilds a table). A no-op
 * when none exist. Returns false (and warns) on failure.
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

/** Every table and column the trigger names exists on this schema. */
function triggerCanBeCreated(t: (typeof CLOUD_SYNC_TRIGGERS)[number], cols: (table: string) => Set<string>): boolean {
  return Object.entries(t.requires).every(([table, needed]) => {
    const have = cols(table);
    return have.size > 0 && needed.every((c) => have.has(c));
  });
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
      const ready = triggerCanBeCreated(t, cols);
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

/** Rule 1: does this profile have a row that needs the triggers? False when the table is missing. */
export function cloudSyncTriggersWanted(db: SqlDb): boolean {
  if (tableColumns(db, "cloud_sync_settings").size === 0) return false;
  return !!db.prepare(CLOUD_SYNC_ACTIVE_SQL).get();
}

export interface RuleResult {
  ok: boolean;
  wanted: boolean;
  created: number;
  dropped: number;
}

/**
 * Applies the rule: when wanted, the triggers are made exact (ensure); when not,
 * every Keepr Cloud trigger is dropped. A profile with no trigger and no
 * qualifying row issues no DDL at all. Never throws.
 */
export function applyCloudSyncTriggerRule(db: SqlDb, log: TriggerLog = silentLog): RuleResult {
  try {
    if (cloudSyncTriggersWanted(db)) {
      const r = ensureCloudSyncTriggers(db, log);
      return { ok: r.ok, wanted: true, created: r.created, dropped: 0 };
    }
    const existing = [...existingTriggers(db).keys()];
    for (const name of existing) db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    return { ok: true, wanted: false, created: 0, dropped: existing.length };
  } catch (error) {
    log.warn("[CloudSync] Could not apply the trigger rule", { code: errorCode(error) });
    return { ok: false, wanted: false, created: 0, dropped: 0 };
  }
}

/**
 * Turn-on: every trigger must exist before the caller marks the user's deals,
 * inside the caller's transaction. Throws when any could not be created, so the
 * turn-on (flag included) rolls back.
 */
export function requireCloudSyncTriggers(db: SqlDb): void {
  const r = ensureCloudSyncTriggers(db);
  if (!r.ok || r.skipped.length > 0) {
    throw Object.assign(new Error("Keepr Cloud triggers could not be created"), { code: "CLOUD_SYNC_TRIGGERS" });
  }
}

/** Triggers already reported as "cannot be created on this schema" (one warning per process). */
const reportedUnavailable = new Set<string>();

/** Names the self-check has found it cannot create on this schema, this process. Read-only copy. */
export function cloudSyncTriggersUnavailable(): string[] {
  return [...reportedUnavailable].sort();
}

/**
 * Pass-time self-check: Keepr Cloud is on, so every trigger must exist. A
 * trigger that is missing or changed but CAN be created means deal changes may
 * have gone unmarked: recreate it and mark every eligible deal of every enabled
 * user, in one transaction. A trigger that CANNOT be created on this schema (a
 * table or column it names is missing) is not repairable by a pass: it is
 * reported once per process (names and a code only) and nothing is marked, so
 * passes do not re-mark every deal each time. Returns the number of triggers
 * recreated. A healthy profile costs three small reads (the table_info PRAGMA
 * and the active-row select of cloudSyncTriggersWanted, one sqlite_master read)
 * and no DDL.
 */
export function repairCloudSyncTriggersIfMissing(db: SqlDb, log: TriggerLog = silentLog): number {
  try {
    if (!cloudSyncTriggersWanted(db)) return 0;
    const existing = existingTriggers(db);
    const notExact = CLOUD_SYNC_TRIGGERS.filter((t) => {
      const stored = existing.get(t.name);
      return stored === undefined || !sameBody(stored, t.sql);
    });
    if (notExact.length === 0) return 0;
    const cache = new Map<string, Set<string>>();
    const cols = (table: string) => {
      let c = cache.get(table);
      if (!c) {
        c = tableColumns(db, table);
        cache.set(table, c);
      }
      return c;
    };
    const repairable = notExact.filter((t) => triggerCanBeCreated(t, cols));
    const unavailable = notExact.filter((t) => !triggerCanBeCreated(t, cols));
    const newlyUnavailable = unavailable.map((t) => t.name).filter((n) => !reportedUnavailable.has(n));
    if (newlyUnavailable.length > 0) {
      for (const n of newlyUnavailable) reportedUnavailable.add(n);
      log.warn("[CloudSync] Triggers cannot be created on this schema", {
        code: "CLOUD_SYNC_TRIGGER_PREREQUISITE",
        triggers: [...newlyUnavailable].sort(),
      });
    }
    if (repairable.length === 0) {
      // Only an unavailable trigger left behind (stored, prerequisites gone) needs DDL: ensure drops it.
      if (unavailable.some((t) => existing.has(t.name))) ensureCloudSyncTriggers(db, log);
      return 0;
    }
    return db.transaction(() => {
      const r = ensureCloudSyncTriggers(db, log);
      db.prepare(MARK_ALL_ELIGIBLE_ENABLED_SQL).run();
      log.warn("[CloudSync] Triggers were missing; recreated and every deal marked", { created: r.created });
      return r.created;
    })();
  } catch (error) {
    log.warn("[CloudSync] Trigger self-check failed", { code: errorCode(error) });
    return 0;
  }
}

/**
 * After this database was replaced by a restored copy: forget every recorded
 * content hash (the online copy may hold content this file no longer has) and
 * mark every eligible deal of every enabled user, in one transaction. Cloud ids
 * are kept so the delete direction still works. No-op on a file without the
 * Keepr Cloud tables. Returns false when it could not run.
 */
export function resetSyncStateAfterRestore(db: SqlDb): boolean {
  if (tableColumns(db, "cloud_sync_state").size === 0 || tableColumns(db, "cloud_sync_dirty").size === 0) return false;
  db.transaction(() => {
    db.prepare(RESET_STATE_AFTER_RESTORE_SQL).run();
    db.prepare(MARK_ALL_ELIGIBLE_ENABLED_SQL).run();
  })();
  return true;
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
 * trigger rule is applied to the restored file, then its Keepr Cloud records are
 * reset (resetSyncStateAfterRestore). Never throws.
 */
export function prepareRestoredFile(db: SqlDb, log: TriggerLog = silentLog): boolean {
  restoreEpochValue++;
  applyCloudSyncTriggerRule(db, log);
  try {
    return resetSyncStateAfterRestore(db);
  } catch (error) {
    log.warn("[CloudSync] Could not reset state after a restore", { code: errorCode(error) });
    return false;
  }
}

let restoreEpochValue = 0;

/** Increments on every restore of this database in this launch (0 = none). */
export function restoreEpoch(): number {
  return restoreEpochValue;
}
