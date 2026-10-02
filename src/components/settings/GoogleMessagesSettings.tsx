/**
 * Settings → Messages → Android: Google Messages (BACKLOG-3659 P3d).
 *
 * Shown when the import source is "android-messages-web" (Keepr's Chrome
 * extension on Google Messages for Web). The Android companion app has its
 * own section (AndroidMessagesSettings) with its own reset.
 *
 * - Status: the extension (installed / version), Google Messages paired, the
 *   last Sync. (No consent line: users accept Keepr's terms at sign-up; the
 *   first Sync records the consent for audit.)
 * - How far back a Sync copies (the months control, shared with the macOS
 *   section). Written to `messageImport.filters` — the key the cache Sync's
 *   floor actually reads (importPlanInputs.loadStoredImportFilters); the
 *   companion's `messageImport.android` namespace is not read by it.
 * - Auto-delete (BACKLOG-3658 P3b; off by default, 90 days when on).
 * - Force re-import: Android's SHARED reset (BACKLOG-3657) — every text
 *   imported from Google Messages AND from the Android Companion (one
 *   confirmation naming both, AndroidForceReimportWarning).
 * - Chats not synced (BACKLOG-3658 P3c): the chats switched off with the eye
 *   on their row in Google Messages, each with "Sync again", and "Sync all
 *   again" (after a confirmation). The keyboard alternative to the page's
 *   eye. Titles shown here stay in Keepr (never sent to the page).
 */

import React, { useCallback, useEffect, useState } from "react";
import { rcsImportService } from "../../services/rcsImportService";
import { settingsService } from "../../services";
import { LookbackMonthsSelect, parseLookbackOption } from "./LookbackMonthsSelect";
import { AndroidForceReimportWarning, androidClearedText } from "./AndroidForceReimportWarning";
import { readMessageImportPreferences, resolveStoredLookbackMonths } from "./messageImportPreferences";

import { GM_LOOKBACK_TARGET } from "./android/googleMessagesSyncSteps";
import type { RcsExtensionState } from "../../../electron/types/ipc/window-api-rcs-import";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "never";
}

