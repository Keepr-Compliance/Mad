/**
 * BACKLOG-3892 S2 — iPhone text coverage: how far back each phone, and each deal's
 * people on it, were actually read.
 *
 * Once an iPhone sync reads only the texts lookback (S1), the oldest stored iPhone
 * text says nothing about how far back the phone was read. These rows do, and they
 * are the ONLY source of the iPhone "covered since" (SR D1: never MIN(sent_at)).
 *
 * WRITE (persistence, at its commit point; SR D4/D5/D6, C2):
 *  - nothing for a run with any failed sms.db read, or without a coverage context;
 *  - from the floors the run APPLIED (SyncResult.coverageRun), never re-resolved;
 *  - the phone's interval [covered_since, last_sync_at]: a run reading [F, T]
 *    merges with the prior interval only when last_sync_at >= F, else restarts at F.
 *    No plan or "All time" = the whole sms.db was read = covered since 1970;
 *  - per handle / per chat read below F: "read back to X by the run at T" rows;
 *  - an upgrader (no phone row at all) is seeded from its stored iPhone texts read
 *    BEFORE this run's inserts, marked approximate.
 *
 * READ: the current phone = the latest last_sync_at. A deal's iPhone coverage is
 * its least covered member (contact handle or linked chat); a member with no valid
 * row counts as the phone's interval (the settings floor), so its gap shows until a
 * sync widens it (SR D2).
 */
import { dbTransaction } from "./db/core/dbConnection";
import {
  iphoneChatRows,
  iphoneDeviceRows,
  iphoneHandleRows,
  iphoneStoredTextSpan,
  transactionContactHandles,
  transactionLinkedIosChats,
  upsertIphoneChat,
  upsertIphoneDevice,
  upsertIphoneHandle,
  type IphoneDeviceCoverageRow,
  type IphoneScanRow,
} from "./db/iphoneCoverageDbService";
import { handleKeys } from "./iphoneChatFloors";
import type { SyncResult } from "./deviceSyncOrchestrator";

/** "Everything the phone holds" — a run that read every chat in full. */
export const IPHONE_ALL_TIME_MS = 0;

export interface CoverageInterval {
  coveredSinceMs: number;
  lastSyncMs: number;
  approximate: boolean;
}

/** One phone's interval for this user, or null. */
export interface IphoneDeviceCoverage {
  udid: string;
  coveredSince: string;
  lastSyncAt: string;
  approximate: boolean;
}

/**
 * SR D4 — the contiguity rule. A run read [runFloorMs, runEndMs]; it extends the
 * prior interval only when the prior one reaches at least to runFloorMs.
 */
export function mergeRunInterval(prior: CoverageInterval | null, runFloorMs: number, runEndMs: number): CoverageInterval {
  if (prior && prior.lastSyncMs >= runFloorMs) {
    const fromPrior = prior.coveredSinceMs < runFloorMs;
    return {
      coveredSinceMs: fromPrior ? prior.coveredSinceMs : runFloorMs,
      lastSyncMs: runEndMs,
      approximate: fromPrior && prior.approximate,
    };
  }
  return { coveredSinceMs: runFloorMs, lastSyncMs: runEndMs, approximate: false };
}

