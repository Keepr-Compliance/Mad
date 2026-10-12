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
 * - How far back a Sync copies: one line stating the window. The months
 *   control is the shared TextsLookbackSettings picker (BACKLOG-3892 S3),
 *   which Settings passes in as `lookbackPicker` and this panel renders as the
 *   first row of its Import Preferences block (BACKLOG-3156 stage F); the
 *   value is `messageImport.filters`, the key the cache Sync's floor reads.
 * - Auto-delete (BACKLOG-3658 P3b): REMOVED from the screen "for now"
 *   (founder, 2026-10-04); the purge is dormant (RCS_AUTO_DELETE_ENABLED).
 * - Force re-import: Android's SHARED reset (BACKLOG-3657) — every text
 *   imported from Google Messages AND from the Android Companion (one
 *   confirmation naming both, AndroidForceReimportWarning).
 * - Chats not synced (BACKLOG-3658 P3c): one line "N chats not synced · See hidden list";
 *   "See hidden list" opens NotSyncedChatsModal ("Hidden chats"), READ-ONLY (founder, 2026-10-02): the
 *   chats switched off with the eye on their row in Google Messages, and the
 *   hint to click the eye to sync one again. The eye is the only control.
 *   Titles shown here stay in Keepr (never sent to the page).
 */

import React, { useCallback, useEffect, useState } from "react";

/** SR M: the typical size used for the video storage estimate (a video may be up to 200 MB). */
export const VIDEO_ESTIMATE_MB = 25;

/** SR M: the storage estimate shown BEFORE videos are switched on (counts only). */
export function videoEstimateText(lastVideosSeen: number | null | undefined): string {
  if (typeof lastVideosSeen !== "number") {
    return "Keepr doesn't know yet how many videos your chats have. Sync once to see an estimate.";
  }
  const gb = (lastVideosSeen * VIDEO_ESTIMATE_MB) / 1024;
  const size = gb >= 1 ? `about ${gb.toFixed(1)} GB` : `about ${Math.max(1, Math.round(lastVideosSeen * VIDEO_ESTIMATE_MB))} MB`;
  return `Your last Sync saw ${lastVideosSeen} video${lastVideosSeen === 1 ? "" : "s"}: ${size} on this computer at ${VIDEO_ESTIMATE_MB} MB each (a video can be up to 200 MB).`;
}
import { rcsImportService } from "../../services/rcsImportService";
import { settingsService } from "../../services";
import { lastMonthsPhrase } from "./LookbackMonthsSelect";
import { AndroidForceReimportWarning, androidClearedText } from "./AndroidForceReimportWarning";
import { NotSyncedChatsModal } from "./android/NotSyncedChatsModal";
import {
  EXTENSION_PUBLISHED,
  betaInstallPreferencePatch,
  readBetaInstallPreference,
} from "./android/extensionDistribution";

/** The link row's status (founder 2026-10-04): "Linked" / "Not linked". */
export const LINK_STATUS = { linked: "Linked", notLinked: "Not linked" } as const;
/** SR: Forget link asks first, worded as the popup's Unlink (popup.js COPY.unlinkAsk). */
export const FORGET_ASK = "Unlink from Keepr? You'll need to link again to sync";
/** SR (C7 review): Withdraw consent asks first, in one line. A Sync already running is not stopped. */
export const WITHDRAW_ASK = "Syncing stops. Texts already in Keepr stay.";
import { useTextsLookback } from "./textsLookback";
import { browserLinkView, CHECKING_BROWSER, LINK_CHECK_MS, useLinkCheckOver } from "./android/browserLinkState";
import type { RcsExtensionState } from "../../../electron/types/ipc/window-api-rcs-import";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "never";
}

interface GoogleMessagesSettingsProps {
  userId: string;
  /**
   * Founder (2026-10-04): Link / Relink open the SAME Sync Android modal the
   * dashboard opens (it closes Settings), at its link step.
   */
  onOpenSyncAndroid?: () => void;
  /** Test seam: the extension is in the Chrome Web Store (default EXTENSION_PUBLISHED). */
  published?: boolean;
  /** Test seam: the "Checking the browser…" window (default LINK_CHECK_MS). */
  linkCheckMs?: number;
  /**
   * BACKLOG-3156 stage F: the shared "Import messages from" picker, rendered as
   * the first row of Import Preferences. Settings supplies it while this panel
   * is mounted (Google Messages is the live source), so exactly one renders.
   */
  lookbackPicker?: React.ReactNode;
}

