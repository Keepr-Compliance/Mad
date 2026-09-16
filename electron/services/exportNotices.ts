/**
 * Export notices — BACKLOG-3367
 *
 * ONE place that decides what an exported artifact SAYS about what it left out.
 *
 * An audit export is handed to a third party. When the agent hides a text from
 * the export (BACKLOG-3366), the artifact must say how many texts are missing,
 * in EVERY format — otherwise a reader cannot tell a complete record from a
 * pruned one, which is the silent omission this feature exists to prevent.
 *
 * ## Why an object and not a bare number
 *
 * `ExportOmissions` is a REQUIRED parameter at every renderer boundary that can
 * print a notice. SR's required change 2 on the plan review (pm_comments
 * d590f7c6): the combined-PDF renderer is called from two branches of
 * `enhancedExportService._exportPDF`, and a `hiddenTextCount = 0` default would
 * let one branch silently forget it and still compile. There is deliberately no
 * default anywhere in this chain — omitting it is a type error.
 *
 * The object (rather than a positional number) also gives BACKLOG-2761 — the
 * "what this export could not include" statement — a place to add its own
 * counts without changing five signatures again. The two must stay SEPARATE
 * sentences and separate counts: a hidden text is a deliberate user exclusion,
 * an import gap is an unknown. Never merge them.
 *
 * ## Scope
 *
 * `"transaction"` — the whole artifact (summary page, CSV header, JSON, manifest,
 * SUMMARY.txt). `"conversation"` — one conversation's own page, because a folder
 * export's `texts/*.pdf` can be handed to someone on its own (founder decision
 * 2026-09-15, pm_comments 6306f393 item 2).
 */

import type { Communication } from "../types/models";

/** What an export left out, for the artifact to state. */
export interface ExportOmissions {
  /**
   * Texts this export omitted because the user hid them from it.
   *
   * Counts only texts the export would OTHERWISE have included — inside its
   * audit window and its content selection. A text outside the window was left
   * out by the window, not by hiding (founder default, pm_comments d590f7c6).
   * Reactions to hidden texts are dropped too but never counted; the count is a
   * count of messages a reader would have seen.
   */
  hiddenTextCount: number;
}

/** Nothing was hidden. Use where an artifact genuinely omits nothing. */
export const NO_OMISSIONS: ExportOmissions = { hiddenTextCount: 0 };

/**
 * What a MULTI-SECTION artifact needs: the count for the document, plus the
 * omitted rows so each section can state its own.
 *
 * The combined PDF is one file whose per-thread sections each carry their own
 * anchor and back-link and are read as units, so each states what was removed
 * from it — the same reason a folder export's `texts/*.pdf` does (founder
 * decision 2026-09-15, pm_comments 6306f393 item 2). Sections are keyed with
 * the renderer's own `getThreadKey()`; the membership predicate is never
 * re-derived, only the grouping.
 */
export interface ExportOmissionDetail extends ExportOmissions {
  /** The omitted texts themselves, as `ExportPlan.hiddenTexts` lists them. */
  hiddenTexts: Communication[];
}

export type ExportNoticeScope = "transaction" | "conversation";

/**
 * The hidden-texts sentence, or null when nothing was hidden.
 *
 * At zero the export says nothing: nothing was left out, so there is nothing to
 * state (founder default, pm_comments d590f7c6). Every caller must handle null
 * rather than printing an empty line.
 */
export function hiddenTextsNotice(
  omissions: ExportOmissions,
  scope: ExportNoticeScope,
): string | null {
  const count = omissions.hiddenTextCount;
  if (!Number.isFinite(count) || count <= 0) return null;

  const where = scope === "conversation" ? "this conversation" : "this transaction";
  return count === 1
    ? `1 text message in ${where} was hidden from this export.`
    : `${count} text messages in ${where} were hidden from this export.`;
}

/**
 * Every notice this export must state, as plain lines.
 *
 * The list form is what the text formats (CSV header, SUMMARY.txt) and the JSON
 * `export_notices` array consume, so a later notice reaches all three by being
 * added here once.
 */
export function exportNoticeLines(
  omissions: ExportOmissions,
  scope: ExportNoticeScope = "transaction",
): string[] {
  const lines: string[] = [];
  const hidden = hiddenTextsNotice(omissions, scope);
  if (hidden) lines.push(hidden);
  return lines;
}

/** Minimal HTML escape for text interpolated into a rendered page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The notices as an HTML block, or "" when there is nothing to state.
 *
 * `class="export-notice"` deliberately avoids `email-item` / `text-item` and any
 * `<h3>` beginning "Email/Text Threads Index": `injectIndexLinks()`
 * (`folderExport/combinedExportHelpers.ts`) rewrites those by regex to build the
 * combined PDF's internal links, and a notice caught by that rewrite would break
 * them.
 */
export function exportNoticesHtml(
  omissions: ExportOmissions,
  scope: ExportNoticeScope = "transaction",
): string {
  const lines = exportNoticeLines(omissions, scope);
  if (lines.length === 0) return "";

  return `<div class="export-notice">
    ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("\n    ")}
  </div>`;
}
