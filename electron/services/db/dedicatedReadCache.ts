/**
 * BACKLOG-3837: one heavy per-user read that runs ONLY on a dedicated worker — never on
 * the main thread, never on the shared contact worker — cached per user against a token
 * of the writes it depends on, one read per user at a time.
 *
 * Shared by messageDerivedContactsCache.ts (the contact lists' people found in messages)
 * and messageRosterCache.ts (the Attach Messages roster). Rules, for both:
 *  - the token is captured at the START of the read, so a write made while it runs makes
 *    the next call read again;
 *  - a failure of any kind yields `null` ("pending") — never a main-thread read;
 *  - a caller that cannot wait uses `readWithinBudget`, which answers `null` after the
 *    budget while the read carries on and fills the cache.
 *
 * No Electron import: autoLinkService loads the users of this to warm them at every sync /
 * import end, and autoLinkService must load without Electron (coreLoadsWithoutElectron.test.ts).
 */
import { ensureDb } from "./core/dbConnection";
import logService from "../logService";
import { queryOnDedicatedWorker } from "../../workers/contactWorkerPool";
import { messagesTokenKey, readMessagesInputToken, type MessagesInputTrackerSpec } from "./messagesInputTracker";

export interface DedicatedReadCache<Row> {
  /** Cached, the running read, or a new dedicated read. `null` = the read failed. */
  read(userId: string): Promise<Row[] | null>;
  /** The rows if ready within the wait budget, else `null` (pending). Never throws. */
  readWithinBudget(userId: string): Promise<Row[] | null>;
  /** The read already running for this user, or null. Never starts one. */
  join(userId: string): Promise<Row[] | null> | null;
  /** Start the read now (fire-and-forget). Never throws. */
  warm(userId: string): void;
  setWaitMsForTests(ms: number | null): void;
  resetForTests(): void;
}

export interface DedicatedReadCacheOptions {
  /** The worker query type (contactQueryWorker.ts). */
  queryType: "messageDerived" | "messageRoster";
  tracker: MessagesInputTrackerSpec;
  waitMs: number;
  workerTimeoutMs: number;
  /** For log lines: what is being read. */
  label: string;
  logArea: string;
}

const PENDING = Symbol("pending");

export function createDedicatedReadCache<Row>(opts: DedicatedReadCacheOptions): DedicatedReadCache<Row> {
  let waitMs = opts.waitMs;
  const cache = new Map<string, { key: string; rows: Row[] }>();
  const inFlight = new Map<string, Promise<Row[] | null>>();

  function currentKey(): string | null {
    try {
      const token = readMessagesInputToken(ensureDb(), opts.tracker);
      return token ? messagesTokenKey(token) : null;
    } catch {
      return null;
    }
  }

  function read(userId: string): Promise<Row[] | null> {
    const key = currentKey();
    const hit = cache.get(userId);
    if (key && hit && hit.key === key) return Promise.resolve(hit.rows);
    const running = inFlight.get(userId);
    if (running) return running;
    const startedAt = Date.now();
    const promise = (async (): Promise<Row[] | null> => {
      try {
        const rows = (await queryOnDedicatedWorker(opts.queryType, userId, opts.workerTimeoutMs)) as Row[];
        void logService.info(`[BACKLOG-3837] ${opts.label} read on a dedicated worker in ${Date.now() - startedAt}ms`, opts.logArea);
        if (key) cache.set(userId, { key, rows });
        return rows;
      } catch (error) {
        void logService.warn(`[BACKLOG-3837] ${opts.label} read on a dedicated worker failed; reported as pending (nothing read on main)`, opts.logArea, {
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

  async function readWithinBudget(userId: string): Promise<Row[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<typeof PENDING>((resolve) => {
      timer = setTimeout(() => resolve(PENDING), waitMs);
      timer.unref?.();
    });
    try {
      const rows = await Promise.race([read(userId), budget]);
      if (rows === PENDING) {
        void logService.info(`[BACKLOG-3837] ${opts.label} not ready within ${waitMs}ms; answered without it (pending)`, opts.logArea);
        return null;
      }
      return rows;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    read,
    readWithinBudget,
    join: (userId) => inFlight.get(userId) ?? null,
    warm: (userId) => {
      try {
        void read(userId).catch(() => undefined);
      } catch {
        // best effort
      }
    },
    setWaitMsForTests: (ms) => {
      waitMs = ms ?? opts.waitMs;
    },
    resetForTests: () => {
      cache.clear();
      inFlight.clear();
    },
  };
}
