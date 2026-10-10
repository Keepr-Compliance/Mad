/**
 * BACKLOG-3837: has anything a cached messages read depends on changed since it was
 * last read? Answered without reading a message row.
 *
 * Mechanism (first written for the per-source coverage floors, sourceCoverageInputTracker.ts;
 * the same as autoLinkInputTracker.ts): every write to `messages` runs on the main process
 * connection (the contact query workers open the database read-only), so TEMP triggers on
 * that connection count the writes that can change the cached read. New rows are found by
 * MAX(rowid) (a b-tree seek), so an import costs nothing extra here.
 *
 * A new connection has no TEMP objects; the first read there installs them with a NEW
 * random epoch, which no stored token matches. Same if a trigger disappeared.
 *
 * Each cached read has its own spec (its own TEMP table and triggers), naming exactly the
 * columns that read depends on.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { sql, type SafeSql } from "./core/sqlText";

export interface MessagesInputToken {
  epoch: number;
  writes: number;
  maxMessageRowid: number;
}

export interface MessagesTriggerSpec {
  name: string;
  drop: SafeSql;
  ddl: SafeSql;
}

/** Everything one tracker needs; every statement written out (no SQL built from strings). */
export interface MessagesInputTrackerSpec {
  triggers: ReadonlyArray<MessagesTriggerSpec>;
  installedTriggersSql: SafeSql;
  genRowsSql: SafeSql;
  dropGenSql: SafeSql;
  createGenSql: SafeSql;
  seedGenSql: SafeSql;
}

const MAX_ROWID_SQL = sql`SELECT COALESCE(MAX(rowid), 0) AS m FROM main.messages`;

function triggersIntact(db: DatabaseType, spec: MessagesInputTrackerSpec): boolean {
  const installed = db.prepare(spec.installedTriggersSql).all() as Array<{ name: string; tbl_name: string }>;
  const byName = new Map(installed.map((t) => [t.name, t.tbl_name]));
  return spec.triggers.every((t) => byName.get(t.name) === "messages");
}

function readGens(db: DatabaseType, spec: MessagesInputTrackerSpec): { epoch: number; writes: number } | null {
  const rows = db.prepare(spec.genRowsSql).all() as Array<{ k: string; n: number }>;
  const m = new Map(rows.map((r) => [r.k, r.n]));
  const epoch = m.get("epoch");
  if (epoch === undefined) return null;
  return { epoch, writes: m.get("writes") ?? 0 };
}

function install(db: DatabaseType, spec: MessagesInputTrackerSpec): void {
  db.transaction(() => {
    db.exec(spec.dropGenSql);
    for (const t of spec.triggers) db.exec(t.drop);
    db.exec(spec.createGenSql);
    db.prepare(spec.seedGenSql).run(1 + Math.floor(Math.random() * 2 ** 40));
    for (const t of spec.triggers) db.exec(t.ddl);
  })();
}

/**
 * The current token, installing the triggers when this connection has none (or lost
 * one). Null when they cannot be installed: callers then never serve a cached answer.
 */
export function readMessagesInputToken(db: DatabaseType, spec: MessagesInputTrackerSpec): MessagesInputToken | null {
  try {
    let gens = triggersIntact(db, spec) ? readGens(db, spec) : null;
    if (!gens) {
      install(db, spec);
      gens = readGens(db, spec);
    }
    if (!gens) return null;
    const r = db.prepare(MAX_ROWID_SQL).get() as { m: number };
    return { epoch: gens.epoch, writes: gens.writes, maxMessageRowid: r.m };
  } catch {
    return null;
  }
}

export function messagesTokenKey(t: MessagesInputToken): string {
  return `${t.epoch}:${t.writes}:${t.maxMessageRowid}`;
}
