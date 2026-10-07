/**
 * BACKLOG-3663 — the Texts tab's coverage notice: a text source (the user's
 * chosen one, or one they have texts from) that does not reach back to this
 * transaction's audit start, and what re-syncs it.
 *
 * Exact coverage (Google Messages' recorded floor, Mac's import depth) shows
 * as a warning; an APPROXIMATE one (iPhone / Android companion, read from the
 * oldest stored text) as a soft note. Never blocks anything.
 */

import React, { useCallback, useEffect, useState } from "react";
import { settingsService } from "../../../services/settingsService";
import { effectiveImportSource } from "../../../services/importSourcePolicy";
import { isMacOS } from "../../../utils/platform";
import { rcsImportService } from "../../../services/rcsImportService";
import { transactionService } from "../../../services/transactionService";
import type { SourceCoverageGap, TextSource } from "../../../../electron/types/auditCoverage";

const LABEL: Record<TextSource, string> = {
  iphone: "iPhone",
  mac: "Mac Messages",
  android_companion: "Android (companion app)",
  google_messages: "Google Messages",
};

const ACTION: Record<TextSource, string> = {
  iphone: "Click Sync iPhone on the dashboard.",
  mac: "Update Mac messages to read back further.",
  android_companion: "Click Sync Android on the dashboard.",
  google_messages: "Click Sync Android on the dashboard: it reads back to the start.",
};

/** The user's import source preference → the coverage source. */
/**
 * Live (founder, 2026-10-05): the date-range dialog names ONLY the user's
 * own source and its action — never one they didn't pick. The Mac source
 * counts only on a Mac; anything else (the parked Android Companion
 * included) maps through chosenTextSource.
 */
// BACKLOG-3418: `effective` is null when the user chose no source (Windows/
// Linux) — the dialog then names no source, like any unrecognised value.
export function dialogTextSource(effective: string | null, onMac: boolean): TextSource | null {
  const chosen = chosenTextSource(effective);
  return chosen === "mac" && !onMac ? null : chosen;
}

export function chosenTextSource(pref: string | undefined | null): TextSource | null {
  switch (pref) {
    case "macos-native":
      return "mac";
    case "iphone-sync":
      return "iphone";
    // SR C6 (founder): the Companion is no longer offered — a stored
    // "android-companion" is shown as Google Messages, like everywhere else.
    case "android-companion":
    case "android-messages-web":
      return "google_messages";
    default:
      return null;
  }
}

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

interface TextCoverageNoticeProps {
  transactionId: string;
  userId: string;
}

export function TextCoverageNotice({ transactionId, userId }: TextCoverageNoticeProps) {
  const [gaps, setGaps] = useState<SourceCoverageGap[]>([]);
  const [auditStart, setAuditStart] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    let chosen: TextSource | null = null;
    try {
      const prefs = await settingsService.getPreferences(userId);
      const stored = prefs.success ? prefs.data?.messages?.source : null;
      // BACKLOG-3749: a value this build does not know → the platform default.
      chosen = chosenTextSource(stored ? effectiveImportSource(stored, isMacOS()) : null);
    } catch {
      chosen = null;
    }
    try {
      // SR: through the service, never window.api from the component.
      const r = await transactionService.getTextCoverage(transactionId, userId, chosen);
      if (r && r.success) {
        setGaps(r.gaps);
        setAuditStart(r.auditStartISO);
      }
    } catch {
      // A coverage read failing never shows anything.
    }
  }, [transactionId, userId]);

  useEffect(() => {
    void load();
    // A Sync saved (or Force re-import): coverage may have changed.
    const offChanged = rcsImportService.onDataChanged(() => void load());
    const offCleared = rcsImportService.onDataCleared(() => void load());
    return () => {
      offChanged();
      offCleared();
    };
  }, [load]);

  const updateMac = useCallback(async () => {
    setUpdating(true);
    try {
      await transactionService.ensureMessagesCoverage(userId, auditStart, transactionId);
    } finally {
      setUpdating(false);
      await load();
    }
  }, [auditStart, load, transactionId, userId]);

  if (gaps.length === 0) return null;
  const older = googleMessagesOlderLine(gaps);
  if (older) {
    return (
      <div
        className="mb-3 flex items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] bg-[#EFF6FF] border border-[#BFDBFE] text-[13px] text-[#1E40AF]"
        role="status"
        data-testid="text-coverage-notice"
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v4h1" />
        </svg>
        <span data-testid="coverage-gap-google_messages">{older}</span>
      </div>
    );
  }
  const exact = gaps.some((g) => !g.approximate);
  return (
    <div
      className={`mb-3 p-3 rounded-lg border text-sm ${exact ? "bg-amber-50 border-amber-300 text-amber-900" : "bg-gray-50 border-gray-200 text-gray-700"}`}
      role="status"
      data-testid="text-coverage-notice"
    >
      <p className="font-medium">Some texts may be missing for this transaction&rsquo;s dates</p>
      <ul className="mt-1 space-y-1">
        {gaps.map((g) => (
          <li key={g.source} data-testid={`coverage-gap-${g.source}`}>
            {googleMessagesGapLine(g) ?? `${gapLine(g, auditStart)} ${ACTION[g.source]}`}
            {g.source === "mac" && (
              <button
                type="button"
                className="ml-2 text-indigo-700 hover:text-indigo-900 font-medium disabled:opacity-50"
                onClick={() => void updateMac()}
                disabled={updating}
              >
                {updating ? "Updating…" : "Update Mac messages"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
