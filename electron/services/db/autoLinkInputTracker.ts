/**
 * BACKLOG-3883: has anything the per-contact auto-link reads changed since a deal's last
 * full sweep? Answered without reading a message row.
 *
 * Creating a deal ran the full per-contact sweep, and the deal's details opening a moment
 * later ran it again (review:sync "open"), as did the create email trigger's covered
 * path — the same work, on the same inputs, on the main process. A second sweep is only
 * worth running when an input changed, and this module is the test for that.
 *
 * Same mechanism as expansionChangeTracker.ts: every write to these tables runs on the
 * main process connection (the contact query workers open the database read-only), so
 * TEMP triggers on that connection count the writes that can change what a sweep would
 * do. One counter, because a sweep's caller only needs "anything changed?".
 *
 * NOT counted, on purpose: a sweep's own outputs — a `communications` INSERT, a review
 * queue INSERT, `messages.transaction_id` being set. Each is idempotent for a re-run (an
 * already-linked thread or queued email is skipped), and counting them would make every
 * sweep invalidate itself. A review item leaving the queue is not counted either: an
 * approve links it (a re-run skips a linked email) and a reject writes
 * ignored_communications (counted). The review queue table is read only by
 * reviewStateService (BACKLOG-2791 single read path), so it is not named here.
 *
 * New rows in the big tables are not counted by trigger either: they are found by
 * MAX(rowid) (a b-tree seek), so an import costs nothing extra here.
 *
 * A new connection has no TEMP objects; the first check there installs them with a NEW
 * random epoch, which no stored token matches, so the next sweep runs. Same if a trigger
 * disappeared (its table was dropped or rebuilt).
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { sql, type SafeSql } from "./core/sqlText";

export interface AutoLinkInputToken {
  epoch: number;
  writes: number;
  maxMessageRowid: number;
  maxEmailRowid: number;
  maxParticipantRowid: number;
}

const BUMP = sql`UPDATE temp.keepr_autolink_gen SET n = n + 1 WHERE k = 'writes'`;

interface TriggerSpec {
  name: string;
  table: string;
  drop: SafeSql;
  ddl: SafeSql;
}

function trigger(name: string, table: string, drop: SafeSql, ddl: SafeSql): TriggerSpec {
  return { name, table, drop, ddl };
}

/** name -> table, so a trigger moved by a table rename is noticed too. */
const TRIGGERS: ReadonlyArray<TriggerSpec> = [
  trigger("keepr_al_msg_del", "messages", sql`DROP TRIGGER IF EXISTS temp.keepr_al_msg_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_msg_del AFTER DELETE ON main.messages
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_msg_upd", "messages", sql`DROP TRIGGER IF EXISTS temp.keepr_al_msg_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_msg_upd
    AFTER UPDATE OF thread_id, participants, participants_flat, channel, duplicate_of, user_id, sent_at, associated_message_type ON main.messages
    WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.participants IS NOT NEW.participants
      OR OLD.participants_flat IS NOT NEW.participants_flat OR OLD.channel IS NOT NEW.channel
      OR OLD.duplicate_of IS NOT NEW.duplicate_of OR OLD.user_id IS NOT NEW.user_id
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.associated_message_type IS NOT NEW.associated_message_type
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_msg_unlink", "messages", sql`DROP TRIGGER IF EXISTS temp.keepr_al_msg_unlink`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_msg_unlink AFTER UPDATE OF transaction_id ON main.messages
    WHEN OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS NULL
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_email_del", "emails", sql`DROP TRIGGER IF EXISTS temp.keepr_al_email_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_email_del AFTER DELETE ON main.emails
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_email_upd", "emails", sql`DROP TRIGGER IF EXISTS temp.keepr_al_email_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_email_upd
    AFTER UPDATE OF subject, body_plain, sent_at, user_id ON main.emails
    WHEN OLD.subject IS NOT NEW.subject OR OLD.body_plain IS NOT NEW.body_plain
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.user_id IS NOT NEW.user_id
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ep_del", "email_participants", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ep_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ep_del AFTER DELETE ON main.email_participants
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ep_upd", "email_participants", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ep_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ep_upd AFTER UPDATE ON main.email_participants
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_comm_del", "communications", sql`DROP TRIGGER IF EXISTS temp.keepr_al_comm_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_comm_del AFTER DELETE ON main.communications
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_comm_upd", "communications", sql`DROP TRIGGER IF EXISTS temp.keepr_al_comm_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_comm_upd
    AFTER UPDATE OF transaction_id, email_id, thread_id, message_id, user_id ON main.communications
    WHEN OLD.transaction_id IS NOT NEW.transaction_id OR OLD.email_id IS NOT NEW.email_id
      OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id
      OR OLD.user_id IS NOT NEW.user_id
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ign_ins", "ignored_communications", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ign_ins`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ign_ins AFTER INSERT ON main.ignored_communications
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ign_del", "ignored_communications", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ign_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ign_del AFTER DELETE ON main.ignored_communications
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ign_upd", "ignored_communications", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ign_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ign_upd AFTER UPDATE ON main.ignored_communications
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ce_ins", "contact_emails", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ce_ins`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ce_ins AFTER INSERT ON main.contact_emails
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ce_del", "contact_emails", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ce_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ce_del AFTER DELETE ON main.contact_emails
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_ce_upd", "contact_emails", sql`DROP TRIGGER IF EXISTS temp.keepr_al_ce_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_ce_upd AFTER UPDATE ON main.contact_emails
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_cp_ins", "contact_phones", sql`DROP TRIGGER IF EXISTS temp.keepr_al_cp_ins`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_cp_ins AFTER INSERT ON main.contact_phones
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_cp_del", "contact_phones", sql`DROP TRIGGER IF EXISTS temp.keepr_al_cp_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_cp_del AFTER DELETE ON main.contact_phones
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_cp_upd", "contact_phones", sql`DROP TRIGGER IF EXISTS temp.keepr_al_cp_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_cp_upd AFTER UPDATE ON main.contact_phones
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_tc_ins", "transaction_contacts", sql`DROP TRIGGER IF EXISTS temp.keepr_al_tc_ins`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_tc_ins AFTER INSERT ON main.transaction_contacts
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_tc_del", "transaction_contacts", sql`DROP TRIGGER IF EXISTS temp.keepr_al_tc_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_tc_del AFTER DELETE ON main.transaction_contacts
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_tc_upd", "transaction_contacts", sql`DROP TRIGGER IF EXISTS temp.keepr_al_tc_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_tc_upd AFTER UPDATE ON main.transaction_contacts
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_txn_del", "transactions", sql`DROP TRIGGER IF EXISTS temp.keepr_al_txn_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_txn_del AFTER DELETE ON main.transactions
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_txn_upd", "transactions", sql`DROP TRIGGER IF EXISTS temp.keepr_al_txn_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_txn_upd
    AFTER UPDATE OF started_at, closed_at, created_at, property_address, property_street, status, user_id ON main.transactions
    WHEN OLD.started_at IS NOT NEW.started_at OR OLD.closed_at IS NOT NEW.closed_at
      OR OLD.created_at IS NOT NEW.created_at OR OLD.property_address IS NOT NEW.property_address
      OR OLD.property_street IS NOT NEW.property_street OR OLD.status IS NOT NEW.status
      OR OLD.user_id IS NOT NEW.user_id
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_contact_del", "contacts", sql`DROP TRIGGER IF EXISTS temp.keepr_al_contact_del`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_contact_del AFTER DELETE ON main.contacts
    BEGIN ${BUMP}; END`),
  trigger("keepr_al_user_upd", "users_local", sql`DROP TRIGGER IF EXISTS temp.keepr_al_user_upd`, sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_al_user_upd AFTER UPDATE OF email ON main.users_local
    WHEN OLD.email IS NOT NEW.email
    BEGIN ${BUMP}; END`),
];

