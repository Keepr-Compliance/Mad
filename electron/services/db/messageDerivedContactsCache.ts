/**
 * BACKLOG-3837 follow-up: the message-derived contact read (MESSAGE_DERIVED_CONTACTS_SQL,
 * json_extract over EVERY message of the user) runs ONLY on a dedicated worker — never on
 * the main thread, never on the shared contact worker.
 *
 * On the PC (668k messages) it ran on the SHARED worker with a 30 s timeout; right after a
 * sync that worker was busy, the read timed out, and the same scan ran on MAIN for ~25 s
 * while the new-transaction wizard's contact picker waited. Now (the sourceCoverageFloors.ts
 * pattern, #2931):
 *  - the read runs on a worker of its own, with a long timeout — nothing on main waits for it;
 *  - one read per user at a time (concurrent callers share it);
 *  - the RAW rows are cached per user against a token of the messages writes that can change
 *    them (MESSAGE_DERIVED_TRACKER below), captured at the START of the read, so a write made
 *    while it runs makes the next call read again;
 *  - a failure of any kind yields `null` ("pending") — never a main-thread read.
 * The saved-name filter is NOT cached: callers apply it on main at every call (an indexed
 * contacts read), so a contacts write changes the answer immediately.
 *
 * No Electron import: autoLinkService loads this to warm the cache at every sync / import
 * end, and autoLinkService must load without Electron (coreLoadsWithoutElectron.test.ts).
 */
import { ensureDb } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import logService from "../logService";
import { queryOnDedicatedWorker } from "../../workers/contactWorkerPool";
import { messagesTokenKey, readMessagesInputToken, type MessagesInputTrackerSpec } from "./messagesInputTracker";
import type { MessageDerivedContactRow } from "./wizardMessageScansDb";

/** How long a contact list waits for the read before answering without it ("pending"). */
export const MESSAGE_DERIVED_WAIT_MS = 3_000;
export const MESSAGE_DERIVED_WORKER_TIMEOUT_MS = 10 * 60_000;
let waitMs = MESSAGE_DERIVED_WAIT_MS;

const BUMP = sql`UPDATE temp.keepr_msgder_gen SET n = n + 1 WHERE k = 'writes'`;

/** The columns MESSAGE_DERIVED_CONTACTS_SQL reads (besides the key): participants, user_id, sent_at, associated_message_type. */
const MESSAGE_DERIVED_TRACKER: MessagesInputTrackerSpec = {
  triggers: [
    {
      name: "keepr_msgder_msg_del",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_msgder_msg_del`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_msgder_msg_del AFTER DELETE ON main.messages
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_msgder_msg_upd",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_msgder_msg_upd`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_msgder_msg_upd
    AFTER UPDATE OF participants, user_id, sent_at, associated_message_type ON main.messages
    WHEN OLD.participants IS NOT NEW.participants OR OLD.user_id IS NOT NEW.user_id
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.associated_message_type IS NOT NEW.associated_message_type
    BEGIN ${BUMP}; END`,
    },
  ],
  installedTriggersSql: sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_msgder_%'`,
  genRowsSql: sql`SELECT k, n FROM temp.keepr_msgder_gen`,
  dropGenSql: sql`DROP TABLE IF EXISTS temp.keepr_msgder_gen`,
  createGenSql: sql`CREATE TEMP TABLE IF NOT EXISTS keepr_msgder_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  seedGenSql: sql`INSERT OR IGNORE INTO temp.keepr_msgder_gen (k, n) VALUES ('epoch', ?), ('writes', 0)`,
};

const cache = new Map<string, { key: string; rows: MessageDerivedContactRow[] }>();
const inFlight = new Map<string, Promise<MessageDerivedContactRow[] | null>>();

/** Test-only: the wait budget, and a clean cache between cases. */
export function setMessageDerivedWaitMsForTests(ms: number | null): void {
  waitMs = ms ?? MESSAGE_DERIVED_WAIT_MS;
}
export function resetMessageDerivedCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

function currentKey(): string | null {
  try {
    const token = readMessagesInputToken(ensureDb(), MESSAGE_DERIVED_TRACKER);
    return token ? messagesTokenKey(token) : null;
  } catch {
    return null;
  }
}

/**
 * The raw message-derived rows for the current messages state: cached, the running read,
 * or a new dedicated read. `null` = the read failed (nothing was read on main).
 */
export function readMessageDerivedRows(userId: string): Promise<MessageDerivedContactRow[] | null> {
  const key = currentKey();
  const hit = cache.get(userId);
  if (key && hit && hit.key === key) return Promise.resolve(hit.rows);
  const running = inFlight.get(userId);
  if (running) return running;
  const startedAt = Date.now();
  const promise = (async (): Promise<MessageDerivedContactRow[] | null> => {
    try {
      const rows = (await queryOnDedicatedWorker(
        "messageDerived",
        userId,
        MESSAGE_DERIVED_WORKER_TIMEOUT_MS,
      )) as MessageDerivedContactRow[];
      void logService.info(`[BACKLOG-3837] message-derived contacts read on a dedicated worker in ${Date.now() - startedAt}ms`, "ContactDbService");
      if (key) cache.set(userId, { key, rows });
      return rows;
    } catch (error) {
      void logService.warn("[BACKLOG-3837] message-derived read on a dedicated worker failed; reported as pending (nothing read on main)", "ContactDbService", {
        code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "failed",
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - startedAt,
      });
      return null;
    } finally {
      inFlight.delete(userId);
    }
  })();
  inFlight.set(userId, promise);
  return promise;
}

/**
 * The read already running for this user, or null. Joins it; never starts one (a list
 * that answered "pending" after a FAILED read must not spawn a second worker just to be
 * told when it lands — the renderer's own backstop re-read retries a failed read).
 */
export function joinMessageDerivedRead(userId: string): Promise<MessageDerivedContactRow[] | null> | null {
  return inFlight.get(userId) ?? null;
}

const PENDING = Symbol("pending");

/**
 * The rows if they are ready within the wait budget, else `null` (pending: still running,
 * or failed). The read carries on and fills the cache. Never throws, never reads on main.
 */
export async function readMessageDerivedRowsWithinBudget(userId: string): Promise<MessageDerivedContactRow[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), waitMs);
    timer.unref?.();
  });
  try {
    const rows = await Promise.race([readMessageDerivedRows(userId), budget]);
    if (rows === PENDING) {
      void logService.info(`[BACKLOG-3837] message-derived contacts not ready within ${waitMs}ms; list returned without them (pending)`, "ContactDbService");
      return null;
    }
    return rows;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BACKLOG-3837: a sync or import just ended — start the read for this user now (dedicated
 * worker, fire-and-forget, shared with any read already running), so the first picker open
 * after a sync finds the cache warm. Never reads on main, never throws.
 */
export function warmMessageDerivedContacts(userId: string): void {
  try {
    void readMessageDerivedRows(userId).catch(() => undefined);
  } catch {
    // best effort
  }
}
