/**
 * Settings → Messages → Android: Google Messages (BACKLOG-3659 P3d).
 *
 * Shown when the import source is "android-messages-web" (Keepr's Chrome
 * extension on Google Messages for Web). The Android companion app has its
 * own section (AndroidMessagesSettings) with its own reset.
 *
 * - Status: the extension (installed / version), Google Messages paired, the
 *   last Sync, the consent (and Withdraw).
 * - Auto-delete (BACKLOG-3658 P3b; off by default, 90 days when on).
 * - Force re-import: deletes every text imported from Google Messages; the
 *   next Sync (Dashboard → Sync Android) copies them again.
 * - Chats not synced (BACKLOG-3658 P3c): the chats switched off with the eye
 *   on their row in Google Messages, each with "Sync again", and "Sync all
 *   again" (after a confirmation). The keyboard alternative to the page's
 *   eye. Titles shown here stay in Keepr (never sent to the page).
 */

import React, { useCallback, useEffect, useState } from "react";
import { rcsImportService } from "../../services/rcsImportService";
import type { RcsExtensionState } from "../../../electron/types/ipc/window-api-rcs-import";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "never";
}

export function GoogleMessagesSettings() {
  const [state, setState] = useState<RcsExtensionState | null>(null);
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

  const withdraw = useCallback(async () => {
    const r = await rcsImportService.setCacheConsent(null);
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
            text: `Cleared ${(r.data?.messagesDeleted ?? 0).toLocaleString()} texts imported from Google Messages. Click Sync Android on the dashboard to import them again.`,
          }
        : { ok: false, text: r.error ?? "Nothing was cleared." },
    );
    await refresh();
  }, [refresh]);

  const consentGiven = typeof state?.consentVersion === "number" && state.consentVersion >= (state.consentRequired ?? 1);

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
            <div data-testid="gm-settings-consent">
              Copying your texts: {consentGiven ? `agreed ${formatWhen(state?.consentAt)}` : "not agreed yet (asked before the first Sync)"}
              {consentGiven && (
                <button type="button" className="ml-2 text-indigo-700 hover:text-indigo-900 text-xs font-medium" onClick={() => void withdraw()}>
                  Withdraw
                </button>
              )}
            </div>
            <p className="text-xs text-gray-600 pt-1">To sync, click Sync Android on the dashboard.</p>
          </>
        )}
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
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg">
          <p className="text-sm font-medium text-amber-800">Force re-import will delete every text imported from Google Messages</p>
          <p className="text-xs text-amber-800 mt-1">
            This deletes all texts, reactions and images Keepr copied from Google Messages, and their links to
            transactions. The next Sync copies them again from the period set in Settings → Messages. Chats you removed
            from a transaction stay removed when you sync again; you can restore them from &ldquo;Show removed&rdquo; on
            the transaction.
          </p>
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={() => void forceReimport()}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded transition-all"
            >
              Continue with Re-import
            </button>
            <button
              type="button"
              onClick={() => setShowForceWarning(false)}
              className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 text-xs font-medium rounded border border-gray-300 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default GoogleMessagesSettings;
