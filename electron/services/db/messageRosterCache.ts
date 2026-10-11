/**
 * BACKLOG-3837 follow-up: the Attach Messages roster (messageRosterDb.ts — every unlinked
 * text of the user, grouped by contact, plus the group names) runs ONLY on a dedicated
 * worker, cached per user, one read per user at a time (dedicatedReadCache.ts).
 *
 * It ran on main every time Attach Messages opened: 2.7 s at 668k messages on a Mac.
 *
 * The cache is keyed on a token of every write the roster depends on:
 *  - messages: insert (MAX(rowid)), row removal, and an UPDATE of a column the roster
 *    reads — transaction_id above all (attaching or removing texts moves them in or out
 *    of the roster), plus direction, participants, thread_id, channel, user_id, sent_at,
 *    associated_message_type;
 *  - message_thread_names: any insert, update or removal (the group names it joins).
 */
import { sql } from "./core/sqlText";
import type { MessagesInputTrackerSpec } from "./messagesInputTracker";
import { createDedicatedReadCache } from "./dedicatedReadCache";
import type { MessageContactRow } from "./messageRosterDb";

/** How long get-message-contacts waits for the roster before answering "pending". */
export const MESSAGE_ROSTER_WAIT_MS = 3_000;
export const MESSAGE_ROSTER_WORKER_TIMEOUT_MS = 10 * 60_000;

const BUMP = sql`UPDATE temp.keepr_roster_gen SET n = n + 1 WHERE k = 'writes'`;

const MESSAGE_ROSTER_TRACKER: MessagesInputTrackerSpec = {
  triggers: [
    {
      name: "keepr_roster_msg_del",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_roster_msg_del`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_roster_msg_del AFTER DELETE ON main.messages
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_roster_msg_upd",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_roster_msg_upd`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_roster_msg_upd
    AFTER UPDATE OF transaction_id, direction, participants, thread_id, channel, user_id, sent_at, associated_message_type ON main.messages
    WHEN OLD.transaction_id IS NOT NEW.transaction_id OR OLD.direction IS NOT NEW.direction
      OR OLD.participants IS NOT NEW.participants OR OLD.thread_id IS NOT NEW.thread_id
      OR OLD.channel IS NOT NEW.channel OR OLD.user_id IS NOT NEW.user_id
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.associated_message_type IS NOT NEW.associated_message_type
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_roster_tn_ins",
      table: "message_thread_names",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_roster_tn_ins`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_roster_tn_ins AFTER INSERT ON main.message_thread_names
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_roster_tn_upd",
      table: "message_thread_names",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_roster_tn_upd`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_roster_tn_upd AFTER UPDATE ON main.message_thread_names
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_roster_tn_del",
      table: "message_thread_names",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_roster_tn_del`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_roster_tn_del AFTER DELETE ON main.message_thread_names
    BEGIN ${BUMP}; END`,
    },
  ],
  installedTriggersSql: sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_roster_%'`,
  genRowsSql: sql`SELECT k, n FROM temp.keepr_roster_gen`,
  dropGenSql: sql`DROP TABLE IF EXISTS temp.keepr_roster_gen`,
  createGenSql: sql`CREATE TEMP TABLE IF NOT EXISTS keepr_roster_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  seedGenSql: sql`INSERT OR IGNORE INTO temp.keepr_roster_gen (k, n) VALUES ('epoch', ?), ('writes', 0)`,
};

const store = createDedicatedReadCache<MessageContactRow>({
  queryType: "messageRoster",
  tracker: MESSAGE_ROSTER_TRACKER,
  waitMs: MESSAGE_ROSTER_WAIT_MS,
  workerTimeoutMs: MESSAGE_ROSTER_WORKER_TIMEOUT_MS,
  label: "Attach Messages roster",
  logArea: "TransactionService",
});

/** The roster if ready within the wait budget, else `null` (pending). Never reads on main. */
export function readMessageRosterWithinBudget(userId: string): Promise<MessageContactRow[] | null> {
  return store.readWithinBudget(userId);
}
/** The roster read already running for this user, or null. Never starts one. */
export function joinMessageRosterRead(userId: string): Promise<MessageContactRow[] | null> | null {
  return store.join(userId);
}
/** A sync or import just ended: start the roster read now (dedicated worker). Never throws. */
export function warmMessageRoster(userId: string): void {
  store.warm(userId);
}
export function setMessageRosterWaitMsForTests(ms: number | null): void {
  store.setWaitMsForTests(ms);
}
export function resetMessageRosterCacheForTests(): void {
  store.resetForTests();
}
