// ============================================
// AUDIT COVERAGE SERVICE (BACKLOG-2292)
//
// Read-side detection for the audit-window completeness guarantee ("an audit can
// never be silently incomplete"). Answers two questions from the LOCAL DB only
// (no device scan, no provider call):
//   - getAuditCoverage(userId, proposedStartISO): does a proposed audit start
//     predate the imported messages floor and/or the cached email floor? (drives
//     the Layer-1 date-selection popup)
//   - checkExportCompleteness(transactionId, userId): is this transaction's
//     messages coverage complete for its saved audit window? (drives the Layer-3
//     export gate)
//
// FLOOR-OF-RECORD (SR-correction b): the messages floor is ALWAYS MIN(sent_at)
// over non-reaction sms/imessage rows — ground truth, backed by
// idx_messages_user_sent. message_import_state is used ONLY for staleness
// (last_import_at vs last_expansion_at), never as a coverage watermark.
//
// All floors are returned as ISO strings and compared by epoch-ms via
// isBeforeFloor (SR-correction f) — never Date-vs-string coercion.
// ============================================

import os from "os";
import * as Sentry from "@sentry/electron/main";
import { dbGet, dbAll, dbRun, ensureDb } from "./db/core/dbConnection";
import {
  EMAIL_SYNC_FLOOR_SQL,
  MESSAGES_FLOOR_SQL,
  TRANSACTION_WINDOW_SQL,
  MESSAGES_FLOOR_BY_SOURCE_SQL,
  SOURCE_COVERAGE_ROWS_SQL,
  SOURCE_COVERAGE_UPSERT_SQL,
  SOURCE_COVERAGE_DELETE_SQL,
} from "./db/auditCoverageSql";
import { isExpansionStale, getDeepestImportStart } from "./db/messageImportStateService";
import { getRcsCacheRun } from "./db/rcsCacheRunsDbService";
import { getChatCoverage, linkedChatHashes } from "./db/rcsChatCoverageDbService";
import permissionService from "./permissionService";
import logService from "./logService";
import { queryOnDedicatedWorker } from "../workers/contactWorkerPool";
import { readSourceCoverageInputToken, sourceCoverageTokenKey } from "./db/sourceCoverageInputTracker";
import type { SourceFloorRow } from "./db/wizardMessageScansDb";
import { computeTransactionDateRange } from "../utils/emailDateRange";
// BACKLOG-2562: the ONE definition of "is this deal live?" (see the call site).
import { isLiveTransactionStatus } from "./transactionEligibility";
import {
  isBeforeFloor,
  type AuditCoverageResult,
  type ExportCompletenessResult,
  type SourceCoverage,
  type SourceCoverageGap,
  type TextCoverageResult,
  type TextSource,
} from "../types/auditCoverage";

// ============================================
// BACKLOG-3663: per-source text coverage
// ============================================

const TEXT_SOURCES: readonly TextSource[] = ["iphone", "mac", "android_companion", "google_messages"];
/** A source "covers" an audit start when its floor is no more than this after it. */
export const COVERAGE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * How far back each text source reaches, for one user. Never throws (→ []).
 *  - Google Messages: message_source_coverage (written by the cache commit,
 *    only when a run read down to its floor) — exact; null = never complete.
 *  - Mac: message_import_state.deepest_import_start (exact), else the oldest
 *    Mac text (approximate).
 *  - iPhone / Android companion: a recorded coverage row when their importer
 *    writes one (follow-up), else the oldest text (approximate).
 */
