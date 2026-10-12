/**
 * BACKLOG-3892 W — every text-coverage line a user reads, in ONE place.
 *
 * The create/edit dialog (AuditCoveragePrompt), the export gate (ExportModal) and the
 * Texts tab (TextCoverageNotice) all build their lines here, so a sentence is never
 * written twice and S6 ("Get older texts") extends this file instead of three.
 *
 * Founder-approved sentences (pm_comments 7845fbe4, 49249857), used verbatim:
 *  - start:     "Keepr only has texts with <Name> from <date>, but this deal starts <date>. Older texts may be missing."
 *  - end:       "Newer texts may be missing: your iPhone was last synced <date>, and this deal runs to <date>. Sync iPhone to get them."
 *  - new phone: "Texts before <date> are on your previous iPhone or its backup."
 * PROPOSED (same shape, not yet approved): the start line with no name, and the
 * Google Messages / Mac end lines.
 *
 * Dates: "MMM d", plus the year when it is not this year — the founder's Google
 * Messages format (googleMessagesGapLine).
 */
import type { SourceCoverageGap, TextSource } from "../../../../electron/types/auditCoverage";
import type { BackfillPhase, BackfillReason } from "../../../../electron/types/iphoneBackfill";

/** "Sep 2" (this year) or "Sep 2, 2024"; "" for a missing or invalid date. */
export function coverageDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/**
 * BACKLOG-3892 E (founder-approved 2026-10-11, f240c29a): the Google Messages done screen
 * when a deal chat came back short of the date its deal needs. null without a date.
 */
export function googleMessagesOnlyBackToLine(iso: string | null | undefined, now: Date = new Date()): string | null {
  const when = coverageDay(iso, now);
  return when ? `Google Messages on the web only returned texts back to ${when}.` : null;
}

/** W3b (approved): the start is limited by the current phone's oldest text, and there was another phone. */
export function previousPhoneLine(gap: SourceCoverageGap, now: Date = new Date()): string | null {
  if (gap.source !== "iphone" || !gap.cappedByPhone || !gap.previousPhone) return null;
  const when = coverageDay(gap.cappedByPhone, now);
  return when ? `Texts before ${when} are on your previous iPhone or its backup.` : null;
}

/**
 * The iPhone start line (approved; the nameless form is PROPOSED). null when the gap
 * is not an iPhone "later" gap with both dates.
 */
export function iphoneStartLine(gap: SourceCoverageGap, auditStartISO: string | null, now: Date = new Date()): string | null {
  if (gap.source !== "iphone" || gap.kind !== "later") return null;
  const from = coverageDay(gap.coveredSince, now);
  const starts = coverageDay(auditStartISO, now);
  if (!from || !starts) return null;
  const who = gap.who && gap.who.trim().length > 0 ? ` with ${gap.who.trim()}` : "";
  return `Keepr only has texts${who} from ${from}, but this deal starts ${starts}. Older texts may be missing.`;
}

const END_SUBJECT: Partial<Record<TextSource, { subject: string; action: string }>> = {
  iphone: { subject: "your iPhone was last synced", action: "Sync iPhone to get them." },
  // PROPOSED wording (same shape as the approved iPhone line).
  google_messages: { subject: "Google Messages was last synced", action: "Sync Android to get them." },
  mac: { subject: "Mac Messages were last imported", action: "Update Mac messages to get them." },
};

/** W1: the end line ("newer" gap). null for any other gap or a source with no end check. */
export function endLine(gap: SourceCoverageGap, now: Date = new Date()): string | null {
  if (gap.kind !== "newer") return null;
  const copy = END_SUBJECT[gap.source];
  const last = coverageDay(gap.lastSyncAt, now);
  const runsTo = coverageDay(gap.requiredEndISO, now);
  if (!copy || !last || !runsTo) return null;
  return `Newer texts may be missing: ${copy.subject} ${last}, and this deal runs to ${runsTo}. ${copy.action}`;
}

/**
 * The iPhone start line with what to do next: the previous-phone line when the
 * phone's own oldest text limits it (a sync cannot read further back), nothing more
 * for a single capped phone, otherwise `syncAction`.
 */
export function iphoneStartWithAction(
  gap: SourceCoverageGap,
  auditStartISO: string | null,
  syncAction: string,
  now: Date = new Date(),
): string | null {
  const start = iphoneStartLine(gap, auditStartISO, now);
  if (!start) return null;
  if (gap.cappedByPhone) {
    const prev = previousPhoneLine(gap, now);
    return prev ? `${start} ${prev}` : start;
  }
  return `${start} ${syncAction}`;
}

/** A stable React key / test id suffix for a gap: one source can have a start AND an end gap. */
export function gapKey(gap: SourceCoverageGap): string {
  return gap.kind === "newer" ? `${gap.source}-newer` : gap.source;
}

export const LABEL: Record<TextSource, string> = {
  iphone: "iPhone",
  mac: "Mac Messages",
  android_companion: "Android (companion app)",
  google_messages: "Google Messages",
};


function day(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : "";
}

/**
 * Founder (2026-10-04): THE line for a Google Messages gap — the same
 * wherever it shows (the Texts tab, the "Communications will update"
 * dialog, any other caller): "Texts start Sep 2. Sync Android on the
 * dashboard to get older ones." ("MMM d"; the year only when it isn't this
 * year). null when the gap is not Google Messages reading only since a date.
 */
