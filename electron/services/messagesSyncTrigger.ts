// ============================================
// TRANSACTION MESSAGES AUTO-SYNC TRIGGER (BACKLOG-2292)
//
// The MESSAGES twin of transactionSyncTrigger (email). "A user shouldn't have to
// click Sync … they won't know they have to and could export an incomplete
// audit." (founder). A single entry point — ensureTransactionMessagesSynced —
// that every lifecycle event routes through so a user's audit-window text set is
// imported + expanded AUTOMATICALLY, never on a button click:
//   - CREATE      : new audited transaction → cover its window.
//   - DATE-CHANGE : audit dates moved earlier → import older texts + expand.
//   - EXPORT      : awaited completeness backstop before an audit artifact.
//   - OPEN / SCAN : top-up (throttled).
//
// ARCHITECTURE (SR-correction a — the biggest): the macOS Messages import is
// GLOBAL / USER-SCOPED, not per-transaction / per-account. There is NO
// planFetchWindows / per-account bound here. The required lower bound is
//   proposedStartISO ?? computeEarliestAuditStart(all non-archived txns)
// and when it predates the MIN(sent_at) floor AND the importer is available we
// run ONE global re-import via macOSMessagesImportService.importMessages(...,
// { auditPeriodStart }) — reusing the BACKLOG-2276 auditPeriodStart filter (NO
// importer change). expandAttachedThreadsForUser ALWAYS runs after. Degrades
// gracefully on non-macOS / no-FDA (skip import, still expand, floor unchanged;
// the export gate still warns).
//
// The 50K cap keeps OLDEST / drops NEWEST and is OFF when auditPeriodActive
// (SR-correction d) — so the MIN(sent_at) floor is authoritative and the cap
// never "eats the oldest". The global import is a full device scan → callers run
// it in the BACKGROUND with the inline progress indicator, never synchronously
// blocking the update IPC (SR-correction d).
// ============================================

import * as Sentry from "@sentry/electron/main";
import macOSMessagesImportService from "./macOSMessagesImportService";
import type { ImportProgressCallback } from "./macOSMessagesImportService";
import {
  expandAttachedThreadsForUser,
  autoLinkNewMessagesForUser,
} from "./autoLinkService";
import { computeEarliestAuditStart } from "../utils/emailDateRange";
import { getMessagesFloorISO, isMessagesImporterAvailable } from "./auditCoverageService";
import { recordImport, recordExpansionRun } from "./db/messageImportStateService";
import { dbAll } from "./db/core/dbConnection";
import logService from "./logService";

export type MessagesSyncReason = "create" | "open" | "export" | "date-change" | "scan";

export interface EnsureMessagesResult {
  /** Whether any work (import and/or expansion) ran. */
  ran: boolean;
  reason: MessagesSyncReason;
  /** Messages imported by the targeted import (0 when none ran). */
  imported: number;
  importRan: boolean;
  expansionRan: boolean;
  /** MIN(sent_at) floor AFTER the attempt — observe-by-requery (BACKLOG-1875). */
  messagesFloorISO: string | null;
  skipped?:
    | "throttled"
    | "covered"
    | "no_importer"
    | "no_required_start"
    | "import_failed";
  error?: string;
}

/**
 * Per-USER freshness throttle. The import is user-global, so the key is the
 * userId (not a transactionId). In-memory — a restart clears it, which just
 * means the next lifecycle event re-checks (harmless, and for completeness
 * desirable).
 */
const lastSyncAt = new Map<string, number>();

/**
 * Per-USER in-flight registry. Concurrent ensure() calls for the same user
 * coalesce onto ONE device scan — but ONLY when the in-flight scan reaches at
 * least as far back as the caller needs (SR D1). Each entry carries the epoch-ms
 * lower bound its scan targets so a DEEPER caller is never handed back a
 * shallower scan (which would then falsely re-derive completeness).
 */
