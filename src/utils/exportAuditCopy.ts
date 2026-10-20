/**
 * BACKLOG-3339: what the user is told when an export's file was saved but the
 * export could not be recorded in the audit log. Founder-approved wording
 * (pm_comments b002a154).
 *
 * The main process sends the same body text as the IPC `error`; the renderer
 * cannot import it from `electron/`, so these are mirrors, held equal by
 * src/utils/__tests__/exportAuditCopy.parity-3339.test.ts.
 */

export const EXPORT_NOT_RECORDED_HEADING = "Export saved, but not recorded";

export const EXPORT_NOT_RECORDED_BODY =
  "Your file was saved, but this export could not be recorded in the audit log. Export it again before you send it. If this keeps happening, contact support.";

/** Settings "Export My Data": shown under the button and in the toast. */
export const DATA_EXPORT_NOT_RECORDED_MESSAGE =
  "Your data file was saved, but this export could not be recorded in the audit log. If this keeps happening, contact support.";

/** Bulk export: the red banner under the deal-list toolbar. */
export function bulkExportNotRecordedMessage(addresses: string[]): string {
  const list = addresses.join(", ");
  if (addresses.length === 1) {
    return `1 export was saved but could not be recorded in the audit log: ${list}. Export it again before you send it. If this keeps happening, contact support.`;
  }
  return `${addresses.length} exports were saved but could not be recorded in the audit log: ${list}. Export them again before you send them. If this keeps happening, contact support.`;
}
