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
import { rcsImportService } from "../../../services/rcsImportService";
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
export function chosenTextSource(pref: string | undefined | null): TextSource | null {
  switch (pref) {
    case "macos-native":
      return "mac";
    case "iphone-sync":
      return "iphone";
    case "android-companion":
      return "android_companion";
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
    const getTextCoverage = window.api?.transactions?.getTextCoverage;
    if (!getTextCoverage) return;
    let chosen: TextSource | null = null;
    try {
      const prefs = await settingsService.getPreferences(userId);
      chosen = chosenTextSource(prefs.success ? prefs.data?.messages?.source : null);
    } catch {
      chosen = null;
    }
    try {
      const r = await getTextCoverage(transactionId, userId, chosen);
      if (r.success) {
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
      await window.api.transactions.ensureMessagesCoverage(userId, auditStart, transactionId);
    } finally {
      setUpdating(false);
      await load();
    }
  }, [auditStart, load, transactionId, userId]);

  if (gaps.length === 0) return null;
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
            {gapLine(g, auditStart)} {ACTION[g.source]}
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
