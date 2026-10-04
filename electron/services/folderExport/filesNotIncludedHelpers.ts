/**
 * BACKLOG-3683 (coordinator routing 2026-10-04) — the combined PDF's last
 * section: the attachments this export selected but could not include, with
 * the file name, the message it came from, and why.
 *
 * At zero nothing is rendered — nothing was left out, so there is nothing to
 * state (same default as the hidden-texts notice).
 */
import { escapeHtml } from "../../utils/exportUtils";
import type { ExportFileNotIncluded, ExportFileNotIncludedReason } from "../exportNotices";

/** The section's anchor id. */
export const FILES_NOT_INCLUDED_SECTION_ID = "files-not-included";

export const FILES_NOT_INCLUDED_HEADING = "Files not included";

const REASON_TEXT: Record<ExportFileNotIncludedReason, string> = {
  not_on_this_computer: "Not downloaded to this computer",
  file_missing: "No longer on this computer",
  copy_failed: "Could not be copied",
};

export function filesNotIncludedReasonText(reason: ExportFileNotIncludedReason): string {
  return REASON_TEXT[reason];
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A full HTML document (the combined builder extracts its style and body). */
export function generateFilesNotIncludedHTML(files: ExportFileNotIncluded[]): string {
  const rows = files
    .map(
      (f) => `
        <tr>
          <td>${escapeHtml(f.filename)}</td>
          <td>${escapeHtml(f.source)}${f.sentAt ? `<div class="when">${escapeHtml(shortDate(f.sentAt))}</div>` : ""}</td>
          <td>${escapeHtml(filesNotIncludedReasonText(f.reason))}</td>
        </tr>`
    )
    .join("");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; padding: 40px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p.lead { font-size: 13px; color: #4b5563; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; background: #f3f4f6; padding: 8px; border-bottom: 1px solid #e5e7eb; }
    td { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-break: break-word; }
    .when { color: #6b7280; font-size: 11px; margin-top: 2px; }
  </style>
</head>
<body>
  <h1>${FILES_NOT_INCLUDED_HEADING}</h1>
  <p class="lead">${files.length} ${files.length === 1 ? "attachment was" : "attachments were"} selected for this export but could not be included.</p>
  <table>
    <thead><tr><th>File</th><th>Source message</th><th>Reason</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>`;
}
