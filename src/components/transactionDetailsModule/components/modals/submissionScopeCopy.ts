/**
 * BACKLOG-3683 (founder decision B, 2026-10-03) — the words the submit
 * summary uses for linked emails and texts that fall outside the dates.
 *
 * The cut-off stays (start of the Start Date to the end of the End Date); what
 * changes is that it is shown. The step labels the field "End Date", so the
 * copy says "end date", not "closing date".
 */
import type { SubmissionScope } from "../../hooks/useSubmissionScope";

/** "27 Sep" from a stored date (YYYY-MM-DD, or a full timestamp). */
export function scopeDate(value: string | null): string {
  if (!value) return "";
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // Fixed month names: ICU versions disagree ("Sep" vs "Sept").
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function countPhrase(emails: number, texts: number): string {
  const parts: string[] = [];
  if (emails > 0) parts.push(`${emails} ${emails === 1 ? "email" : "emails"}`);
  if (texts > 0) parts.push(`${texts} ${texts === 1 ? "text" : "texts"}`);
  return parts.join(" and ");
}

function verb(total: number): string {
  return total === 1 ? "is" : "are";
}

/**
 * One sentence per side that has anything, e.g.
 * "2 emails and 1 text are dated after the end date (27 Sep) and won't be sent."
 * Empty when everything linked is inside the dates.
 */
export function outOfWindowSentences(
  out: SubmissionScope["outOfWindow"],
  startDate: string,
  endDate: string
): string[] {
  const lines: string[] = [];
  const before = out.emailsBefore + out.textsBefore;
  if (before > 0) {
    lines.push(
      `${countPhrase(out.emailsBefore, out.textsBefore)} ${verb(before)} dated before the start date (${scopeDate(startDate)}) and won't be sent.`
    );
  }
  const after = out.emailsAfter + out.textsAfter;
  if (after > 0) {
    lines.push(
      `${countPhrase(out.emailsAfter, out.textsAfter)} ${verb(after)} dated after the end date (${scopeDate(endDate)}) and won't be sent.`
    );
  }
  if (out.undated > 0) {
    lines.push(
      `${out.undated} linked ${out.undated === 1 ? "item has" : "items have"} no date inside the range and won't be sent.`
    );
  }
  return lines;
}

/** One line per listed item: `27 Sep · Email "Subject"` / `27 Sep · Text with Jane`. */
export function outOfWindowItemLine(
  item: SubmissionScope["outOfWindow"]["items"][number]
): string {
  const when = scopeDate(item.sentAt);
  const what =
    item.kind === "email"
      ? `Email "${item.label || "(no subject)"}"`
      : `Text with ${item.label || "an unknown sender"}`;
  return when ? `${when} · ${what}` : what;
}

/** Total linked items outside the dates. */
export function outOfWindowTotal(out: SubmissionScope["outOfWindow"]): number {
  return out.emailsBefore + out.emailsAfter + out.textsBefore + out.textsAfter + out.undated;
}
