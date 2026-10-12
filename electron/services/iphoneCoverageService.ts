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
 * sync widens it (SR D2). BACKLOG-3892 W: each member is read across EVERY phone,
 * earlier phones joining only where contiguous (W3), never before a phone's own
 * oldest text (W3b, iphone_device_span), and the least covered person is named (W4).
 */
import { dbTransaction } from "./db/core/dbConnection";
import {
  iphoneChatRows,
  iphoneDeviceRows,
  iphoneDeviceSpanRows,
  iphoneHandleRows,
  iphoneStoredTextSpan,
  transactionContactMembers,
  transactionLinkedIosChats,
  upsertIphoneChat,
  upsertIphoneDevice,
  upsertIphoneDeviceSpan,
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
    // BACKLOG-3892 W3b: the oldest text this phone holds; its coverage never starts before it.
    if (typeof run.oldestTextMs === "number" && Number.isFinite(run.oldestTextMs)) {
      upsertIphoneDeviceSpan(userId, run.udid, iso(run.oldestTextMs), scannedAt);
    }
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

/**
 * A member's effective coverage on ONE phone: the earliest valid row among its keys
 * merged with the phone's interval. A row is valid only when its scan reaches the
 * phone's interval (scanned_at >= covered_since); a stale row (the person left every
 * deal and the phone's interval restarted later) counts as no row.
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

/** One deal's iPhone coverage (BACKLOG-3892 W): the device fields plus who and why. */
export interface IphoneDealCoverage extends IphoneDeviceCoverage {
  /** W4: the least covered person (contact name, else the handle), or null. */
  who: string | null;
  /** W3b: the current phone's oldest text (ISO) when it is what limits the start. */
  cappedByPhone: string | null;
  /** W3b: the user has synced another iPhone before the current one. */
  previousPhone: boolean;
}

/** One phone, as the read side sees it (BACKLOG-3892 W3/W3b). */
interface PhoneView {
  udid: string;
  sinceMs: number;
  endMs: number;
  approximate: boolean;
  /** The oldest text this phone holds (W3b), or null = unknown (no cap). */
  oldestMs: number | null;
  handleRows: Map<string, IphoneScanRow>;
  chatRows: Map<string, IphoneScanRow>;
}

/** A member's coverage across every phone, and whether the current phone's cap set it. */
interface MemberCoverage {
  sinceMs: number;
  capped: boolean;
}

/**
 * BACKLOG-3892 W3/W3b: a member's coverage across phones. On each phone: its own
 * coverage there (`sinceOn`), never earlier than that phone's oldest text. The current
 * phone's interval anchors; an older phone's interval joins only when it reaches the
 * joined start (end >= start: the D4 contiguity rule), so the months between two
 * phones are never covered by either.
 */
function acrossPhones(current: PhoneView, others: readonly PhoneView[], sinceOn: (p: PhoneView) => number): MemberCoverage {
  const capped = (p: PhoneView): { ms: number; capped: boolean } => {
    const raw = sinceOn(p);
    return p.oldestMs !== null && raw < p.oldestMs ? { ms: p.oldestMs, capped: true } : { ms: raw, capped: false };
  };
  const cur = capped(current);
  let start = cur.ms;
  const intervals = others.map((p) => ({ startMs: capped(p).ms, endMs: p.endMs }));
  let moved = true;
  while (moved) {
    moved = false;
    for (const i of intervals) {
      if (i.endMs >= start && i.startMs < start) {
        start = i.startMs;
        moved = true;
      }
    }
  }
  return { sinceMs: start, capped: cur.capped && start === cur.ms };
}

/** Every phone's view for this user; [current, others] or null when there is no phone row. */
function readPhones(userId: string): { current: PhoneView; others: PhoneView[] } | null {
  const devices = iphoneDeviceRows(userId);
  if (devices.length === 0) return null;
  const spans = new Map(iphoneDeviceSpanRows(userId).map((r) => [r.udid, Date.parse(r.oldestTextAt)]));
  const views: PhoneView[] = devices.map((d) => {
    const oldest = spans.get(d.udid);
    return {
      udid: d.udid,
      sinceMs: Date.parse(d.coveredSince),
      endMs: Date.parse(d.lastSyncAt),
      approximate: d.approximate === 1,
      oldestMs: oldest !== undefined && Number.isFinite(oldest) ? oldest : null,
      handleRows: new Map(iphoneHandleRows(userId, d.udid).map((r) => [r.key, r])),
      chatRows: new Map(iphoneChatRows(userId, d.udid).map((r) => [r.key, r])),
    };
  });
  let current = views[0];
  for (const v of views) if (v.endMs > current.endMs) current = v;
  return { current, others: views.filter((v) => v !== current && Number.isFinite(v.sinceMs) && Number.isFinite(v.endMs)) };
}

/** The user's current phone row (latest last_sync_at), raw; null = no phone row. */
export function getCurrentIphoneCoverage(userId: string): IphoneDeviceCoverage | null {
  let best: IphoneDeviceCoverageRow | null = null;
  for (const r of iphoneDeviceRows(userId)) {
    if (!best || Date.parse(r.lastSyncAt) > Date.parse(best.lastSyncAt)) best = r;
  }
  return best ? toDevice(best) : null;
}

/**
 * BACKLOG-3892 W: the user's iPhone coverage with no deal (the create dialog): the
 * current phone's interval joined with earlier phones' (W3), capped at each phone's
 * oldest text (W3b). null = no phone row (unknown, never "covered").
 */
export function getIphoneUserCoverage(userId: string): IphoneDealCoverage | null {
  const phones = readPhones(userId);
  if (!phones) return null;
  const { current, others } = phones;
  const base = { udid: current.udid, lastSyncAt: iso(current.endMs), approximate: current.approximate };
  if (!Number.isFinite(current.sinceMs)) {
    // An unreadable stored date: hand back the row's own value (as before W), never iso(NaN).
    const raw = iphoneDeviceRows(userId).find((d) => d.udid === current.udid)?.coveredSince ?? "";
    return { ...base, coveredSince: raw, who: null, cappedByPhone: null, previousPhone: others.length > 0 };
  }
  const m = acrossPhones(current, others, (p) => p.sinceMs);
  return {
    ...base,
    coveredSince: iso(m.sinceMs),
    who: null,
    cappedByPhone: m.capped && current.oldestMs !== null ? iso(current.oldestMs) : null,
    previousPhone: others.length > 0,
  };
}

/** W4: a contact's name for a warning; "Unknown" (five live writers) or empty -> the handle. */
function memberName(name: string | null, handle: string): string {
  const n = (name ?? "").trim();
  return n.length > 0 && n.toLowerCase() !== "unknown" ? n : handle;
}

/** A deal's D2 members: contact handles (with the name to show) and linked iPhone chats. */
interface DealMembers {
  handles: Array<{ keys: string[]; who: string }>;
  chats: number[];
}

function dealMembers(userId: string, transactionId: string): DealMembers {
  const handles: DealMembers["handles"] = [];
  for (const { handle, name } of transactionContactMembers(userId, transactionId)) {
    const keys = handleKeys(handle);
    if (keys.length > 0) handles.push({ keys, who: memberName(name, handle) });
  }
  return { handles, chats: transactionLinkedIosChats(userId, transactionId) };
}

/**
 * The least covered member across phones (W: a contact named before a linked chat on a
 * tie), or null when the deal has no member. A linked chat's own row counts on the
 * current phone only (SR D6).
 */
function leastDealMember(
  current: PhoneView,
  others: readonly PhoneView[],
  members: DealMembers,
): { m: MemberCoverage; who: string | null } | null {
  let least: { m: MemberCoverage; who: string | null } | null = null;
  const take = (m: MemberCoverage, who: string | null): void => {
    if (!least || m.sinceMs > least.m.sinceMs || (m.sinceMs === least.m.sinceMs && least.who === null && who !== null)) {
      least = { m, who };
    }
  };
  for (const { keys, who } of members.handles) {
    take(acrossPhones(current, others, (p) => memberSince(p.handleRows, keys, p.sinceMs)), who);
  }
  for (const chatId of members.chats) {
    take(
      acrossPhones(current, others, (p) => (p === current ? memberSince(p.chatRows, [String(chatId)], p.sinceMs) : p.sinceMs)),
      null,
    );
  }
  return least;
}

/**
 * SR D2 + BACKLOG-3892 W: one deal's iPhone coverage — its LEAST covered member over
 * the deal contacts' handles and its linked iPhone chats, each across every phone (W3)
 * and capped at each phone's oldest text (W3b). The least covered person is named (W4;
 * on a tie a contact is named before a linked chat). null = no phone row (unknown,
 * never "covered"). Throws on a read failure (callers decide).
 *
 * A linked chat is a sms.db ROWID, which a replacement phone reuses (SR D6): its own
 * row is read on the CURRENT phone only; on an earlier phone it counts as that phone's
 * interval.
 */
export function getIphoneDealCoverage(userId: string, transactionId: string): IphoneDealCoverage | null {
  const user = getIphoneUserCoverage(userId);
  const phones = readPhones(userId);
  if (!user || !phones) return null;
  const { current, others } = phones;
  if (!Number.isFinite(current.sinceMs)) return user;
  const found = leastDealMember(current, others, dealMembers(userId, transactionId));
  if (!found) return user;
  return {
    ...user,
    coveredSince: iso(found.m.sinceMs),
    who: found.who,
    cappedByPhone: found.m.capped && current.oldestMs !== null ? iso(current.oldestMs) : null,
  };
}

// ---------------------------------------------------------------------------
// BACKLOG-3892 S5 — the backfill ("Get older texts" from a kept backup)
// ---------------------------------------------------------------------------

/**
 * One phone whose kept backup could fill a deal's start gap: what to read and what the
 * deal's iPhone coverage would start at after it.
 */
export interface IphoneBackfillTarget {
  udid: string;
  /** The phone with the latest last sync (the only one whose linked-chat ROWIDs are read). */
  isCurrent: boolean;
  /** Read from (inclusive): the deal floor, never before this phone's oldest text. */
  floorMs: number;
  /** Read to (exclusive): the latest coverage start on this phone over the deal's members. */
  ceilingMs: number;
  /** The phone's oldest text (W3b) moved the floor up from the deal floor. */
  cappedByPhone: boolean;
  /** This phone's last sync (ISO): the new rows' scanned_at, and a guard on the write. */
  lastSyncAt: string;
  /** Every deal handle key and (current phone) linked chat the rows are written for. */
  handleKeys: string[];
  chatIds: number[];
  /** The deal's iPhone covered-since after this backfill (projected with the same rows the write uses). */
  coveredSinceAfterMs: number;
}

export interface IphoneBackfillPlan {
  /** The deal's iPhone covered-since now; null = no phone row (unknown). */
  coveredSinceMs: number | null;
  /** The current phone, when reading its kept backup would move it earlier (else empty). */
  targets: IphoneBackfillTarget[];
}

/** The row a backfill writes for one member key: what the read side and the write share. */
function backfillRow(prior: IphoneScanRow | undefined, floorMs: number, scannedAt: string): IphoneScanRow {
  return { key: prior?.key ?? "", coveredSince: iso(mergeScan(prior, floorMs)), scannedAt };
}

/**
 * The backfill plan for one deal. `dealFloorMs` = the deal's audit start − 24 h (the S1
 * deal floor). Read-only. A phone is a target only when reading [floor, ceiling) from its
 * backup moves the deal's coverage earlier under the W rules (contiguity, the cap).
 */
export function planIphoneBackfill(userId: string, transactionId: string, dealFloorMs: number): IphoneBackfillPlan {
  const phones = readPhones(userId);
  if (!phones || !Number.isFinite(phones.current.sinceMs)) return { coveredSinceMs: null, targets: [] };
  const members = dealMembers(userId, transactionId);
  const now = leastDealMember(phones.current, phones.others, members);
  const coveredSinceMs = now ? now.m.sinceMs : phones.current.sinceMs;
  if (!now) return { coveredSinceMs, targets: [] };
  // 2.41: the CURRENT phone only. Stored texts are keyed `ios-chat-<ROWID>` and ROWIDs
  // are per phone, so an older phone's chat would share a thread id with an unrelated
  // current-phone chat (coordinator 1183f4d2; older-phone backfill is a follow-up).
  // Texts before the current phone's oldest are "on your previous iPhone or its backup".
  const all = [phones.current];
  const keys = [...new Set(members.handles.flatMap((h) => h.keys))];
  const targets: IphoneBackfillTarget[] = [];
  for (const p of all) {
    const isCurrent = p === phones.current;
    const chatIds = isCurrent ? members.chats : [];
    let ceilingMs = -Infinity;
    for (const h of members.handles) ceilingMs = Math.max(ceilingMs, memberSince(p.handleRows, h.keys, p.sinceMs));
    for (const c of chatIds) ceilingMs = Math.max(ceilingMs, memberSince(p.chatRows, [String(c)], p.sinceMs));
    if (!Number.isFinite(ceilingMs)) continue;
    const floorMs = p.oldestMs !== null ? Math.max(dealFloorMs, p.oldestMs) : dealFloorMs;
    if (floorMs >= ceilingMs) continue;
    // Project with exactly the rows recordIphoneBackfillCoverage would write.
    const scannedAt = iso(p.endMs);
    const handleRows = new Map(p.handleRows);
    for (const k of keys) handleRows.set(k, { ...backfillRow(p.handleRows.get(k), floorMs, scannedAt), key: k });
    const chatRows = new Map(p.chatRows);
    for (const c of chatIds) chatRows.set(String(c), { ...backfillRow(p.chatRows.get(String(c)), floorMs, scannedAt), key: String(c) });
    const projected: PhoneView = { ...p, handleRows, chatRows };
    const cur = isCurrent ? projected : phones.current;
    const others = phones.others.map((o) => (o === p ? projected : o));
    const after = leastDealMember(cur, others, members);
    if (!after || after.m.sinceMs >= coveredSinceMs) continue;
    targets.push({
      udid: p.udid,
      isCurrent,
      floorMs,
      ceilingMs,
      cappedByPhone: floorMs > dealFloorMs,
      lastSyncAt: scannedAt,
      handleKeys: keys,
      chatIds,
      coveredSinceAfterMs: after.m.sinceMs,
    });
  }
  return { coveredSinceMs, targets };
}

/** Why a backfill recorded no coverage (counts only, logged by the caller). */
export type IphoneBackfillCoverageSkip = "no-device-row" | "phone-synced-since" | null;

/**
 * Record a finished backfill — ONE transaction, only after its texts are stored with no
 * failed read. Lowers the deal members' rows on the source phone to `floorMs`, stamped
 * with that phone's EXISTING last sync: the device row (covered_since, last_sync_at) is
 * never written, so the end check (W1) and the phone's interval are unchanged. The
 * phone's oldest text is written only when none is recorded. A phone synced since the
 * plan was made records nothing (the plan's ceiling no longer describes it).
 */
export function recordIphoneBackfillCoverage(
  userId: string,
  target: Pick<IphoneBackfillTarget, "udid" | "floorMs" | "lastSyncAt" | "handleKeys" | "chatIds">,
  oldestTextMs: number | null,
): IphoneBackfillCoverageSkip {
  let skip: IphoneBackfillCoverageSkip = null;
  dbTransaction(() => {
    const own = iphoneDeviceRows(userId).find((r) => r.udid === target.udid);
    if (!own) {
      skip = "no-device-row";
      return;
    }
    if (Date.parse(own.lastSyncAt) !== Date.parse(target.lastSyncAt)) {
      skip = "phone-synced-since";
      return;
    }
    const scannedAt = target.lastSyncAt;
    const priorHandles = new Map(iphoneHandleRows(userId, target.udid).map((r) => [r.key, r]));
    for (const key of target.handleKeys) {
      upsertIphoneHandle(userId, target.udid, key, backfillRow(priorHandles.get(key), target.floorMs, scannedAt).coveredSince, scannedAt);
    }
    const priorChats = new Map(iphoneChatRows(userId, target.udid).map((r) => [r.key, r]));
    for (const chatId of target.chatIds) {
      upsertIphoneChat(userId, target.udid, chatId, backfillRow(priorChats.get(String(chatId)), target.floorMs, scannedAt).coveredSince, scannedAt);
    }
    if (typeof oldestTextMs === "number" && Number.isFinite(oldestTextMs)) {
      const hasSpan = iphoneDeviceSpanRows(userId).some((r) => r.udid === target.udid);
      if (!hasSpan) upsertIphoneDeviceSpan(userId, target.udid, iso(oldestTextMs), scannedAt);
    }
  });
  return skip;
}
