/**
 * BACKLOG-3892 S1 — build an iPhone sync's ChatFloorPlan (main process, at sync start).
 *
 *  - settings floor: the texts lookback (`messageImport.filters.lookbackMonths`,
 *    shared with Mac and Google Messages) through THE import-plan resolver, read
 *    exactly as the Google Messages sync reads it (settingsStartISO). An explicit
 *    "All time" resolves to no start → no floor.
 *  - deal floors: computeTransactionDateRange(deal).start − COVERAGE_TOLERANCE_MS,
 *    the export gate's start and tolerance (SR D7a/c), per handle and per linked chat.
 *
 * FAIL SAFE: any failure returns undefined (no floor at all), never a plan missing
 * its deal floors — that would cut deal chats short without a trace.
 */
import { resolveImportPlanForUser } from "./importPlanInputs";
import { settingsStartISO } from "./rcsCacheService";
import { COVERAGE_TOLERANCE_MS } from "./auditCoverageService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import {
  dealHandleRows,
  linkedIosThreadRows,
  IOS_CHAT_THREAD_PREFIX,
  type DealDates,
} from "./db/iphoneChatFloorDbService";
import { handleKeys, IPHONE_PARSE_FLOORS_ENABLED, type ChatFloorPlan } from "./iphoneChatFloors";
import logService from "./logService";

function dealFloorMs(row: DealDates): number | null {
  const ms = computeTransactionDateRange(row).start.getTime();
  return Number.isFinite(ms) ? ms - COVERAGE_TOLERANCE_MS : null;
}

function keepEarliest<K>(into: Map<K, number>, key: K, ms: number): void {
  const prev = into.get(key);
  if (prev === undefined || ms < prev) into.set(key, ms);
}

/** The plan for one user's iPhone sync, or undefined = read every chat in full. */
export async function buildChatFloorPlan(userId: string, now: Date = new Date()): Promise<ChatFloorPlan | undefined> {
  try {
    const plan = await resolveImportPlanForUser({ userId, mode: "delta" }, now);
    const startISO = settingsStartISO(plan);
    const start = startISO ? Date.parse(startISO) : NaN;
    if (!startISO) {
      return { settingsFloorMs: null, handleFloors: new Map(), linkedChatFloors: new Map() };
    }
    if (!Number.isFinite(start)) return undefined;

    const handleFloors = new Map<string, number>();
    for (const row of dealHandleRows(userId)) {
      const floor = dealFloorMs(row);
      if (floor === null) continue;
      for (const k of handleKeys(row.handle)) keepEarliest(handleFloors, k, floor);
    }
    const linkedChatFloors = new Map<number, number>();
    for (const row of linkedIosThreadRows(userId)) {
      const floor = dealFloorMs(row);
      const chatId = Number(row.threadId.slice(IOS_CHAT_THREAD_PREFIX.length));
      if (floor === null || !Number.isInteger(chatId)) continue;
      keepEarliest(linkedChatFloors, chatId, floor);
    }
    return { settingsFloorMs: start, handleFloors, linkedChatFloors };
  } catch (error) {
    void logService.warn("[BACKLOG-3892] iPhone floor plan failed; reading every chat in full", "IphoneChatFloorPlan", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** sync:start's plan: undefined while the floors are gated off (until S2). */
export async function floorPlanForSync(userId: string): Promise<ChatFloorPlan | undefined> {
  if (!IPHONE_PARSE_FLOORS_ENABLED) return undefined;
  return buildChatFloorPlan(userId);
}
