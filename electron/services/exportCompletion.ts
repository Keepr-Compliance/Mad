// ============================================
// EXPORT COMPLETION — the one owner of export bookkeeping (BACKLOG-3303)
//
// Every live export path finishes by recording the export, writing the audit
// row, emitting the funnel event and registering the file as openable. That
// tail used to be written out once per handler, and a third copy (the dead
// export-pdf handler) drifted and forgot half of it.
//
// The recorded row is unchanged from BACKLOG-2549: ONE statement, with the
// freeze marker write-once in SQL (COALESCE), so re-exporting never moves the
// freeze date.
//
// BACKLOG-3339: the export record and its audit entry are written in ONE
// transaction. If the audit entry cannot be written, the record and the freeze
// roll back, the file (already on disk) is KEPT, a failure entry is written,
// and the caller is told `recorded: false` so the user sees an error. Sentry
// gets one report per stretch of such failures; the next recorded export
// ends the stretch.
// ============================================

import * as Sentry from "@sentry/electron/main";
import auditService from "./auditService";
import databaseService from "./databaseService";
import { dbTransaction } from "./db/core/dbConnection";
import { dealChangeFailureCode, isAuditNotRecorded } from "./dealChangeAudit";
import { emitExportCompleted } from "./exportGate";
import { rememberOpenablePath } from "./openablePaths";

/**
 * BACKLOG-3339: what the user is told when the file was saved but the export
 * could not be recorded (founder-approved wording, pm_comments b002a154). The
 * renderer shows it as the body of the Export window's finished screen.
 */
export const EXPORT_NOT_RECORDED_MESSAGE =
  "Your file was saved, but this export could not be recorded in the audit log. Export it again before you send it. If this keeps happening, contact support.";

/** The fixed code stored on the failure entry. Never the driver's text. */
export const EXPORT_NOT_RECORDED_CODE = "audit_entry_not_written";

export const EXPORT_NOT_RECORDED_SENTRY_MESSAGE = "Export audit entry not written";

/**
 * True while exports keep failing to record. Cleared by the next recorded
 * export, so a later failure is reported again. Module state on purpose:
 * auditService's own `localInsertFailing` is not set by `recordInTransaction`
 * and is cleared by a successful `recordFailure`, so it cannot serve here.
 */
let notRecordedStretch = false;

/** Test-only: start each case outside a stretch. */
export function resetExportAuditStretchForTests(): void {
  notRecordedStretch = false;
}

type ExportMode = Parameters<typeof emitExportCompleted>[0]["mode"];

// Named interface on purpose: the write-atomicity guard needs the parameter
// type to close on a line before the function body's `{` (BACKLOG-3225).
export interface ExportCompletionInput {
  transactionId: string;
  userId: string;
  propertyAddress: string | null | undefined;
  /** `export_format` column value. Undefined leaves the column as it is. */
  recordedFormat?: string;
  /** Format label carried by the audit row and the funnel event. */
  auditFormat: string;
  hiddenTextCount: number;
  mode: ExportMode;
  path: string;
}

export interface ExportCompletionResult {
  /** False when the audit entry could not be written; the file is kept. */
  recorded: boolean;
}

export async function completeExport(input: ExportCompletionInput): Promise<ExportCompletionResult> {
  const auditEntry = {
    userId: input.userId,
    action: "DATA_EXPORT" as const,
    resourceType: "EXPORT" as const,
    resourceId: input.transactionId,
  };
  try {
    dbTransaction(() => {
      // BACKLOG-2549 — export tracking AND the BACKLOG-2013 freeze boundary in
      // ONE statement, so a deal can never be `exported` while still editable.
      const exportedAt = new Date().toISOString();
      databaseService.recordExportCompletion(input.transactionId, {
        ...(input.recordedFormat !== undefined ? { exportFormat: input.recordedFormat } : {}),
        exportedAt,
        firstExportedAt: exportedAt,
      });
      auditService.recordInTransaction({
        ...auditEntry,
        metadata: {
          format: input.auditFormat,
          propertyAddress: input.propertyAddress,
          // BACKLOG-3367: the audit trail records what the artifact left out,
          // not only that an export happened.
          hiddenTextCount: input.hiddenTextCount,
        },
      });
    });
  } catch (err) {
    if (!isAuditNotRecorded(err)) {
      // The export record itself failed: the export errors, as it always has.
      auditService.recordFailure({
        ...auditEntry,
        metadata: { format: input.auditFormat },
        errorMessage: dealChangeFailureCode(err),
      });
      throw err;
    }
    // No path and no address on the failure entry: both are cloud-synced, and
    // the default export path embeds the property address.
    auditService.recordFailure({
      ...auditEntry,
      metadata: { format: input.auditFormat },
      errorMessage: EXPORT_NOT_RECORDED_CODE,
    });
    if (!notRecordedStretch) {
      notRecordedStretch = true;
      // Tags only: no path, address, deal id or error text.
      Sentry.captureMessage(EXPORT_NOT_RECORDED_SENTRY_MESSAGE, {
        level: "error",
        tags: { operation: "completeExport", format: input.auditFormat, mode: String(input.mode) },
      });
    }
    // The file is kept, so "Open" must still find it.
    await rememberOpenablePath(input.path);
    return { recorded: false };
  }
  notRecordedStretch = false;

  // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
  await emitExportCompleted({
    userId: input.userId,
    transactionId: input.transactionId,
    mode: input.mode,
    format: input.auditFormat,
  });

  // BACKLOG-3808: the renderer may later ask to open this export.
  await rememberOpenablePath(input.path);
  return { recorded: true };
}
