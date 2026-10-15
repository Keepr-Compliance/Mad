/**
 * BACKLOG-3764 — the words for evidence dated outside a deal's audit dates.
 *
 * Wording only. Whether something IS outside the dates is decided in the main
 * process (`addChecklistLink`, the submit pre-flight) with the submit's own
 * bounds; nothing here compares dates.
 *
 * Founder sentence (pm_comments on BACKLOG-3764, 2026-10-06): "This email is
 * from Oct 3, outside this deal's audit dates (Sep 1 – Sep 30). Include it in
 * the submission anyway?"
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Oct 3". A date-only value is that LOCAL day (never UTC midnight). */
export function shortDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(DATE_ONLY);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Sep 1 – Sep 30", "from Sep 1", "until Sep 30". */
export function auditDatesText(start: string | null, end: string | null): string {
  const from = shortDay(start);
  const to = shortDay(end);
  if (from && to) return `${from} – ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return "";
}

export type OutsideEvidenceKind = "email" | "conversation" | "file";

/** "This email is from Oct 3, outside this deal's audit dates (Sep 1 – Sep 30)." */
export function outsideDatesSentence(
  kind: OutsideEvidenceKind,
  sentAt: string | null,
  auditStart: string | null,
  auditEnd: string | null,
): string {
  const day = shortDay(sentAt);
  const dates = auditDatesText(auditStart, auditEnd);
  const window = dates ? `this deal's audit dates (${dates})` : "this deal's audit dates";
  if (!day) {
    const noun = kind === "file" ? "This file" : kind === "conversation" ? "This conversation" : "This email";
    return `${noun} is outside ${window}.`;
  }
  if (kind === "conversation") return `This conversation has an email from ${day}, outside ${window}.`;
  return `${kind === "file" ? "This file" : "This email"} is from ${day}, outside ${window}.`;
}

/** Several groups in one pick: "These are outside this deal's audit dates (Sep 1 – Sep 30)." */
export function outsideDatesPluralSentence(auditStart: string | null, auditEnd: string | null): string {
  const dates = auditDatesText(auditStart, auditEnd);
  return dates
    ? `These are outside this deal's audit dates (${dates}).`
    : "These are outside this deal's audit dates.";
}

/** The question after the sentence, singular or plural. */
export function includeAnywayQuestion(count: number): string {
  return count === 1
    ? "Include it in the submission anyway?"
    : "Include them in the submission anyway?";
}
