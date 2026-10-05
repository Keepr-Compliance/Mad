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
  download_failed: "Couldn't be downloaded from the mailbox",
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

/** The source-message cell: `Email "subject"` / `Text from <name or handle>`. */
export function filesNotIncludedSource(
  file: ExportFileNotIncluded,
  nameForHandle: (handle: string) => string | null
): string {
  if (file.sourceKind === "email") return `Email "${file.subject || "(No Subject)"}"`;
  if (file.sourceKind === "text") {
    const who = file.handle ? nameForHandle(file.handle) || file.handle : "Unknown";
    return `Text from ${who}`;
  }
  return "Unknown message";
}

/**
 * A full HTML document (the combined builder extracts its style and body).
 * Every selector is scoped to `.fni-*` classes: the combined builder files
 * this section under the same container class as the text threads, so a bare
 * `h1` / `table` rule here would restyle them.
 */
export function generateFilesNotIncludedHTML(
  files: ExportFileNotIncluded[],
  nameForHandle: (handle: string) => string | null
): string {
  const rows = files
    .map(
      (f) => `
        <tr>
          <td class="fni-cell">${escapeHtml(f.filename)}</td>
          <td class="fni-cell">${escapeHtml(filesNotIncludedSource(f, nameForHandle))}${f.sentAt ? `<div class="fni-when">${escapeHtml(shortDate(f.sentAt))}</div>` : ""}</td>
          <td class="fni-cell">${escapeHtml(filesNotIncludedReasonText(f.reason))}</td>
        </tr>`
    )
    .join("");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    .fni-wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; padding: 40px; }
    .fni-heading { font-size: 20px; margin-bottom: 8px; }
    .fni-lead { font-size: 13px; color: #4b5563; margin-bottom: 16px; }
    .fni-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .fni-head { text-align: left; background: #f3f4f6; padding: 8px; border-bottom: 1px solid #e5e7eb; }
    .fni-cell { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-break: break-word; }
    .fni-when { color: #6b7280; font-size: 11px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="fni-wrap">
    <h1 class="fni-heading">${FILES_NOT_INCLUDED_HEADING}</h1>
    <p class="fni-lead">${files.length} ${files.length === 1 ? "attachment was" : "attachments were"} selected for this export but could not be included.</p>
    <table class="fni-table">
      <thead><tr><th class="fni-head">File</th><th class="fni-head">Source message</th><th class="fni-head">Reason</th></tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}