export function GoogleMessagesSettings({ userId, onOpenSyncAndroid, published = EXTENSION_PUBLISHED, linkCheckMs = LINK_CHECK_MS, lookbackPicker }: GoogleMessagesSettingsProps) {
  const [state, setState] = useState<RcsExtensionState | null>(null);
  // BACKLOG-3892 S3: the shared "How far back to import texts" value.
  const { months: lookbackMonths } = useTextsLookback(userId);
  /** SR: Forget link's inline confirm is open. */
  const [forgetAsk, setForgetAsk] = useState(false);
  /** Founder (J flow): the account's "Beta extension install" (default off). */
  const [betaInstall, setBetaInstall] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForceWarning, setShowForceWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [excluded, setExcluded] = useState<Array<{ id: string; title: string | null }>>([]);
  const [manageOpen, setManageOpen] = useState(false);
  // BACKLOG-3666: Pair / Re-pair the extension with this Keepr. Live
  // (0.3.76): the same rule as the Sync Android modal (browserLinkState) — a
  // saved link reads "Checking the browser…" briefly after Keepr starts, then
  // Linked.
  const linkCheckOver = useLinkCheckOver(linkCheckMs);
  const linkView = browserLinkView(state, linkCheckOver);
  const keeprPaired = linkView !== "notLinked";

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

  const [withdrawAsk, setWithdrawAsk] = useState(false);
  /** SR C7: withdraw the consent (Keepr's record); the next Sync asks again. */
  const withdrawConsent = useCallback(async () => {
    const r = await rcsImportService.setCacheConsent(null);
    if (!r.success) setResult({ ok: false, text: r.error ?? "Keepr could not save that." });
    await refresh();
  }, [refresh]);

  // The account's "Beta extension install".
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await settingsService.getPreferences(userId);
        if (live && r?.success) {
          setBetaInstall(readBetaInstallPreference(r.data));
        }
      } catch {
        // The default stays.
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  // Founder (J flow): saved with the account's other preferences; reverted on failure.
  const changeBetaInstall = useCallback(async (on: boolean) => {
    setBetaInstall(on);
    let saved = false;
    try {
      const r = await settingsService.updatePreferences(userId, betaInstallPreferencePatch(on));
      saved = r?.success !== false;
    } catch {
      saved = false;
    }
    if (!saved) {
      setBetaInstall(!on);
      setResult({ ok: false, text: "Keepr could not save that." });
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
    // A chat switched off (or on) with the eye on the page.
    return rcsImportService.onDataChanged(() => void refreshExcluded());
  }, [refresh, refreshExcluded]);

  // SR M: "Download photos / videos from all chats". Videos ask first (storage).
  const [videoConfirm, setVideoConfirm] = useState(false);
  const setMedia = useCallback(async (patch: { photosAllChats?: boolean; videosAllChats?: boolean }) => {
    const r = await rcsImportService.setMediaOptions(patch);
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

      {/* BACKLOG-3892 S3: this line states the shared months value; the
          picker itself is the first row of Import Preferences below. */}
      <div className="p-4 bg-white rounded-lg border border-gray-200" data-testid="gm-lookback">
        <p className="text-xs text-blue-600" data-testid="gm-lookback-line">
          {lookbackMonths === null ? "Copying all your texts" : `Copying texts from ${lastMonthsPhrase(lookbackMonths)}`}
        </p>
      </div>

      {/* Founder (2026-10-04): Settings hosts no copy of a flow screen — one
          row in this screen's style: the status, and Link / Relink, which
          open the Sync Android modal at its link step (a new link replaces
          the old one only once its code succeeds). */}
      <div className="p-4 bg-white rounded-lg border border-gray-200" data-testid="gm-pairing">
        {forgetAsk && (
          <div className="flex items-center justify-between gap-3 mb-3" role="alert" data-testid="gm-forget-confirm">
            <span className="text-sm text-gray-900">{FORGET_ASK}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-sm text-indigo-700 hover:text-indigo-900 font-medium"
                onClick={() => setForgetAsk(false)}
                data-testid="gm-forget-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => {
                  setForgetAsk(false);
                  void rcsImportService.linkForget().then(refresh);
                }}
                data-testid="gm-forget-yes"
              >
                Forget link
              </button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-900" data-testid="gm-pairing-line">
            {linkView === "checking" ? (
              <span className="inline-flex items-center gap-2" role="status" data-testid="gm-pairing-checking">
                <span className="w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                {CHECKING_BROWSER}
              </span>
            ) : keeprPaired ? LINK_STATUS.linked : LINK_STATUS.notLinked}
          </span>
          <div className="flex items-center gap-3">
            {keeprPaired && !forgetAsk && (
              <button
                type="button"
                className="text-sm text-indigo-700 hover:text-indigo-900 font-medium"
                onClick={() => setForgetAsk(true)}
                data-testid="gm-link-forget"
              >
                Forget link
              </button>
            )}
            {onOpenSyncAndroid && (
              <button
                type="button"
                onClick={() => onOpenSyncAndroid()}
                className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="gm-link-open"
              >
                {keeprPaired ? "Relink" : "Link"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* BACKLOG-3156 stage F: ONE Import Preferences block in the shared
          settings shape — the label is the card's first child, every setting
          below it is a row (no card inside the card). Founder's order:
          Import messages from, the per-chat eye note, consent, photos, videos. */}
      <div
        data-testid="gm-block-preferences"
        className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      >
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Import Preferences
        </p>
        {lookbackPicker}

        {/* Founder (2026-10-02): one line + "See hidden list" (a read-only modal), never a list
            that fills the page. 0 → no line. */}
        <div className="mt-3" data-testid="gm-not-synced">
          {excluded.length > 0 && (
            <div className="text-sm font-medium text-gray-900" data-testid="gm-not-synced-line">
              {excluded.length} chat{excluded.length === 1 ? "" : "s"} not synced ·{" "}
              <button
                type="button"
                className="text-indigo-700 hover:text-indigo-900 font-medium"
                onClick={() => setManageOpen(true)}
              >
                See hidden list
              </button>
            </div>
          )}
          <p className="text-xs text-gray-600 mt-1">
            Switch a chat off with the eye on its row in Google Messages. New messages from it won&rsquo;t be synced;
            texts already in Keepr stay.
          </p>
        </div>

        {/* SR C7 (founder): the consent given before the first Sync, withdrawn
            here — the next Sync asks again. Shown only while it is current. */}
        {state?.optedIn === true && (
          <div className="mt-3 flex items-center justify-between gap-3" data-testid="gm-consent">
            {withdrawAsk ? (
              <>
                <span className="text-sm text-gray-900" role="alert" data-testid="gm-consent-ask">
                  {WITHDRAW_ASK}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded"
                    onClick={() => {
                      setWithdrawAsk(false);
                      void withdrawConsent();
                    }}
                    data-testid="gm-consent-withdraw-yes"
                  >
                    Withdraw
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 text-sm font-medium rounded border border-gray-300"
                    onClick={() => setWithdrawAsk(false)}
                    data-testid="gm-consent-withdraw-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-sm text-gray-900">You agreed to copy your texts into Keepr.</span>
                <button
                  type="button"
                  className="text-sm text-indigo-700 hover:text-indigo-900 font-medium"
                  onClick={() => setWithdrawAsk(true)}
                  data-testid="gm-consent-withdraw"
                >
                  Withdraw consent
                </button>
              </>
            )}
          </div>
        )}

        {/* Founder (J flow): the beta (unpacked) install of the extension.
            Founder (2026-10-04): HIDDEN until the extension is in the Chrome
            Web Store — until then every account gets the beta (forced), so a
            switch that cannot be changed is not shown. */}
        {published && (
          <label className="mt-3 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 w-5 h-5"
              checked={betaInstall}
              onChange={(e) => void changeBetaInstall(e.target.checked)}
              data-testid="gm-beta-install"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Beta extension install</span>
            </span>
          </label>
        )}

        {/* BACKLOG-3658 P3b — "Delete chats not linked to a transaction after
            90 days": REMOVED from the screen "for now" (founder, 2026-10-04).
            The purge is dormant: RCS_AUTO_DELETE_ENABLED (rcsImportHandlers) is
            off, so a stored ON value does nothing. */}

        {/* SR M: media from chats with no transaction contact. Photos ON, videos OFF by default. */}
        <label className="mt-3 flex items-start gap-3 cursor-pointer" data-testid="gm-photos-row">
          <input
            type="checkbox"
            className="mt-0.5 w-5 h-5"
            checked={state?.media ? state.media.photosAllChats : true}
            onChange={(e) => void setMedia({ photosAllChats: e.target.checked })}
            data-testid="gm-photos-all"
          />
          <span>
            <span className="block text-sm font-medium text-gray-900">Download photos from all chats</span>
            <span className="block text-xs text-gray-600">
              On: photos are saved for every chat in the period. Off: only for chats with a transaction contact.
            </span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-3 cursor-pointer" data-testid="gm-videos-row">
          <input
            type="checkbox"
            className="mt-0.5 w-5 h-5"
            checked={!!state?.media?.videosAllChats}
            onChange={(e) => {
              if (e.target.checked) setVideoConfirm(true);
              else void setMedia({ videosAllChats: false });
            }}
            data-testid="gm-videos-all"
          />
          <span>
            <span className="block text-sm font-medium text-gray-900">Download videos from all chats</span>
            <span className="block text-xs text-gray-600">
              Off by default. Videos take much more space than photos.
            </span>
          </span>
        </label>
        {videoConfirm && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-300 rounded" role="alert" data-testid="gm-videos-confirm">
            <p className="text-xs text-amber-800" data-testid="gm-videos-estimate">{videoEstimateText(state?.media?.lastVideosSeen)}</p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded"
                onClick={() => {
                  setVideoConfirm(false);
                  void setMedia({ videosAllChats: true });
                }}
              >
                Turn on videos
              </button>
              <button
                type="button"
                className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 text-xs font-medium rounded border border-gray-300"
                onClick={() => setVideoConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {manageOpen && (
        <NotSyncedChatsModal
          chats={excluded}
          onClose={() => setManageOpen(false)}
        />
      )}


      {result && (
        <div
          className={`text-xs rounded p-2 border ${result.ok ? "text-indigo-800 bg-indigo-50 border-indigo-200" : "text-red-700 bg-red-50 border-red-200"}`}
          role={result.ok ? "status" : "alert"}
        >
          {result.text}
        </div>
      )}

      <div data-testid="gm-block-actions">
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
        <AndroidForceReimportWarning
          windowMonths={lookbackMonths}
          companion={state?.companionData === true}
          onConfirm={() => void forceReimport()}
          onCancel={() => setShowForceWarning(false)}
        />
      )}
    </div>
  );
}

export default GoogleMessagesSettings;
