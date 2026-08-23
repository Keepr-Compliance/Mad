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
import { dbGet, dbAll } from "./db/core/dbConnection";
import { reactionExclusion } from "./db/reactionExclusion";
import { isExpansionStale, getDeepestImportStart } from "./db/messageImportStateService";
import permissionService from "./permissionService";
import logService from "./logService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
// BACKLOG-2562: the ONE definition of "is this deal live?" (see the call site).
import { isLiveTransactionStatus } from "./transactionEligibility";
import {
  isBeforeFloor,
  type AuditCoverageResult,
  type ExportCompletenessResult,
} from "../types/auditCoverage";

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
      `SELECT MIN(m.sent_at) AS floor
         FROM messages m
        WHERE m.user_id = ?
          AND m.channel IN ('sms', 'imessage')
          AND m.duplicate_of IS NULL
          AND ${reactionExclusion("m")}
          AND m.sent_at IS NOT NULL`,
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
    "SELECT oldest_cached_at FROM email_sync_state WHERE user_id = ? AND phase = 'active'",
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
      "SELECT started_at, created_at, closed_at, status FROM transactions WHERE id = ? AND user_id = ?",
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

    return {
      success: true,
      complete,
      messagesFloorISO,
      auditStartISO,
      needsMessagesImport,
      expansionStale,
      messagesImporterAvailable,
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
