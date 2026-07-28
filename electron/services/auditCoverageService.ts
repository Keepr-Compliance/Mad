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
import { isExpansionStale, hasImportRun } from "./db/messageImportStateService";
import permissionService from "./permissionService";
import logService from "./logService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
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
 */
export function getMessagesFloorISO(userId: string): string | null {
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
    }>(
      "SELECT started_at, created_at, closed_at FROM transactions WHERE id = ? AND user_id = ?",
      [transactionId, userId],
    );

    const auditStartISO = txn
      ? computeTransactionDateRange(txn).start.toISOString()
      : null;

    const messagesFloorISO = getMessagesFloorISO(userId);
    const expansionStale = isExpansionStale(userId);
    const messagesImporterAvailable = await isMessagesImporterAvailable();

    // Raw gap: the audit start predates the imported floor (floor non-null).
    const needsMessagesImport = isBeforeFloor(auditStartISO, messagesFloorISO);

    // Complete when expansion is current AND either (a) the floor already reaches
    // the audit start, or (b) a targeted import has run — in which case a floor
    // still above the audit start simply means no older texts exist on the
    // device (the import reaches back to the earliest audit start via
    // auditPeriodStart). This keeps the gate satisfiable + non-nagging instead of
    // looping forever when the audit start predates the user's oldest message.
    const complete =
      !expansionStale && (!needsMessagesImport || hasImportRun(userId));

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