interface InflightEntry {
  promise: Promise<EnsureMessagesResult>;
  /** requiredStart epoch-ms this scan reaches back to; null = no lower bound. */
  requiredStartMs: number | null;
}
const inflightByUser = new Map<string, InflightEntry>();

/** Reasons that must reflect the very latest state and so bypass the throttle. */
const BYPASS_THROTTLE: ReadonlySet<MessagesSyncReason> = new Set([
  "export",
  "date-change",
]);

/** Freshness window for the throttled reasons (create/open/scan). */
const MESSAGES_SYNC_FRESHNESS_MS = 5 * 60 * 1000;

/** True while a global messages sync is in progress for the user. */
export function isMessagesSyncInFlight(userId: string): boolean {
  return inflightByUser.has(userId);
}

/** Non-archived transaction date fields for computeEarliestAuditStart. */
function getNonArchivedTxnDates(userId: string): Array<{
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
}> {
  return dbAll<{
    started_at: string | null;
    created_at: string | null;
    closed_at: string | null;
  }>(
    `SELECT started_at, created_at, closed_at
       FROM transactions
      WHERE user_id = ? AND status != 'archived'`,
    [userId],
  );
}

/**
 * Resolve the required lower bound: an explicit proposed start (create /
 * date-selection / export) else the earliest audit start across all non-archived
 * transactions. Computed BEFORE the coalesce decision (SR D1) so the registry can
 * compare depths.
 */
