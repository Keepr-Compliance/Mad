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
//   proposedStartISO ?? computeEarliestAuditStart(all non-rejected txns)
// and when it predates the MIN(sent_at) floor AND the importer is available we
// run ONE global import. expandAttachedThreadsForUser ALWAYS runs after.
// Degrades gracefully on non-macOS / no-FDA (skip import, still expand, floor
// unchanged; the export gate still warns).
//
// BACKLOG-2772 — WHAT CHANGED HERE, because the paragraph this replaces was
// still being read as live:
//
// This module used to call importMessages() with a hand-built
// `{ auditPeriodStart }` and nothing else, and the old service rule was "any
// non-rejected transaction switches the 50K cap OFF". Both are gone.
//
//   - The run is planned by `resolveImportPlanForUser`, the SAME resolver the
//     Settings buttons and the estimate use, so this path now carries the
//     user's lookback, cap and attachment preference instead of ignoring them.
//   - The cap is no longer switched off wholesale. Under Cap' it does not apply
//     INSIDE the audit periods of non-rejected deals — which is what keeps the
//     MIN(sent_at) floor authoritative and the cap from "eating the oldest" —
//     and it does apply to everything outside them.
//   - The run announces itself (see messagesBackgroundImportSignal) so the
//     renderer can mirror it into the sync queue. Before that it had no queue
//     item and therefore no Cancel button at all.
//
// The global import is a full device scan → callers run it in the BACKGROUND
// with the inline progress indicator, never synchronously blocking the update
// IPC (SR-correction d).
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
// BACKLOG-2393: scoped support-access tracing. A no-op unless a user has
// granted a support window covering the message-import scope.
import { supportTrace } from "./supportAccess/trace";
import {
  recordImport,
  recordExpansionRun,
  getDeepestImportStart,
} from "./db/messageImportStateService";
// BACKLOG-2772: the ONE assembler + resolver every import entry point calls.
import {
  resolveImportPlanForUser,
  readNonRejectedTransactions,
} from "./importPlanInputs";
import {
  emitBackgroundImportStarted,
  emitBackgroundImportFinished,
} from "./messagesBackgroundImportSignal";
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

/*
 * BACKLOG-2772: `getNonRejectedTxnDates` was DELETED from this file.
 *
 * It was a verbatim second copy of the `status != 'rejected'` query that the
 * import plan's assembler runs — two readers of one fact, in the one module
 * whose whole job is to decide how far back an import must reach. The shared
 * reader is `readNonRejectedTransactions`, and the export gate
 * (`auditCoverageService.checkExportCompleteness`) reads the same predicate, so
 * the import floor, the plan's protected spans and the export gate can no
 * longer disagree about which deals carry an audit obligation.
 */

/**
 * Resolve the required lower bound: an explicit proposed start (create /
 * date-selection / export) else the earliest audit start across all non-rejected
 * transactions. Computed BEFORE the coalesce decision (SR D1) so the registry can
 * compare depths.
 */
function resolveRequiredStart(userId: string, proposedStartISO?: string | null): Date | null {
  if (proposedStartISO) {
    const d = new Date(proposedStartISO);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return computeEarliestAuditStart(readNonRejectedTransactions(userId));
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

    // BACKLOG-2305 (efficiency): the live MIN(sent_at) floor can sit ABOVE
    // requiredStart forever when no device messages exist older than the floor —
    // so `gap` stays true and every date-change would REDUNDANTLY re-scan the same
    // window (the founder saw the same window imported twice, each flashing
    // 0→100%). `deepest_import_start` records how far back a targeted import has
    // ALREADY scanned the device; when that reaches at least as far back as
    // requiredStart the window is provably covered (the same predicate the export
    // gate trusts — auditCoverageService.checkExportCompleteness), so skip the
    // duplicate device import. Expansion still ALWAYS runs below.
    const deepestImportStart = getDeepestImportStart(userId);
    const alreadyScannedDeep =
      requiredStart !== null &&
      deepestImportStart !== null &&
      new Date(deepestImportStart).getTime() <= requiredStart.getTime();

    // BACKLOG-2772: a targeted GLOBAL import, resolved by the SAME planner the
    // Settings buttons and the estimate use.
    //
    // What this replaces was one line — `{ auditPeriodStart: ... }` — and it was
    // a third assembler. It carried NO lookback, NO cap and NO attachment
    // preference, so a deal being created silently started a full-device,
    // uncapped, attachment-copying scan that ignored every setting the user had
    // chosen, and the old `auditPeriodActive` rule then switched the cap off for
    // the whole library on top of that. Under Cap' the deal's own period is
    // protected by being a span, and the cap still governs everything else.
    //
    // `requestedStartISO` is how this entry point states its one legitimate
    // difference: the deal being created may not be in the database yet, so its
    // start has to be passed in rather than derived.
    if (gap && importerAvailable && !alreadyScannedDeep) {
      const plan = await resolveImportPlanForUser({
        userId,
        mode: "delta",
        requestedStartISO: (requiredStart as Date).toISOString(),
      });

      // BACKLOG-2772: announce the run so the renderer can mirror it into the
      // sync queue as an external item. Until now this import had no queue item
      // and therefore NO CANCEL SURFACE AT ALL — the service's cancel is global
      // and would have stopped it, but nothing ever offered the button. A deal
      // created on a large library started an unstoppable full-device scan.
      emitBackgroundImportStarted(userId, reason);
      let result;
      try {
        result = await macOSMessagesImportService.importMessages(
          userId,
          onProgress,
          plan,
        );
      } finally {
        // In a `finally` so a throw cannot strand a spinning queue item that
        // the user can never dismiss.
        emitBackgroundImportFinished(userId, reason);
      }
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
    // BACKLOG-2305: a prior import already scanned at least this deep → covered
    // (the redundant device import was intentionally suppressed above).
    else if (alreadyScannedDeep) skipped = "covered";
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

    // BACKLOG-2393: why an import did *not* happen is the question this answers.
    // "Keepr didn't pick up my texts" is usually a decision made right here —
    // already covered, no importer on this platform, or a failed run — and none
    // of those look any different to a user. A no-op outside a granted window.
    supportTrace("message-import", "sync-trigger-complete", {
      reason,
      required_start: requiredStart,
      floor_before: floorBefore,
      floor_after: floorAfter,
      gap,
      already_scanned_deep: alreadyScannedDeep,
      importer_available: importerAvailable,
      import_ran: importRan,
      imported,
      expansion_ran: expansionRan,
      skipped_because: skipped ?? null,
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
