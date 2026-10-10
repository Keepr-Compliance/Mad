/**
 * BACKLOG-3837: has anything that the per-source text floors read changed since they
 * were last read? Answered without reading a message row.
 *
 * The floors (MESSAGES_FLOOR_BY_SOURCE_SQL) walk every text row of the user and
 * json_extract its source: 1.9 s at 668k messages warm, far longer cold on the PC. They
 * only change when a messages row is inserted, deleted, or has one of the columns the
 * floor query reads changed. So the result is cached against this token.
 *
 * Same mechanism as autoLinkInputTracker.ts: every write to `messages` runs on the main
 * process connection (the contact query workers open the database read-only), so TEMP
 * triggers on that connection count the writes that can change the floors. New rows are
 * found by MAX(rowid) (a b-tree seek), so an import costs nothing extra here.
 *
 * A new connection has no TEMP objects; the first read there installs them with a NEW
 * random epoch, which no stored token matches. Same if a trigger disappeared.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { sql, type SafeSql } from "./core/sqlText";

export interface SourceCoverageInputToken {
  epoch: number;
  writes: number;
  maxMessageRowid: number;
}

const BUMP = sql`UPDATE temp.keepr_srccov_gen SET n = n + 1 WHERE k = 'writes'`;

interface TriggerSpec {
  name: string;
  drop: SafeSql;
  ddl: SafeSql;
}

/** The columns MESSAGES_FLOOR_BY_SOURCE_SQL reads (besides the key). */
const TRIGGERS: ReadonlyArray<TriggerSpec> = [
  {
    name: "keepr_srccov_msg_del",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_srccov_msg_del`,
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_srccov_msg_del AFTER DELETE ON main.messages
    BEGIN ${BUMP}; END`,
  },
  {
    name: "keepr_srccov_msg_upd",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_srccov_msg_upd`,
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_srccov_msg_upd
    AFTER UPDATE OF metadata, channel, duplicate_of, user_id, sent_at, associated_message_type ON main.messages
    WHEN OLD.metadata IS NOT NEW.metadata OR OLD.channel IS NOT NEW.channel
      OR OLD.duplicate_of IS NOT NEW.duplicate_of OR OLD.user_id IS NOT NEW.user_id
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.associated_message_type IS NOT NEW.associated_message_type
    BEGIN ${BUMP}; END`,
  },
];

const INSTALLED_TRIGGERS_SQL = sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_srccov_%'`;
const GEN_ROWS_SQL = sql`SELECT k, n FROM temp.keepr_srccov_gen`;
const DROP_GEN_SQL = sql`DROP TABLE IF EXISTS temp.keepr_srccov_gen`;
const CREATE_GEN_SQL = sql`CREATE TEMP TABLE IF NOT EXISTS keepr_srccov_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`;
const SEED_GEN_SQL = sql`INSERT OR IGNORE INTO temp.keepr_srccov_gen (k, n) VALUES ('epoch', ?), ('writes', 0)`;
const MAX_ROWID_SQL = sql`SELECT COALESCE(MAX(rowid), 0) AS m FROM main.messages`;

function triggersIntact(db: DatabaseType): boolean {
  const installed = db.prepare(INSTALLED_TRIGGERS_SQL).all() as Array<{ name: string; tbl_name: string }>;
  const byName = new Map(installed.map((t) => [t.name, t.tbl_name]));
  return TRIGGERS.every((t) => byName.get(t.name) === "messages");
}

function readGens(db: DatabaseType): { epoch: number; writes: number } | null {
  const rows = db.prepare(GEN_ROWS_SQL).all() as Array<{ k: string; n: number }>;
  const m = new Map(rows.map((r) => [r.k, r.n]));
  const epoch = m.get("epoch");
  if (epoch === undefined) return null;
  return { epoch, writes: m.get("writes") ?? 0 };
}

function install(db: DatabaseType): void {
  db.transaction(() => {
    db.exec(DROP_GEN_SQL);
    for (const t of TRIGGERS) db.exec(t.drop);
    db.exec(CREATE_GEN_SQL);
    db.prepare(SEED_GEN_SQL).run(1 + Math.floor(Math.random() * 2 ** 40));
    for (const t of TRIGGERS) db.exec(t.ddl);
  })();
}

/**
 * The current token, installing the triggers when this connection has none (or lost
 * one). Null when they cannot be installed: callers then never serve a cached answer.
 */
export function readSourceCoverageInputToken(db: DatabaseType): SourceCoverageInputToken | null {
  try {
    let gens = triggersIntact(db) ? readGens(db) : null;
    if (!gens) {
      install(db);
      gens = readGens(db);
    }
    if (!gens) return null;
    const r = db.prepare(MAX_ROWID_SQL).get() as { m: number };
    return { epoch: gens.epoch, writes: gens.writes, maxMessageRowid: r.m };
  } catch {
    return null;
  }
}

export function sourceCoverageTokenKey(t: SourceCoverageInputToken): string {
  return `${t.epoch}:${t.writes}:${t.maxMessageRowid}`;
}
