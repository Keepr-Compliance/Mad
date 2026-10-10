/**
 * BACKLOG-3837 follow-up: the per-source text floors (MESSAGES_FLOOR_BY_SOURCE_SQL),
 * read ONLY on a dedicated worker, cached per user against the messages-write token,
 * one read per user at a time. The policy is documented on getSourceCoverageAsync in
 * auditCoverageService.ts.
 *
 * No Electron import (and no import of auditCoverageService): autoLinkService loads
 * this to warm the cache at every sync / import end, and autoLinkService must load
 * without Electron (coreLoadsWithoutElectron.test.ts).
 */
import { ensureDb } from "./db/core/dbConnection";
import logService from "./logService";
import { queryOnDedicatedWorker } from "../workers/contactWorkerPool";
import { readSourceCoverageInputToken, sourceCoverageTokenKey } from "./db/sourceCoverageInputTracker";
import type { SourceFloorRow } from "./db/wizardMessageScansDb";

export const SOURCE_FLOORS_WAIT_MS = 4_000;
export const SOURCE_FLOORS_WORKER_TIMEOUT_MS = 10 * 60_000;
let sourceFloorsWaitMs = SOURCE_FLOORS_WAIT_MS;

/** How long a coverage check waits for the floors before reporting "pending". */
export function getSourceFloorsWaitMs(): number {
  return sourceFloorsWaitMs;
}

const floorsCache = new Map<string, { key: string; rows: SourceFloorRow[] }>();
const floorsInFlight = new Map<string, Promise<SourceFloorRow[] | null>>();

/** Test-only: the wait budget, and a clean cache between cases. */
export function setSourceFloorsWaitMsForTests(ms: number | null): void {
  sourceFloorsWaitMs = ms ?? SOURCE_FLOORS_WAIT_MS;
}
export function resetSourceFloorsCacheForTests(): void {
  floorsCache.clear();
  floorsInFlight.clear();
}

function currentFloorsKey(): string | null {
  try {
    const token = readSourceCoverageInputToken(ensureDb());
    return token ? sourceCoverageTokenKey(token) : null;
  } catch {
    return null;
  }
}

/** The floors for the current messages state: cached, the running read, or a new one. */
export function readSourceFloors(userId: string): Promise<SourceFloorRow[] | null> {
  const key = currentFloorsKey();
  const hit = floorsCache.get(userId);
  if (key && hit && hit.key === key) return Promise.resolve(hit.rows);
  const running = floorsInFlight.get(userId);
  if (running) return running;
  const startedAt = Date.now();
  const promise = (async (): Promise<SourceFloorRow[] | null> => {
    try {
      const rows = (await queryOnDedicatedWorker(
        "sourceCoverageFloors",
        userId,
        SOURCE_FLOORS_WORKER_TIMEOUT_MS,
      )) as SourceFloorRow[];
      logService.info(`[BACKLOG-3837] source coverage floors read on a dedicated worker in ${Date.now() - startedAt}ms`, "AuditCoverage");
      if (key) floorsCache.set(userId, { key, rows });
      return rows;
    } catch (error) {
      logService.warn("[BACKLOG-3837] source floors read on a dedicated worker failed; coverage reported as pending (nothing read on main)", "AuditCoverage", {
        code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "failed",
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - startedAt,
      });
      return null;
    } finally {
      floorsInFlight.delete(userId);
    }
  })();
  floorsInFlight.set(userId, promise);
  return promise;
}

/**
 * BACKLOG-3837: a sync or import just ended — start the floors read for this user now
 * (dedicated worker, fire-and-forget, shared with any read already running), so the
 * first Continue after a sync finds the cache warm instead of "pending". Never reads
 * on main, never throws.
 */
export function warmSourceCoverage(userId: string): void {
  try {
    void readSourceFloors(userId).catch(() => undefined);
  } catch {
    // best effort
  }
}