/** A member row's merge: prior [h0, s0] extends a fresh [f, T] only when s0 >= f. */
function mergeScan(prior: IphoneScanRow | undefined, floorMs: number): number {
  if (!prior) return floorMs;
  const h0 = Date.parse(prior.coveredSince);
  const s0 = Date.parse(prior.scannedAt);
  if (Number.isFinite(h0) && Number.isFinite(s0) && s0 >= floorMs) return Math.min(h0, floorMs);
  return floorMs;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * SR D4: the one-time upgrader seed — read it BEFORE the run's inserts. Only when
 * the user has no phone row at all (texts stored by earlier, full-read syncs); a
 * user with a row for any phone is never seeded (it could be another phone's texts).
 */
export function readIphoneCoverageSeed(userId: string): CoverageInterval | null {
  if (iphoneDeviceRows(userId).length > 0) return null;
  const span = iphoneStoredTextSpan(userId);
  if (!span || !span.n || !span.floor || !span.last) return null;
  const since = Date.parse(span.floor);
  const last = Date.parse(span.last);
  if (!Number.isFinite(since) || !Number.isFinite(last)) return null;
  return { coveredSinceMs: since, lastSyncMs: last, approximate: true };
}

/** Why a run recorded no coverage (logged by the caller; counts only). */
export type IphoneCoverageSkip = "no-run-context" | "read-failures" | null;

/**
 * Record one run's coverage — ONE transaction. The caller invokes it only at the
 * persistence commit point (every cancel/failure branch has already returned).
 * `seed` is readIphoneCoverageSeed() taken before the inserts.
 */
export function recordIphoneSyncCoverage(
  userId: string,
  result: Pick<SyncResult, "coverageRun" | "chatReadFailures">,
  seed: CoverageInterval | null,
): IphoneCoverageSkip {
  const run = result.coverageRun;
  if (!run || !run.udid || !Number.isFinite(run.startedAtMs)) return "no-run-context";
  // SR D5: a failed read looks like an empty chat. Unknown (undefined) is not zero.
  if (result.chatReadFailures !== 0) return "read-failures";

  const plan = run.floorPlan;
  const runFloorMs = plan && plan.settingsFloorMs !== null ? plan.settingsFloorMs : IPHONE_ALL_TIME_MS;
  const runEndMs = run.startedAtMs;
  const scannedAt = iso(runEndMs);

  dbTransaction(() => {
    const own = iphoneDeviceRows(userId).find((r) => r.udid === run.udid);
    const prior: CoverageInterval | null = own
      ? { coveredSinceMs: Date.parse(own.coveredSince), lastSyncMs: Date.parse(own.lastSyncAt), approximate: own.approximate === 1 }
      : seed;
    const merged = mergeRunInterval(prior, runFloorMs, runEndMs);
    upsertIphoneDevice(userId, {
      udid: run.udid,
      coveredSince: iso(merged.coveredSinceMs),
      lastSyncAt: iso(merged.lastSyncMs),
      approximate: merged.approximate ? 1 : 0,
    });
    if (runFloorMs === IPHONE_ALL_TIME_MS || !plan) return;

    // Per handle: every deal handle the plan read below the settings floor (C2: the
    // applied plan), written even when the handle has no chat on this phone.
    const priorHandles = new Map(iphoneHandleRows(userId, run.udid).map((r) => [r.key, r]));
    for (const [key, floorMs] of plan.handleFloors) {
      if (floorMs >= runFloorMs) continue;
      upsertIphoneHandle(userId, run.udid, key, iso(mergeScan(priorHandles.get(key), floorMs)), scannedAt);
    }
    // Per chat: the floor each chat was ACTUALLY read to (C2), skipped chats included.
    const priorChats = new Map(iphoneChatRows(userId, run.udid).map((r) => [r.key, r]));
    for (const [chatId, applied] of run.chatFloors) {
      if (applied === null || applied >= runFloorMs) continue;
      upsertIphoneChat(userId, run.udid, chatId, iso(mergeScan(priorChats.get(String(chatId)), applied)), scannedAt);
    }
  });
  return null;
}

function toDevice(r: IphoneDeviceCoverageRow): IphoneDeviceCoverage {
  return { udid: r.udid, coveredSince: r.coveredSince, lastSyncAt: r.lastSyncAt, approximate: r.approximate === 1 };
}

/** The user's current phone (latest last_sync_at), or null = iPhone coverage unknown. */
export function getCurrentIphoneCoverage(userId: string): IphoneDeviceCoverage | null {
  let best: IphoneDeviceCoverageRow | null = null;
  for (const r of iphoneDeviceRows(userId)) {
    if (!best || Date.parse(r.lastSyncAt) > Date.parse(best.lastSyncAt)) best = r;
  }
  return best ? toDevice(best) : null;
}

/**
 * A member's effective coverage: the earliest valid row among its keys merged with
 * the phone's interval. A row is valid only when its scan reaches the phone's
 * interval (scanned_at >= covered_since); a stale row (the person left every deal
 * and the phone's interval restarted later) counts as no row.
 */
function memberSince(rows: Map<string, IphoneScanRow>, keys: readonly string[], deviceSinceMs: number): number {
  let best: number | null = null;
  for (const k of keys) {
    const r = rows.get(k);
    if (!r) continue;
    const h = Date.parse(r.coveredSince);
    const s = Date.parse(r.scannedAt);
    if (!Number.isFinite(h) || !Number.isFinite(s) || s < deviceSinceMs) continue;
    if (best === null || h < best) best = h;
  }
  return best === null ? deviceSinceMs : Math.min(best, deviceSinceMs);
}

/**
 * SR D2: one deal's iPhone coverage on the current phone — its LEAST covered member
 * over the deal contacts' handles and its linked iPhone chats. null = no phone row
 * (unknown, never "covered"). Throws on a read failure (callers decide).
 */
export function getIphoneDealCoverage(userId: string, transactionId: string): IphoneDeviceCoverage | null {
  const device = getCurrentIphoneCoverage(userId);
  if (!device) return null;
  const deviceSinceMs = Date.parse(device.coveredSince);
  if (!Number.isFinite(deviceSinceMs)) return { ...device };
  const handleRows = new Map(iphoneHandleRows(userId, device.udid).map((r) => [r.key, r]));
  const chatRows = new Map(iphoneChatRows(userId, device.udid).map((r) => [r.key, r]));
  let least: number | null = null;
  const take = (ms: number): void => {
    if (least === null || ms > least) least = ms;
  };
  for (const handle of transactionContactHandles(userId, transactionId)) {
    const keys = handleKeys(handle);
    if (keys.length > 0) take(memberSince(handleRows, keys, deviceSinceMs));
  }
  for (const chatId of transactionLinkedIosChats(userId, transactionId)) {
    take(memberSince(chatRows, [String(chatId)], deviceSinceMs));
  }
  return least === null ? { ...device } : { ...device, coveredSince: iso(least) };
}