export function GoogleMessagesSettings({ userId }: { userId: string }) {
  const [state, setState] = useState<RcsExtensionState | null>(null);
  const [lookbackMonths, setLookbackMonths] = useState<number | null>(resolveStoredLookbackMonths(undefined));
  const [prefsSettled, setPrefsSettled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForceWarning, setShowForceWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [excluded, setExcluded] = useState<Array<{ id: string; title: string | null }>>([]);
  const [confirmAll, setConfirmAll] = useState(false);

  const refreshExcluded = useCallback(async () => {
    const r = await rcsImportService.listExclusions();
    if (r.success && r.data) setExcluded(r.data);
  }, []);

  const refresh = useCallback(async () => {
    const r = await rcsImportService.getExtensionState();
    if (r.success && r.data) setState(r.data);
    setLoading(false);
    await refreshExcluded();
  }, [refreshExcluded]);

  // The stored window (absent key → the default, null → All time).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await settingsService.getPreferences(userId);
        if (live && r?.success) setLookbackMonths(resolveStoredLookbackMonths(readMessageImportPreferences(r.data)?.filters));
      } catch {
        // The default stays.
      } finally {
        if (live) setPrefsSettled(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  // Saved where the cache Sync reads it; reverted when the save fails.
  const changeLookback = useCallback(async (value: string) => {
    const months = parseLookbackOption(value);
    const previous = lookbackMonths;
    setLookbackMonths(months);
    let saved = false;
    try {
      const r = await settingsService.updatePreferences(userId, { messageImport: { filters: { lookbackMonths: months } } });
      saved = r?.success !== false;
    } catch {
      saved = false;
    }
    if (!saved) {
      setLookbackMonths(previous);
      setResult({ ok: false, text: "Keepr could not save that." });
    }
  }, [userId, lookbackMonths]);

  useEffect(() => {
    void refresh();
    // A chat switched off (or on) with the eye on the page.
    return rcsImportService.onDataChanged(() => void refreshExcluded());
  }, [refresh, refreshExcluded]);

  const syncAgain = useCallback(async (id: string) => {
    const r = await rcsImportService.removeExclusion({ id });
    if (!r.success) setResult({ ok: false, text: r.error ?? "Keepr could not save that." });
    await refreshExcluded();
  }, [refreshExcluded]);

  const syncAllAgain = useCallback(async () => {
    setConfirmAll(false);
    const r = await rcsImportService.removeExclusion({ all: true });
    if (!r.success) setResult({ ok: false, text: r.error ?? "Keepr could not save that." });
    await refreshExcluded();
  }, [refreshExcluded]);

  const toggleAutoDelete = useCallback(async (on: boolean) => {
    const r = await rcsImportService.setCacheAutoDelete(on);
    if (!r.success) setResult({ ok: false, text: r.error ?? "Keepr could not save that." });
    await refresh();
  }, [refresh]);

  const forceReimport = useCallback(async () => {
    setShowForceWarning(false);
    setBusy(true);
    setResult(null);
    const r = await rcsImportService.clearTexts();
    setBusy(false);
    setResult(
      r.success
        ? {
            ok: true,
            text: androidClearedText({
              gmwebMessages: r.data?.messagesDeleted ?? 0,
              companionMessages: r.data?.androidMessagesDeleted ?? 0,
              contacts: r.data?.contactsDeleted ?? 0,
            }),
          }
        : { ok: false, text: r.error ?? "Nothing was cleared." },
    );
    await refresh();
  }, [refresh]);

  return (
    <div id="settings-google-messages" className="space-y-4" data-testid="google-messages-settings">
      <div className="p-4 bg-white rounded-lg border border-gray-200 space-y-1 text-sm text-gray-700">
        {loading ? (
          <div className="text-xs text-gray-500">Loading…</div>
        ) : (
          <>
            <div data-testid="gm-settings-extension">
              Keepr extension: {state?.extensionVersion ? `installed (version ${state.extensionVersion})` : "not installed yet"}
            </div>
            <div>Google Messages connected: {state?.pairedAt ? "yes" : "not yet"}</div>
            <div>Last sync: {formatWhen(state?.lastCacheFinishedAt)}</div>
            <p className="text-xs text-gray-600 pt-1">To sync, click Sync Android on the dashboard.</p>
          </>
        )}
      </div>

      <div id={GM_LOOKBACK_TARGET} className="p-4 bg-white rounded-lg border border-gray-200" data-testid="gm-lookback">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600">Import messages from</span>
          <LookbackMonthsSelect
            value={lookbackMonths}
            onChange={(v) => void changeLookback(v)}
            disabled={!prefsSettled}
            aria-label="Import messages from"
          />
        </div>
        <p className="text-xs text-blue-600 mt-2" data-testid="gm-lookback-line">
          {lookbackMonths === null ? "Copying all your texts" : `Copying texts from the last ${lookbackMonths} months`}
        </p>
      </div>

      <div className="p-4 bg-white rounded-lg border border-gray-200" data-testid="gm-not-synced">
        <div className="text-sm font-medium text-gray-900">
          {excluded.length === 0
            ? "Every chat is synced"
            : `${excluded.length} chat${excluded.length === 1 ? "" : "s"} not synced`}
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Switch a chat off with the eye on its row in Google Messages. New messages from it won&rsquo;t be synced;
          texts already in Keepr stay.
        </p>
        {excluded.length > 0 && (
          <ul className="mt-2 divide-y divide-gray-100">
            {excluded.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm text-gray-800">
                <span>{c.title ?? "A chat you switched off in Google Messages"}</span>
                <button
                  type="button"
                  className="text-indigo-700 hover:text-indigo-900 text-xs font-medium"
                  onClick={() => void syncAgain(c.id)}
                >
                  Sync again
                </button>
              </li>
            ))}
          </ul>
        )}
        {excluded.length > 1 && !confirmAll && (
          <button type="button" className="mt-2 text-xs font-medium text-indigo-700 hover:text-indigo-900" onClick={() => setConfirmAll(true)}>
            Sync all again
          </button>
        )}
        {confirmAll && (
          <div className="mt-2 p-2 rounded border border-amber-300 bg-amber-50 text-xs text-amber-800">
            New messages from all {excluded.length} chats will be synced again from the next Sync.
            <div className="flex gap-2 mt-2">
              <button type="button" className="px-2 py-1 rounded bg-amber-600 text-white font-medium" onClick={() => void syncAllAgain()}>
                Sync all again
              </button>
              <button type="button" className="px-2 py-1 rounded border border-gray-300 bg-white text-gray-700" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <label className="flex items-start gap-3 p-4 bg-white rounded-lg border border-gray-200 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 w-5 h-5"
          checked={!!state?.autoDeleteDays}
          onChange={(e) => void toggleAutoDelete(e.target.checked)}
          data-testid="gm-auto-delete"
        />
        <span>
          <span className="block text-sm font-medium text-gray-900">Delete chats not linked to a transaction after 90 days</span>
          <span className="block text-xs text-gray-600">
            Off by default. When on, after each Sync Keepr deletes chats from Google Messages that are linked to no
            transaction and have had no new message for 90 days.
          </span>
        </span>
      </label>

      {result && (
        <div
          className={`text-xs rounded p-2 border ${result.ok ? "text-indigo-800 bg-indigo-50 border-indigo-200" : "text-red-700 bg-red-50 border-red-200"}`}
          role={result.ok ? "status" : "alert"}
        >
          {result.text}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowForceWarning(true)}
          disabled={busy}
          className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Clearing..." : "Force Re-import"}
        </button>
      </div>

      {showForceWarning && (
        <AndroidForceReimportWarning onConfirm={() => void forceReimport()} onCancel={() => setShowForceWarning(false)} />
      )}
    </div>
  );
}

export default GoogleMessagesSettings;