export function getSourceCoverage(userId: string): SourceCoverage[] {
  try {
    return buildSourceCoverage(userId, dbAll<SourceFloorRow>(MESSAGES_FLOOR_BY_SOURCE_SQL, [userId]));
  } catch (error) {
    logService.warn("[BACKLOG-3663] getSourceCoverage failed (non-fatal)", "AuditCoverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * BACKLOG-3837 follow-up — the per-source floors (MESSAGES_FLOOR_BY_SOURCE_SQL:
 * json_extract over EVERY text row of the user; 1.9 s at 668k messages warm, ~70 s
 * cold on the PC) are read ONLY on a dedicated worker, never on the main thread.
 *
 * On the PC the read went to the SHARED contact worker with a 30 s timeout; every call
 * timed out and fell back to the same scan on main, blocking it for 104 s after a sync.
 * Now:
 *  - the read runs on a worker of its own (cannot queue behind the shared worker), with
 *    a long timeout — nothing on main waits for it;
 *  - a caller waits at most SOURCE_FLOORS_WAIT_MS, then gets `null` ("pending"), and the
 *    read carries on and fills the cache;
 *  - one read per user at a time (concurrent callers share it);
 *  - the answer is cached against a token of the messages writes
 *    (db/sourceCoverageInputTracker.ts) captured at the START of the read, so a write
 *    made while it runs makes the next call read again.
 * No path reads the floors on main: a worker that cannot start, fails, or times out
 * leaves the answer unknown (`null`), never "covered".
 */
export const SOURCE_FLOORS_WAIT_MS = 4_000;
export const SOURCE_FLOORS_WORKER_TIMEOUT_MS = 10 * 60_000;
let sourceFloorsWaitMs = SOURCE_FLOORS_WAIT_MS;

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
function readSourceFloors(userId: string): Promise<SourceFloorRow[] | null> {
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

const PENDING = Symbol("pending");

/**
 * `getSourceCoverage` without the main-thread scan. `null` = not known yet (the read
 * is still running, or failed): callers report "pending", never "covered". Never throws.
 */
export async function getSourceCoverageAsync(userId: string): Promise<SourceCoverage[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), sourceFloorsWaitMs);
    timer.unref?.();
  });
  const rows = await Promise.race([readSourceFloors(userId), budget]);
  clearTimeout(timer);
  if (rows === PENDING) {
    logService.info(`[BACKLOG-3837] source coverage floors not ready within ${sourceFloorsWaitMs}ms; reported as pending`, "AuditCoverage");
    return null;
  }
  if (rows === null) return null;
  try {
    return buildSourceCoverage(userId, rows);
  } catch (error) {
    logService.warn("[BACKLOG-3663] getSourceCoverage failed (non-fatal)", "AuditCoverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildSourceCoverage(userId: string, floorRows: readonly SourceFloorRow[]): SourceCoverage[] {
  const floors = new Map<string, { floor: string | null; n: number }>();
  for (const r of floorRows) {
    floors.set(r.source, { floor: r.floor, n: r.n });
  }
  const recorded = new Map<string, { coveredSince: string | null; lastSyncAt: string | null }>();
  for (const r of dbAll<{ source: string; coveredSince: string | null; lastSyncAt: string | null }>(SOURCE_COVERAGE_ROWS_SQL, [userId])) {
    recorded.set(r.source, { coveredSince: r.coveredSince, lastSyncAt: r.lastSyncAt });
  }
  const deepestMac = getDeepestImportStart(userId);
  const out: SourceCoverage[] = [];
  for (const source of TEXT_SOURCES) {
    const f = floors.get(source);
    const rec = recorded.get(source);
    const hasRows = !!f && f.n > 0;
    if (!hasRows && !rec && !(source === "mac" && deepestMac)) continue;
    let coveredSince: string | null;
    let approximate: boolean;
    let incompleteChats: number | undefined;
    if (source === "google_messages") {
      coveredSince = rec?.coveredSince ?? null;
      approximate = false;
      // L2: the gap is not hidden — the last full run's not-settled chats.
      const run = getRcsCacheRun(userId);
      incompleteChats = run && run.reachedFloor ? run.notSettledChats : 0;
    } else if (source === "mac") {
      coveredSince = deepestMac ?? rec?.coveredSince ?? f?.floor ?? null;
      approximate = !deepestMac && !rec?.coveredSince;
    } else {
      coveredSince = rec?.coveredSince ?? f?.floor ?? null;
      approximate = !rec?.coveredSince;
    }
    out.push({ source, coveredSince, lastSyncAt: rec?.lastSyncAt ?? null, approximate, hasRows, ...(incompleteChats ? { incompleteChats } : {}) });
  }
  return out;
}

/**
 * SR (2026-10-02): one transaction's text coverage. For Google Messages, the
 * per-thread coverage of the chats LINKED to this transaction is preferred:
 * a deal chat may be read further back than the months setting. Each linked
 * chat counts as far back as the earlier of its own row and the source row;
 * the transaction is covered as far as its LEAST covered linked chat. No
 * linked chat (or a read failure) falls back to the source row, which can
 * only over-warn. Never throws.
 */
export function getTransactionSourceCoverage(userId: string, transactionId: string): SourceCoverage[] {
  return withLinkedChatCoverage(getSourceCoverage(userId), userId, transactionId);
}

/** BACKLOG-3837: `getTransactionSourceCoverage` off main; `null` = pending. Never throws. */
export async function getTransactionSourceCoverageAsync(userId: string, transactionId: string): Promise<SourceCoverage[] | null> {
  const coverage = await getSourceCoverageAsync(userId);
  return coverage ? withLinkedChatCoverage(coverage, userId, transactionId) : null;
}

function withLinkedChatCoverage(coverage: SourceCoverage[], userId: string, transactionId: string): SourceCoverage[] {
  try {
    const gm = coverage.find((c) => c.source === "google_messages");
    if (!gm) return coverage;
    const hashes = linkedChatHashes(transactionId, userId);
    if (hashes.length === 0) return coverage;
    const own = getChatCoverage(userId, hashes);
    const source = gm.coveredSince ? Date.parse(gm.coveredSince) : NaN;
    let least: number | null = null;
    for (const h of hashes) {
      const row = own.get(h);
      const mine = row ? Date.parse(row) : NaN;
      const eff = Number.isFinite(mine) && Number.isFinite(source) ? Math.min(mine, source)
        : Number.isFinite(mine) ? mine
          : source;
      if (!Number.isFinite(eff)) return coverage; // one linked chat not covered at all: the source row says it
      if (least === null || eff > least) least = eff;
    }
    if (least === null) return coverage;
    const coveredSince = new Date(least).toISOString();
    return coverage.map((c) => (c === gm ? { ...c, coveredSince } : c));
  } catch (error) {
    logService.warn("[SR 2026-10-02] per-thread coverage failed (source coverage used)", "AuditCoverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return coverage;
  }
}

/**
 * Which sources do not reach back to the audit start — only the CHOSEN source
 * and sources the user has texts from (SR). A source with no full read yet is
 * "never"; one whose floor is more than a day after the start is "later".
 */
export function sourceCoverageGaps(
  coverage: readonly SourceCoverage[],
  auditStartISO: string | null,
  chosen: TextSource | null,
): SourceCoverageGap[] {
  if (!auditStartISO) return [];
  const start = Date.parse(auditStartISO);
  if (!Number.isFinite(start)) return [];
  const bySource = new Map(coverage.map((c) => [c.source, c]));
  const relevant = new Set<TextSource>(coverage.filter((c) => c.hasRows).map((c) => c.source));
  if (chosen) relevant.add(chosen);
  const gaps: SourceCoverageGap[] = [];
  for (const source of TEXT_SOURCES) {
    if (!relevant.has(source)) continue;
    const c = bySource.get(source);
    if (!c || !c.coveredSince) {
      gaps.push({ source, coveredSince: null, approximate: c?.approximate ?? false, kind: "never" });
      continue;
    }
    const since = Date.parse(c.coveredSince);
    if (Number.isFinite(since) && since - start > COVERAGE_TOLERANCE_MS) {
      gaps.push({ source, coveredSince: c.coveredSince, approximate: c.approximate, kind: "later" });
    } else if ((c.incompleteChats ?? 0) > 0) {
      gaps.push({ source, coveredSince: c.coveredSince, approximate: c.approximate, kind: "incomplete", incompleteChats: c.incompleteChats });
    }
  }
  return gaps;
}

/** Record a source's coverage (inside the caller's transaction when there is one). */
export function recordSourceCoverage(userId: string, source: TextSource, coveredSinceISO: string | null, lastSyncISO: string): void {
  dbRun(SOURCE_COVERAGE_UPSERT_SQL, [userId, source, coveredSinceISO, lastSyncISO]);
}

/** Force re-import of a source: its coverage is gone too. */
export function forgetSourceCoverage(userId: string, source: TextSource): void {
  dbRun(SOURCE_COVERAGE_DELETE_SQL, [userId, source]);
}

/** BACKLOG-3663: the Texts tab's coverage for one transaction. Never throws. */
export function getTransactionTextCoverage(
  transactionId: string,
  userId: string,
  chosen: TextSource | null,
): TextCoverageResult {
  try {
    const txn = dbGet<{ started_at: string | null; created_at: string | null; closed_at: string | null; status: string | null }>(
      TRANSACTION_WINDOW_SQL,
      [transactionId, userId],
    );
    if (!txn || !isLiveTransactionStatus(txn.status)) return { success: true, auditStartISO: null, gaps: [] };
    const auditStartISO = computeTransactionDateRange(txn).start.toISOString();
    return { success: true, auditStartISO, gaps: sourceCoverageGaps(getTransactionSourceCoverage(userId, transactionId), auditStartISO, chosen) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, auditStartISO: null, gaps: [], error: message };
  }
}

/**
 * The messages floor-of-record: MIN(sent_at) over the user's non-reaction
 * sms/imessage rows. Null when no texts are imported. Mirrors the message half
 * of getEarliestCommunicationDate (reaction-excluded, duplicate-excluded) but
 * GLOBAL (not per-contact). Index-backed by idx_messages_user_sent.
 *
 * NEVER throws — this is called on the error path of the messages trigger
 * (runEnsure's catch) and from a fire-and-forget background trigger, where a
 * DB-not-ready read must degrade to "no floor" (null ⇒ no gap) rather than
 * surface a second throw and crash the caller.
 */
export function getMessagesFloorISO(userId: string): string | null {
  try {
    const row = dbGet<{ floor: string | null }>(
      MESSAGES_FLOOR_SQL,
      [userId],
    );
    return row?.floor ?? null;
  } catch (error) {
    logService.warn("[BACKLOG-2292] getMessagesFloorISO read failed (degrading to null)", "AuditCoverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface EmailFloorInfo {
  /** MAX(oldest_cached_at) across active accounts when ALL are bounded; else null. */
  floorISO: string | null;
  /** An active account has no lower bound ⇒ coverage cannot be proven ⇒ gap. */
  hasUnboundedActive: boolean;
  activeAccountCount: number;
}

/**
 * The email cache floor across ACTIVE email accounts.
 *
 * SR-correction (c): a SQL MAX(oldest_cached_at) silently DROPS NULLs, so an
 * active account that has never established a lower bound would falsely report
 * "covered". Mirror planFetchWindows (bounded < accounts ⇒ uncovered): if ANY
 * active account is unbounded, there is a gap and floorISO is null. Only when
 * EVERY active account is lower-bounded is MAX(oldest_cached_at) a valid floor.
 */
export function getEmailFloor(userId: string): EmailFloorInfo {
  const rows = dbAll<{ oldest_cached_at: string | null }>(
    EMAIL_SYNC_FLOOR_SQL,
    [userId],
  );
  if (rows.length === 0) {
    return { floorISO: null, hasUnboundedActive: false, activeAccountCount: 0 };
  }
  const hasUnboundedActive = rows.some((r) => !r.oldest_cached_at);
  if (hasUnboundedActive) {
    return { floorISO: null, hasUnboundedActive: true, activeAccountCount: rows.length };
  }
  let maxOldest: string | null = null;
  for (const r of rows) {
    if (
      r.oldest_cached_at &&
      (!maxOldest ||
        new Date(r.oldest_cached_at).getTime() > new Date(maxOldest).getTime())
    ) {
      maxOldest = r.oldest_cached_at;
    }
  }
  return { floorISO: maxOldest, hasUnboundedActive: false, activeAccountCount: rows.length };
}

/**
 * Whether a targeted messages import can actually run on this device: macOS with
 * Full Disk Access. Non-macOS / no-FDA installs degrade gracefully — the popup
 * and export gate still surface the gap, but the "Update now" import is a no-op
 * (the export gate then offers "Export anyway").
 */
export async function isMessagesImporterAvailable(): Promise<boolean> {
  if (os.platform() !== "darwin") return false;
  try {
    const check = await permissionService.checkFullDiskAccess();
    return check.hasPermission === true;
  } catch {
    return false;
  }
}

/**
 * Coverage for a PROPOSED audit start (date-selection time). Never throws — on
 * error returns a safe "no gap" result so the create/edit flow is never blocked
 * by a detection failure (the export gate remains the backstop).
 */
export async function getAuditCoverage(
  userId: string,
  proposedStartISO: string,
): Promise<AuditCoverageResult> {
  try {
    const messagesFloorISO = getMessagesFloorISO(userId);
    const email = getEmailFloor(userId);
    const messagesImporterAvailable = await isMessagesImporterAvailable();
    // BACKLOG-3837: the per-source floors are read on a dedicated worker only; null = pending.
    const sourceCoverage = await getSourceCoverageAsync(userId);

    const needsMessagesImport = isBeforeFloor(proposedStartISO, messagesFloorISO);
    const needsEmailBackfill =
      email.hasUnboundedActive || isBeforeFloor(proposedStartISO, email.floorISO);

    return {
      success: true,
      messagesFloorISO,
      emailFloorISO: email.floorISO,
      needsMessagesImport,
      needsEmailBackfill,
      expansionStale: isExpansionStale(userId),
      messagesImporterAvailable,
      // Unknown is never reported as "no gaps": pending, and no sourceGaps at all.
      ...(sourceCoverage
        ? { sourceGaps: sourceCoverageGaps(sourceCoverage, proposedStartISO, null) }
        : { sourceCoveragePending: true }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.warn("[BACKLOG-2292] getAuditCoverage failed (non-fatal)", "AuditCoverage", {
      error: message,
    });
    Sentry.captureException(error, {
      tags: { component: "audit_coverage", operation: "getAuditCoverage" },
      level: "warning",
    });
    return {
      success: false,
      messagesFloorISO: null,
      emailFloorISO: null,
      needsMessagesImport: false,
      needsEmailBackfill: false,
      expansionStale: false,
      messagesImporterAvailable: false,
      error: message,
    };
  }
}

/**
 * Export completeness backstop (Layer 3). A transaction's messages coverage is
 * complete when the messages floor reaches back to (or before) its audit start
 * AND expansion is not stale. A null floor (no texts imported at all) is treated
 * as complete — a targeted import only WIDENS an existing floor; initial import
 * is a separate concern (Settings). Never throws.
 */
export async function checkExportCompleteness(
  transactionId: string,
  userId: string,
): Promise<ExportCompletenessResult> {
  try {
    const txn = dbGet<{
      started_at: string | null;
      created_at: string | null;
      closed_at: string | null;
      status: string | null;
    }>(
      TRANSACTION_WINDOW_SQL,
      [transactionId, userId],
    );

    const messagesFloorISO = getMessagesFloorISO(userId);
    const expansionStale = isExpansionStale(userId);
    const messagesImporterAvailable = await isMessagesImporterAvailable();

    // BACKLOG-2308: a rejected transaction is a dead deal with NO audit-completeness
    // obligation. The import floor (readNonRejectedTransactions) EXCLUDES
    // rejected, so the sync would never widen the floor to cover it — demanding
    // coverage here would be a permanent false-incomplete the sync can never
    // heal. Treat as complete (no gap).
    //
    // BACKLOG-2562: "keep this rule in lock-step with the floor sites by hand"
    // is what this comment used to say, and by hand is exactly how
    // autoLinkService drifted. The rule now has ONE definition in
    // `transactionEligibility`. Note that `isLiveTransactionStatus` treats a
    // NULL status as LIVE, which is what `status === "rejected"` did here —
    // the swap is behaviour-neutral, including for NULL.
    if (!isLiveTransactionStatus(txn?.status)) {
      return {
        success: true,
        complete: true,
        messagesFloorISO,
        auditStartISO: null,
        needsMessagesImport: false,
        expansionStale,
        messagesImporterAvailable,
      };
    }

    const auditStartISO = txn
      ? computeTransactionDateRange(txn).start.toISOString()
      : null;

    // Raw gap: the audit start predates the imported floor (floor non-null).
    const needsMessagesImport = isBeforeFloor(auditStartISO, messagesFloorISO);

    // SR D2: complete when expansion is current AND either (a) the floor already
    // reaches the audit start, OR (b) a targeted import has scanned the device
    // back to (or before) THIS audit start. Requirement (b) is proven by
    // deepest_import_start <= auditStart — NOT a global "an import once ran"
    // boolean, which would falsely latch complete if a prior SHALLOW import
    // succeeded and the start was later moved earlier while the widening import
    // could no longer run (e.g. Full Disk Access lost after an OS update). A
    // floor still above the audit start with a deep-enough scan means no older
    // texts exist on the device (complete); with a shallow scan it means we have
    // NOT looked that far back yet (incomplete). Compared by epoch-ms via
    // isBeforeFloor with an explicit non-null guard (SR-correction f).
    const deepestImportStartISO = getDeepestImportStart(userId);
    const importReachesAuditStart =
      deepestImportStartISO !== null &&
      auditStartISO !== null &&
      !isBeforeFloor(auditStartISO, deepestImportStartISO); // auditStart >= deepest
    const complete =
      !expansionStale && (!needsMessagesImport || importReachesAuditStart);
    const txSourceCoverage = await getTransactionSourceCoverageAsync(userId, transactionId);

    return {
      success: true,
      complete,
      messagesFloorISO,
      auditStartISO,
      needsMessagesImport,
      expansionStale,
      messagesImporterAvailable,
      // BACKLOG-3663: informational only — never changes `complete`.
      // BACKLOG-3837: read off main; unknown is pending, never "no gaps".
      ...(txSourceCoverage
        ? { sourceGaps: sourceCoverageGaps(txSourceCoverage, auditStartISO, null) }
        : { sourceCoveragePending: true }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.warn(
      "[BACKLOG-2292] checkExportCompleteness failed (non-fatal)",
      "AuditCoverage",
      { error: message },
    );
    Sentry.captureException(error, {
      tags: { component: "audit_coverage", operation: "checkExportCompleteness" },
      level: "warning",
    });
    // Fail OPEN for export (never block an export on a detection failure — the
    // main-side awaited ensureTransactionMessagesSynced backstop still runs).
    return {
      success: false,
      complete: true,
      messagesFloorISO: null,
      auditStartISO: null,
      needsMessagesImport: false,
      expansionStale: false,
      messagesImporterAvailable: false,
      error: message,
    };
  }
}
