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
// ============================================

import auditService from "./auditService";
import databaseService from "./databaseService";
import { emitExportCompleted } from "./exportGate";
import { rememberOpenablePath } from "./openablePaths";

type ExportMode = Parameters<typeof emitExportCompleted>[0]["mode"];

// Named interface on purpose: the write-atomicity guard needs the parameter
// type to close on a line before the function body's `{` (BACKLOG-3225).
export interface ExportCompletionInput {
  transactionId: string;
  userId: string;
  /** The count read before the export ran; the recorded count is this + 1. */
  exportCount: number | null | undefined;
  propertyAddress: string | null | undefined;
  /** `export_format` column value. Undefined leaves the column as it is. */
  recordedFormat?: string;
  /** Format label carried by the audit row and the funnel event. */
  auditFormat: string;
  hiddenTextCount: number;
  mode: ExportMode;
  path: string;
}

export async function completeExport(input: ExportCompletionInput): Promise<void> {
  // BACKLOG-2549 — export tracking AND the BACKLOG-2013 freeze boundary in
  // ONE statement, so a deal can never be `exported` while still editable.
  const exportedAt = new Date().toISOString();
  databaseService.recordExportCompletion(input.transactionId, {
    ...(input.recordedFormat !== undefined ? { exportFormat: input.recordedFormat } : {}),
    exportedAt,
    exportCount: (input.exportCount || 0) + 1,
    firstExportedAt: exportedAt,
  });

  await auditService.log({
    userId: input.userId,
    action: "DATA_EXPORT",
    resourceType: "EXPORT",
    resourceId: input.transactionId,
    metadata: {
      format: input.auditFormat,
      propertyAddress: input.propertyAddress,
      // BACKLOG-3367: the audit trail records what the artifact left out,
      // not only that an export happened.
      hiddenTextCount: input.hiddenTextCount,
    },
    success: true,
  });

  // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
  await emitExportCompleted({
    userId: input.userId,
    transactionId: input.transactionId,
    mode: input.mode,
    format: input.auditFormat,
  });

  // BACKLOG-3808: the renderer may later ask to open this export.
  await rememberOpenablePath(input.path);
}