function resolveRequiredStart(userId: string, proposedStartISO?: string | null): Date | null {
  if (proposedStartISO) {
    const d = new Date(proposedStartISO);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return computeEarliestAuditStart(getNonArchivedTxnDates(userId));
}

/**
 * Depth-aware coalescing gate: reuse an in-flight scan ONLY when its window is a
 * SUPERSET of the caller's (reaches at least as far back — earlier = deeper).
 * Otherwise the caller must run its own (deeper) scan. Widen-to-min: never hand
 * back a shallower scan (SR D1).
 */
function inflightCoversRequirement(existingMs: number | null, callerMs: number | null): boolean {
  if (callerMs === null) return true; // caller has no lower bound → anything suffices
  if (existingMs === null) return false; // in-flight has no deep target → not a superset
  return existingMs <= callerMs; // in-flight reaches at least as far back as the caller needs
}

/**
 * Ensure the user's audit-window texts are imported + expanded. Never throws —
 * auto-sync must not break the create/date-change/export UX. Concurrent same-user
 * calls coalesce onto a single in-flight import.
 */
export function ensureTransactionMessagesSynced(params: {
  transactionId?: string;
  userId: string;
  reason: MessagesSyncReason;
  proposedStartISO?: string | null;
  onProgress?: ImportProgressCallback;
}): Promise<EnsureMessagesResult> {
  const { userId, reason } = params;

  // The synchronous prologue below reads the DB (resolveRequiredStart /
  // getMessagesFloorISO). Those can throw BEFORE the DB is ready. The trigger
  // must be non-fatal AND never throw synchronously (callers invoke it both
  // awaited and fire-and-forget), so wrap the whole prologue and degrade to a
  // resolved error result.
  try {
    // 1. Resolve the required scan depth BEFORE the coalesce decision (SR D1) so
    //    a deeper caller is never handed back a shallower in-flight scan.
    const requiredStart = resolveRequiredStart(userId, params.proposedStartISO);
    const requiredStartMs = requiredStart ? requiredStart.getTime() : null;

    // 2. Coalesce onto the in-flight scan ONLY when it reaches at least as far
    //    back as this caller needs (no await between this read and the set below,
    //    so no interleave is possible).
    const existing = inflightByUser.get(userId);
    if (existing && inflightCoversRequirement(existing.requiredStartMs, requiredStartMs)) {
      return existing.promise;
    }

    // 3. Freshness throttle — only when there is NO in-flight scan to chain after
    //    (a deeper-than-in-flight caller must not be throttled away), and not a
    //    bypass reason (date-change/export).
    if (!existing && !BYPASS_THROTTLE.has(reason)) {
      const last = lastSyncAt.get(userId);
      if (last && Date.now() - last < MESSAGES_SYNC_FRESHNESS_MS) {
        return Promise.resolve({
          ran: false,
          reason,
          imported: 0,
          importRan: false,
          expansionRan: false,
          messagesFloorISO: getMessagesFloorISO(userId),
          skipped: "throttled",
        });
      }
    }

    // 4. Start the run. If a NARROWER scan is in flight, CHAIN after it (the macOS
    //    importer serializes to one import at a time anyway) so this deeper window
    //    is honored instead of rejected with "already in progress".
    const prior = existing?.promise;
    const run = (): Promise<EnsureMessagesResult> =>
      runEnsure({ ...params, requiredStart });
    const chained = prior ? prior.then(run, run) : run();
    const entry: InflightEntry = { promise: chained, requiredStartMs };
    inflightByUser.set(userId, entry);
    // Clear the registry only if WE are still the current entry (a deeper caller
    // may have replaced us while we were queued). The trailing .catch(() => {})
    // is REQUIRED: .finally() re-propagates a rejection, so without it this
    // cleanup branch would surface as an UNHANDLED rejection (the caller handles
    // the returned `chained` promise separately). runEnsure never rejects today,
    // but this keeps the bookkeeping branch crash-proof regardless.
    void chained
      .finally(() => {
        if (inflightByUser.get(userId) === entry) {
          inflightByUser.delete(userId);
        }
        lastSyncAt.set(userId, Date.now());
      })
      .catch(() => {
        /* cleanup-only branch; the result/rejection is owned by the caller */
      });
    return chained;
  } catch (error) {
    // Non-fatal: a DB-not-ready read in the prologue must never break the
    // create/date-change/export UX nor surface as a synchronous throw.
    const message = error instanceof Error ? error.message : String(error);
    logService.warn(
      "[BACKLOG-2292] messages sync prologue failed (non-fatal)",
      "MessagesSyncTrigger",
      { reason, error: message },
    );
    return Promise.resolve({
      ran: false,
      reason,
      imported: 0,
      importRan: false,
      expansionRan: false,
      messagesFloorISO: null,
      error: message,
    });
  }
}

async function runEnsure(params: {
  transactionId?: string;
  userId: string;
  reason: MessagesSyncReason;
  proposedStartISO?: string | null;
  onProgress?: ImportProgressCallback;
  /** Pre-resolved lower bound (SR D1) — computed by the caller for coalescing. */
  requiredStart: Date | null;
}): Promise<EnsureMessagesResult> {
  const { userId, reason, onProgress, requiredStart } = params;
  let importRan = false;
  let expansionRan = false;
  let imported = 0;

  try {
    const floorBefore = getMessagesFloorISO(userId);
    const importerAvailable = await isMessagesImporterAvailable();

    // Gap = the required start predates the imported floor. When floor is null
    // (nothing imported) there is nothing to WIDEN — initial import is a
    // separate concern (Settings); we still run expansion below.
    const gap =
      requiredStart !== null &&
      floorBefore !== null &&
      requiredStart.getTime() < new Date(floorBefore).getTime();

    // Targeted GLOBAL import (SR-correction a). auditPeriodStart turns the 50K
    // cap OFF and reaches the import lower bound back to requiredStart.
    if (gap && importerAvailable) {
      const result = await macOSMessagesImportService.importMessages(
        userId,
        onProgress,
        false,
        { auditPeriodStart: (requiredStart as Date).toISOString() },
      );
      if (result.success) {
        importRan = true;
        imported = result.messagesImported;
        // Record how far back this import actually scanned (SR D2) so the export
        // gate can require deepest_import_start <= the audit start.
        recordImport(userId, (requiredStart as Date).toISOString());
        // Link brand-new older threads too (mirrors the Settings import handler);
        // expansion below then heals already-attached threads' older siblings.
        if (result.messagesImported > 0) {
          try {
            await autoLinkNewMessagesForUser(userId);
          } catch (linkError) {
            logService.warn(
              "[BACKLOG-2292] post-import auto-link failed (non-fatal)",
              "MessagesSyncTrigger",
              { error: linkError instanceof Error ? linkError.message : "Unknown" },
            );
          }
        }
      } else {
        // Non-macOS / no-FDA / already-in-progress → degrade; do NOT record import.
        logService.info(
          "[BACKLOG-2292] targeted messages import did not run",
          "MessagesSyncTrigger",
          { reason, error: result.error },
        );
      }
    }

    // ALWAYS run expansion (SR-correction a). Record expansion ONLY on observed
    // success (SR-correction g) so a silent expansion failure keeps the export
    // gate honest instead of latching "done" and never re-prompting.
    try {
      await expandAttachedThreadsForUser(userId);
      expansionRan = true;
      recordExpansionRun(userId);
    } catch (expandError) {
      logService.warn(
        "[BACKLOG-2292] attached-thread expansion failed (non-fatal)",
        "MessagesSyncTrigger",
        { error: expandError instanceof Error ? expandError.message : "Unknown" },
      );
      Sentry.captureException(expandError, {
        tags: { component: "messages_sync", operation: "expandAttachedThreads", reason },
        level: "warning",
      });
    }

    const floorAfter = getMessagesFloorISO(userId);
    const ran = importRan || expansionRan;
    let skipped: EnsureMessagesResult["skipped"];
    if (requiredStart === null) skipped = "no_required_start";
    else if (!gap) skipped = "covered";
    else if (!importerAvailable) skipped = "no_importer";
    else if (!importRan) skipped = "import_failed";

    logService.info("[BACKLOG-2292] messages sync completed", "MessagesSyncTrigger", {
      reason,
      importRan,
      imported,
      expansionRan,
      floorBefore,
      floorAfter,
    });

    return {
      ran,
      reason,
      imported,
      importRan,
      expansionRan,
      messagesFloorISO: floorAfter,
      skipped,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.warn(
      "[BACKLOG-2292] messages sync trigger failed (non-fatal)",
      "MessagesSyncTrigger",
      { reason, error: message },
    );
    Sentry.captureException(error, {
      tags: { component: "messages_sync", operation: "ensureTransactionMessagesSynced", reason },
      level: "warning",
    });
    return {
      ran: importRan || expansionRan,
      reason,
      imported,
      importRan,
      expansionRan,
      messagesFloorISO: getMessagesFloorISO(userId),
      error: message,
    };
  }
}

/**
 * Fire-and-forget wrapper for the background triggers (create / date-change).
 * Never rejects. onComplete fires for every caller (coalesced callers share the
 * same result). Callers (IPC handlers) use onProgress/onComplete to push the
 * `messages:import-progress` and `transactions:messages-sync-complete` events so
 * the renderer shows inline progress and silently refreshes the text list.
 */
export function triggerMessagesSyncInBackground(params: {
  transactionId?: string;
  userId: string;
  reason: MessagesSyncReason;
  proposedStartISO?: string | null;
  onProgress?: ImportProgressCallback;
  onComplete?: (result: EnsureMessagesResult) => void;
}): void {
  const { onComplete, ...syncParams } = params;
  void ensureTransactionMessagesSynced(syncParams)
    .then((result) => {
      onComplete?.(result);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown";
      logService.warn(
        "[BACKLOG-2292] background messages sync rejected",
        "MessagesSyncTrigger",
        { error: message },
      );
      onComplete?.({
        ran: false,
        reason: syncParams.reason,
        imported: 0,
        importRan: false,
        expansionRan: false,
        messagesFloorISO: null,
        error: message,
      });
    });
}

/** Test seam: reset the in-memory throttle + inflight registry between cases. */
export function __resetMessagesSyncStateForTests(): void {
  lastSyncAt.clear();
  inflightByUser.clear();
}
