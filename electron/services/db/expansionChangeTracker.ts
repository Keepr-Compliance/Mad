/**
 * BACKLOG-3868: has anything the attached-thread expansion depends on changed since its
 * last completed run? Answered without reading a message row.
 *
 * Every write to `messages`, `communications` and `ignored_communications` runs on the
 * main process connection (the contact query workers open the database read-only,
 * contactQueryWorker.ts `{ readonly: true }`). TEMP triggers on that connection count
 * the writes that can change what the expansion would link, in a TEMP table:
 *
 *   msg        a message DELETE; an UPDATE of thread_id / participants / direction /
 *              channel / duplicate_of / user_id; transaction_id set to NULL (unlink)
 *   comm_ins   a per-message communications INSERT (a new attached pair)
 *   comm_other a per-message communications DELETE, or an UPDATE of its link columns
 *   ign        any change to ignored_communications (suppression added or restored)
 *
 * New messages are not counted here: they are found by rowid (MAX(rowid) per user is an
 * index seek), which is how a post-sync run looks at only the threads that grew.
 *
 * The TEMP objects exist only on the connection that created them. A new connection (a
 * restore, a re-open) has none, so the first check there creates them with a NEW random
 * epoch, which no stored snapshot matches: the next run is a full one. The same happens
 * if a trigger disappeared (its table was dropped or rebuilt) — the check sees fewer
 * triggers than it installed and starts a new epoch.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { sql, type SafeSql } from "./core/sqlText";

export interface ExpansionChangeSnapshot {
  epoch: number;
  msg: number;
  commIns: number;
  commOther: number;
  ign: number;
}

const GEN_TABLE = sql`temp.keepr_expansion_gen`;

/** name -> table, so a trigger moved by a table rename is noticed too. */
const TRIGGERS: ReadonlyArray<{ name: string; table: string; drop: SafeSql; ddl: SafeSql }> = [
  {
    name: "keepr_exp_msg_del",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_msg_del`,
    table: "messages",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_msg_del AFTER DELETE ON main.messages
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'msg'; END`,
  },
  {
    name: "keepr_exp_msg_upd",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_msg_upd`,
    table: "messages",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_msg_upd
      AFTER UPDATE OF thread_id, participants, direction, channel, duplicate_of, user_id ON main.messages
      WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.participants IS NOT NEW.participants
        OR OLD.direction IS NOT NEW.direction OR OLD.channel IS NOT NEW.channel
        OR OLD.duplicate_of IS NOT NEW.duplicate_of OR OLD.user_id IS NOT NEW.user_id
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'msg'; END`,
  },
  {
    name: "keepr_exp_msg_unlink",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_msg_unlink`,
    table: "messages",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_msg_unlink AFTER UPDATE OF transaction_id ON main.messages
      WHEN OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS NULL
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'msg'; END`,
  },
  {
    name: "keepr_exp_comm_ins",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_comm_ins`,
    table: "communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_comm_ins AFTER INSERT ON main.communications
      WHEN NEW.message_id IS NOT NULL
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'comm_ins'; END`,
  },
  {
    name: "keepr_exp_comm_del",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_comm_del`,
    table: "communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_comm_del AFTER DELETE ON main.communications
      WHEN OLD.message_id IS NOT NULL
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'comm_other'; END`,
  },
  {
    name: "keepr_exp_comm_upd",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_comm_upd`,
    table: "communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_comm_upd
      AFTER UPDATE OF transaction_id, message_id, user_id ON main.communications
      WHEN OLD.transaction_id IS NOT NEW.transaction_id OR OLD.message_id IS NOT NEW.message_id
        OR OLD.user_id IS NOT NEW.user_id
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'comm_other'; END`,
  },
  {
    name: "keepr_exp_ign_ins",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_ign_ins`,
    table: "ignored_communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_ign_ins AFTER INSERT ON main.ignored_communications
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'ign'; END`,
  },
  {
    name: "keepr_exp_ign_del",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_ign_del`,
    table: "ignored_communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_ign_del AFTER DELETE ON main.ignored_communications
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'ign'; END`,
  },
  {
    name: "keepr_exp_ign_upd",
    drop: sql`DROP TRIGGER IF EXISTS temp.keepr_exp_ign_upd`,
    table: "ignored_communications",
    ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_exp_ign_upd AFTER UPDATE ON main.ignored_communications
      BEGIN UPDATE ${GEN_TABLE} SET n = n + 1 WHERE k = 'ign'; END`,
  },
];

const INSTALLED_TRIGGERS_SQL = sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_exp_%'`;
const GEN_ROWS_SQL = sql`SELECT k, n FROM temp.keepr_expansion_gen`;
const DROP_GEN_SQL = sql`DROP TABLE IF EXISTS temp.keepr_expansion_gen`;
const CREATE_GEN_SQL = sql`CREATE TEMP TABLE IF NOT EXISTS keepr_expansion_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`;
const SEED_GEN_SQL = sql`INSERT OR IGNORE INTO temp.keepr_expansion_gen (k, n)
  VALUES ('epoch', ?), ('msg', 0), ('comm_ins', 0), ('comm_other', 0), ('ign', 0)`;

function triggersIntact(db: DatabaseType): boolean {
  const installed = db.prepare(INSTALLED_TRIGGERS_SQL).all() as Array<{ name: string; tbl_name: string }>;
  const byName = new Map(installed.map((t) => [t.name, t.tbl_name]));
  return TRIGGERS.every((t) => byName.get(t.name) === t.table);
}

function readGens(db: DatabaseType): ExpansionChangeSnapshot | null {
  const rows = db.prepare(GEN_ROWS_SQL).all() as Array<{ k: string; n: number }>;
  const m = new Map(rows.map((r) => [r.k, r.n]));
  const epoch = m.get("epoch");
  if (epoch === undefined) return null;
  return {
    epoch,
    msg: m.get("msg") ?? 0,
    commIns: m.get("comm_ins") ?? 0,
    commOther: m.get("comm_other") ?? 0,
    ign: m.get("ign") ?? 0,
  };
}

function install(db: DatabaseType): void {
  // Table, then triggers, in one transaction: never triggers without their counters.
  db.transaction(() => {
    db.exec(DROP_GEN_SQL);
    for (const t of TRIGGERS) db.exec(t.drop);
    db.exec(CREATE_GEN_SQL);
    db.prepare(SEED_GEN_SQL).run(1 + Math.floor(Math.random() * 2 ** 40));
    for (const t of TRIGGERS) db.exec(t.ddl);
  })();
}

/**
 * The current counters, installing the triggers when this connection has none (or lost
 * one). Null when they cannot be installed (e.g. a read-only connection): callers then
 * treat every run as changed.
 */
export function readExpansionChangeSnapshot(db: DatabaseType): ExpansionChangeSnapshot | null {
  try {
    const gens = triggersIntact(db) ? readGens(db) : null;
    if (gens) return gens;
    install(db);
    return readGens(db);
  } catch {
    return null;
  }
}

export function sameSnapshot(a: ExpansionChangeSnapshot | null, b: ExpansionChangeSnapshot | null): boolean {
  return (
    !!a &&
    !!b &&
    a.epoch === b.epoch &&
    a.msg === b.msg &&
    a.commIns === b.commIns &&
    a.commOther === b.commOther &&
    a.ign === b.ign
  );
}