export function googleMessagesGapLine(gap: SourceCoverageGap, now: Date = new Date()): string | null {
  if (gap.source !== "google_messages" || gap.kind !== "later" || !gap.coveredSince) return null;
  const t = Date.parse(gap.coveredSince);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const when = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `Texts start ${when}. Sync Android on the dashboard to get older ones.`;
}

/** The Texts tab: Google Messages alone, read only since a date → that one line. */
export function googleMessagesOlderLine(gaps: SourceCoverageGap[], now: Date = new Date()): string | null {
  return gaps.length === 1 ? googleMessagesGapLine(gaps[0], now) : null;
}

/** One line per gap (exported for the audit prompt). */
export function gapLine(gap: SourceCoverageGap, auditStartISO: string | null): string {
  const label = LABEL[gap.source];
  if (gap.kind === "never") return `${label}: not fully synced yet.`;
  // L2: covered back to the start, but some chats could not be confirmed complete.
  if (gap.kind === "incomplete") {
    const n = gap.incompleteChats ?? 0;
    return `${label}: ${n} chat${n === 1 ? "" : "s"} may be incomplete.`;
  }
  const approx = gap.approximate ? " (from the oldest text Keepr has)" : "";
  return `${label}: texts only from ${day(gap.coveredSince)}${approx}${auditStartISO ? `; this transaction starts ${day(auditStartISO)}` : ""}.`;
}


/**
 * THE line for one gap on every surface: the approved iPhone start/end lines, the
 * founder's Google Messages line, else the source line plus `action` (the surface's
 * own next step, e.g. "Click Sync iPhone on the dashboard.").
 */
export function coverageLine(gap: SourceCoverageGap, auditStartISO: string | null, action: string, now: Date = new Date()): string {
  if (gap.kind === "newer") return endLine(gap, now) ?? "";
  return (
    iphoneStartWithAction(gap, auditStartISO, action, now) ??
    googleMessagesGapLine(gap, now) ??
    `${gapLine(gap, auditStartISO)} ${action}`
  );
}

/* -------------------------------------------------------------------------------------
 * BACKLOG-3892 S6 — "Get older texts" (read the deal's older texts from the iPhone backup
 * kept on this computer).
 *
 * DRAFT — NOT FOUNDER-APPROVED. Every sentence in this block is awaiting the founder
 * (OPEN QUESTION on BACKLOG-3892, pm_comments f7d39c03). Do not reuse elsewhere until
 * that row is ANSWERED; change the wording here only.
 *
 * The approved backup sentences ("...is damaged.", "...cannot decrypt...", "...no longer
 * on this computer.") are NOT here: they come from the main process (S5's `message`,
 * backupProblem.ts), because the renderer cannot import from electron/.
 * ----------------------------------------------------------------------------------- */

/** DRAFT: the button. */
export const GET_OLDER_TEXTS_LABEL = "Get older texts";
/** DRAFT: the line while it runs. */
export const GET_OLDER_TEXTS_RUNNING = "Fetching older texts from your saved iPhone backup…";
/** DRAFT: the step under it. */
export const GET_OLDER_TEXTS_PHASE: Record<BackfillPhase, string> = {
  copying: "Copying backup",
  reading: "Reading texts",
  saving: "Saving texts",
  linking: "Linking to deals",
};
/** DRAFT: the line when it is done. */
export function getOlderTextsDoneLine(messagesStored: number): string {
  if (messagesStored <= 0) return "Your saved iPhone backup has no older texts for this deal.";
  return `Added ${messagesStored} older text${messagesStored === 1 ? "" : "s"} from your saved iPhone backup.`;
}
/** DRAFT: a failure with no approved sentence. */
export const GET_OLDER_TEXTS_FAILED = "Keepr couldn't get older texts. Try again later.";

/** The reasons whose `message` (from S5) is a founder-approved sentence. */
const APPROVED_MESSAGE_REASONS: ReadonlySet<BackfillReason> = new Set<BackfillReason>(["missing", "damaged", "key-missing"]);

/**
 * The line for a backfill that did not run or stopped: the approved backup sentence for
 * missing / damaged / key-missing; nothing for a cancel; otherwise the DRAFT failure line.
 * Never S5's `message` for any other reason (a reason "error" can carry raw error text).
 */
export function getOlderTextsRefusalLine(reason: BackfillReason | undefined, message: string | undefined): string | null {
  if (reason === "cancelled") return null;
  if (reason && APPROVED_MESSAGE_REASONS.has(reason)) return message && message.trim() ? message : GET_OLDER_TEXTS_FAILED;
  return GET_OLDER_TEXTS_FAILED;
}

/**
 * The line shown INSTEAD of the button when availability says no: only an approved
 * backup sentence (founder OPEN QUESTION (5): "no longer on this computer" is shown);
 * every other reason (locked, no gap, nothing older, busy, ...) shows nothing.
 */
export function getOlderTextsUnavailableLine(reason: BackfillReason | undefined, message: string | undefined): string | null {
  if (!reason || !APPROVED_MESSAGE_REASONS.has(reason)) return null;
  return message && message.trim() ? message : null;
}
