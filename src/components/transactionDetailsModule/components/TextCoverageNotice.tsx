/**
 * BACKLOG-3663 — the Texts tab's coverage notice: a text source (the user's
 * chosen one, or one they have texts from) that does not reach back to this
 * transaction's audit start, and what re-syncs it.
 *
 * Exact coverage (Google Messages' recorded floor, Mac's import depth) shows
 * as a warning; an APPROXIMATE one (iPhone / Android companion, read from the
 * oldest stored text) as a soft note. Never blocks anything.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { settingsService } from "../../../services/settingsService";
import { loadChosenImportSource } from "../../../services/importSourcePolicy";
import { isMacOS } from "../../../utils/platform";
import { rcsImportService } from "../../../services/rcsImportService";
import { transactionService } from "../../../services/transactionService";
import type { SourceCoverageGap, TextSource } from "../../../../electron/types/auditCoverage";
import { coverageLine, gapKey, gapLine, googleMessagesGapLine, googleMessagesOlderLine } from "./coverageCopy";
import { GetOlderTexts } from "./GetOlderTexts";
import type { BackfillResult } from "../../../../electron/types/iphoneBackfill";

// BACKLOG-3892 W: the lines live in coverageCopy.ts; re-exported for existing callers.
export { gapLine, googleMessagesGapLine, googleMessagesOlderLine };

export const ACTION: Record<TextSource, string> = {
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

/**
 * The user's stored import source as a coverage source (the Texts tab's rule; also
 * the export gate's, BACKLOG-3892 S2). null when it cannot be read. Never throws.
 */
export async function readChosenTextSource(userId: string): Promise<TextSource | null> {
  try {
    // BACKLOG-3892 R1: ONE derivation (importSourcePolicy) shared with sync detection and
    // the create prompt, so phone type counts when nothing is stored. A preferences read
    // failure still resolves through the local phone type.
    let prefs: Parameters<typeof loadChosenImportSource>[0];
    try {
      const r = await settingsService.getPreferences(userId);
      prefs = r.success ? (r.data as Parameters<typeof loadChosenImportSource>[0]) : undefined;
    } catch {
      prefs = undefined;
    }
    const onMac = isMacOS();
    const chosen = await loadChosenImportSource(prefs, onMac, () =>
      settingsService.getPhoneType(userId),
    );
    // BACKLOG-3892 W5 (founder 62129738): there is no Mac Messages source off a Mac,
    // so a stored "macos-native" names no source there (as the create dialog does).
    return dialogTextSource(chosen, onMac);
  } catch {
    return null;
  }
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

/** BACKLOG-3884: re-asks while the coverage floors are still being read. */
const PENDING_RETRY_MS = 4000;
const PENDING_RETRIES = 5;

interface TextCoverageNoticeProps {
  transactionId: string;
  userId: string;
  /** BACKLOG-3892 S6: "Get older texts" stored texts — reload the tab's texts. */
  onTextsAdded?: () => void | Promise<void>;
}

export function TextCoverageNotice({ transactionId, userId, onTextsAdded }: TextCoverageNoticeProps) {
  const [gaps, setGaps] = useState<SourceCoverageGap[]>([]);
  const [auditStart, setAuditStart] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const pendingRetriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const load = useCallback(async () => {
    const chosen = await readChosenTextSource(userId);
    try {
      // SR: through the service, never window.api from the component.
      const r = await transactionService.getTextCoverage(transactionId, userId, chosen);
      if (r && r.success && r.pending) {
        // BACKLOG-3884: the floors are still being read off the main thread. Unknown
        // is not "covered": keep what is shown and ask again shortly (bounded).
        if (mountedRef.current && pendingRetriesRef.current < PENDING_RETRIES) {
          pendingRetriesRef.current += 1;
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => void loadRef.current(), PENDING_RETRY_MS);
        }
        return;
      }
      if (r && r.success) {
        pendingRetriesRef.current = 0;
        // BACKLOG-3892 W5: never a Mac line off a Mac.
        setGaps(isMacOS() ? r.gaps : r.gaps.filter((g) => g.source !== "mac"));
        setAuditStart(r.auditStartISO);
      }
    } catch {
      // A coverage read failing never shows anything.
    }
  }, [transactionId, userId]);
  loadRef.current = load;

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

  // BACKLOG-3892 S6: after "Get older texts", re-read coverage (with the chosen source,
  // inside load) so the warning updates, and reload the texts it stored.
  const onTextsAddedRef = useRef(onTextsAdded);
  onTextsAddedRef.current = onTextsAdded;
  const afterBackfill = useCallback(
    async (r: BackfillResult) => {
      await load();
      if (r.messagesStored > 0) await onTextsAddedRef.current?.();
    },
    [load],
  );

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
        {gaps.map((g, i) => (
          <li key={gapKey(g)} data-testid={`coverage-gap-${gapKey(g)}`}>
            {coverageLine(g, auditStart, ACTION[g.source])}
            {/* BACKLOG-3892 S6: the iPhone start gap can be filled from the kept backup. */}
            {g.source === "iphone" && g.kind === "later" && (
              <GetOlderTexts transactionId={transactionId} refreshKey={g.coveredSince ?? ""} onSuccess={afterBackfill} onRefused={load} />
            )}
            {/* One "Update Mac messages" button, on the last Mac line (an import heals both ends). */}
            {g.source === "mac" && !gaps.slice(i + 1).some((n) => n.source === "mac") && (
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