const INSTALLED_TRIGGERS_SQL = sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_al_%'`;
const GEN_ROWS_SQL = sql`SELECT k, n FROM temp.keepr_autolink_gen`;
const DROP_GEN_SQL = sql`DROP TABLE IF EXISTS temp.keepr_autolink_gen`;
const CREATE_GEN_SQL = sql`CREATE TEMP TABLE IF NOT EXISTS keepr_autolink_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`;
const SEED_GEN_SQL = sql`INSERT OR IGNORE INTO temp.keepr_autolink_gen (k, n) VALUES ('epoch', ?), ('writes', 0)`;
const MAX_ROWIDS_SQL = sql`SELECT
    (SELECT COALESCE(MAX(rowid), 0) FROM main.messages) AS m,
    (SELECT COALESCE(MAX(rowid), 0) FROM main.emails) AS e,
    (SELECT COALESCE(MAX(rowid), 0) FROM main.email_participants) AS p`;

function triggersIntact(db: DatabaseType): boolean {
  const installed = db.prepare(INSTALLED_TRIGGERS_SQL).all() as Array<{ name: string; tbl_name: string }>;
  const byName = new Map(installed.map((t) => [t.name, t.tbl_name]));
  return TRIGGERS.every((t) => byName.get(t.name) === t.table);
}

function readGens(db: DatabaseType): { epoch: number; writes: number } | null {
  const rows = db.prepare(GEN_ROWS_SQL).all() as Array<{ k: string; n: number }>;
  const m = new Map(rows.map((r) => [r.k, r.n]));
  const epoch = m.get("epoch");
  if (epoch === undefined) return null;
  return { epoch, writes: m.get("writes") ?? 0 };
}

function install(db: DatabaseType): void {
  // Table, then triggers, in one transaction: never triggers without their counter.
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
 * one). Null when they cannot be installed (e.g. a read-only connection): callers then
 * treat every sweep as needed.
 */
export function readAutoLinkInputToken(db: DatabaseType): AutoLinkInputToken | null {
  try {
    let gens = triggersIntact(db) ? readGens(db) : null;
    if (!gens) {
      install(db);
      gens = readGens(db);
    }
    if (!gens) return null;
    const r = db.prepare(MAX_ROWIDS_SQL).get() as { m: number; e: number; p: number };
    return {
      epoch: gens.epoch,
      writes: gens.writes,
      maxMessageRowid: r.m,
      maxEmailRowid: r.e,
      maxParticipantRowid: r.p,
    };
  } catch {
    return null;
  }
}

export function sameAutoLinkInputToken(a: AutoLinkInputToken | null | undefined, b: AutoLinkInputToken | null | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.epoch === b.epoch &&
    a.writes === b.writes &&
    a.maxMessageRowid === b.maxMessageRowid &&
    a.maxEmailRowid === b.maxEmailRowid &&
    a.maxParticipantRowid === b.maxParticipantRowid
  );
}
