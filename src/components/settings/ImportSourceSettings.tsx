/**
 * ImportSourceSettings Component
 *
 * Allows users to choose where their TEXT MESSAGES are imported from:
 * - macOS Messages database (native) [macOS only]
 * - Connected iPhone via iTunes backup (sync)
 * - Android with Google Messages (BACKLOG-3659)
 *
 * Only one import source is active at a time (radio button pattern).
 *
 * SR clean-up C6 (founder): the Android Companion is no longer offered. A
 * stored "android-companion" shows as Google Messages (shownImportSource) and
 * is not rewritten until the user picks a source here.
 *
 * BACKLOG-2523: this panel governs `messages.source` and NOTHING else.
 * Contact sources are the independent `contactSources.direct.*` checkboxes
 * under Settings > Contacts — BACKLOG-2477 removed the coupling, so any copy
 * here promising a contacts effect is a false claim about the user's data.
 *
 * @module settings/ImportSourceSettings
 */

import React, { useState, useEffect, useCallback } from "react";
import { usePlatform } from "../../contexts/PlatformContext";
import type { ImportSource, UserPreferences } from "../../services/settingsService";
import { settingsService } from '../../services';
import logger from '../../utils/logger';
import { IMPORT_SOURCE_LABELS, shownImportSource } from "./importSourceLabels";
import { loadChosenImportSource } from "../../services/importSourcePolicy";
import { WindowsArm64Unsupported } from "../iphone/WindowsArm64Unsupported";
import { ConnectionControl } from "./ConnectionControl";
import { FORGET_ASK, useGoogleMessagesLink } from "./android/googleMessagesLink";
import { CHECKING_BROWSER } from "./android/browserLinkState";
import { rcsImportService } from "../../services/rcsImportService";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "never";
}

/**
 * BACKLOG-3156 stage G: a click inside one of these does not select the
 * Android row — the kebab, its menu, Link, the Unlink confirm and the
 * connection-details disclosure act on the link, not on the source.
 */
export const ROW_CLICK_IGNORE = "button,summary,details,[role=menu],[role=alert],label,input";

// Re-export type for consumers
export type { ImportSource } from "../../services/settingsService";

interface ImportSourceSettingsProps {
  userId: string;
  /** Callback when the user changes the import source (BACKLOG-1458) */
  onSourceChange?: (source: ImportSource) => void;
  /**
   * BACKLOG-3156 stage G: Link / Relink on the Android row open the SAME Sync
   * Android modal the dashboard opens (Settings closes), at its link step.
   */
  onLinkGoogleMessages?: () => void;
}

/**
 * Import source settings.
 * Allows switching between macOS native import, iPhone sync, and Google Messages.
 */
export function ImportSourceSettings({ userId, onSourceChange, onLinkGoogleMessages }: ImportSourceSettingsProps) {
  const { isMacOS, isWindowsArm64 } = usePlatform();
  // BACKLOG-3418: `null` = the user has chosen no source, so no radio is
  // checked (Windows/Linux). Clicking "iPhone Sync" is then a real change that
  // saves the choice and turns iPhone checking on — before, it was pre-checked
  // and clicking it did nothing.
  const [source, setSource] = useState<ImportSource | null>(isMacOS ? "macos-native" : null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // BACKLOG-3156 stage G: the Android row's link control reads the one shared
  // link state (android/googleMessagesLink), the same the Google pane reads.
  const link = useGoogleMessagesLink();
  const [unlinkAsk, setUnlinkAsk] = useState(false);

  // Load preference on mount, falling back to phoneType-based default
  useEffect(() => {
    if (!userId) return;

    const loadPreference = async () => {
      setLoading(true);
      try {
        const result = await window.api.preferences.get(userId);
        const prefs = result.success
          ? (result.preferences as UserPreferences | undefined)
          : undefined;
        // BACKLOG-1458 / BACKLOG-3418: the one shared derivation
        // (importSourcePolicy `chosenImportSource`), so this radio, Settings,
        // the Dashboard button and iPhone detection agree.
        const chosen = await loadChosenImportSource(
          prefs as Parameters<typeof loadChosenImportSource>[0],
          isMacOS,
          () => settingsService.getPhoneType(userId),
        );
        setSource(chosen ? shownImportSource(chosen) : null);
      } catch (error) {
        logger.error("[ImportSourceSettings] Failed to load preference:", error);
      } finally {
        setLoading(false);
      }
    };

    loadPreference();
  }, [userId, isMacOS]);

  const handleSourceChange = useCallback(
    async (newSource: ImportSource) => {
      if (!userId || saving) return;

      setSource(newSource);
      setSaving(true);

      try {
        await window.api.preferences.update(userId, {
          messages: {
            source: newSource,
          },
        });
        // BACKLOG-1458: Notify parent of source change for adaptive Messages section
        onSourceChange?.(newSource);
      } catch (error) {
        logger.error("[ImportSourceSettings] Failed to save preference:", error);
        // Revert on error
        setSource(source);
      } finally {
        setSaving(false);
      }
    },
    [userId, source, saving, onSourceChange]
  );

  return (
    /*
      BACKLOG-3156 stage C — MESSAGES GETS THE `Sources` BLOCK THE OTHER TWO
      SECTIONS HAVE.

      Emails and Contacts each open with a `Sources` eyebrow above their source
      cards; the Messages section had the card and not the eyebrow, so the one
      shape the redesign promised did not reach it. The eyebrow lives HERE
      rather than inside either message panel because this picker IS the
      Messages section's source control and `Settings.tsx` renders it above
      BOTH panels — the macOS one and the Android one — so a copy in each would
      be the drift this item exists to undo, and would print the word twice
      whenever the Android panel is showing.

      `Settings.test.tsx` asserts the resulting order (sources -> preferences ->
      actions) against the real composition in `Settings.tsx`, not against a
      fixture assembled by the test.
    */
    <div
      data-testid="messages-block-sources"
      className="p-4 bg-gray-50 rounded-lg border border-gray-200"
    >
      {/* BACKLOG-3156 stage E: the block IS the card. The eyebrow is its first
          child and the description is the line beneath it, in the slot
          `<h4>Import Source</h4>` used to occupy — that heading said the same
          thing as the eyebrow one line above it, which is the doubling this
          stage removes. */}
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
        Sources
      </p>
      <p className="text-xs text-gray-600 mb-3">
        Choose where to import your text messages from.
      </p>


      {loading ? (
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {/* Radio: macOS Messages (macOS only)
                BACKLOG-2523: this radio governs MESSAGES only. Mac contacts
                answer to the `macosContacts` checkbox under Settings > Contacts
                regardless of what is selected here — see BACKLOG-2477 and the
                comment on SyncOrchestratorService.getContactsSyncPreferences. */}
            {isMacOS && (
              <label
                className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                  source === "macos-native"
                    ? "border-blue-500 ring-1 ring-blue-500"
                    : "border-gray-200 hover:border-gray-300"
                } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <input
                  type="radio"
                  name="importSource"
                  value="macos-native"
                  checked={source === "macos-native"}
                  onChange={() => handleSourceChange("macos-native")}
                  disabled={saving}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    {IMPORT_SOURCE_LABELS["macos-native"]}
                  </div>
                  <div className="text-xs text-gray-500">
                    Import text messages from your Mac's Messages app
                  </div>
                </div>
              </label>
            )}

            {/* Radio: iPhone Sync. BACKLOG-3156 stage G: its "To use iPhone
                Sync" steps (or, on Windows on ARM, why it cannot work —
                BACKLOG-3363) sit INSIDE this card, only while it is selected. */}
            <label
              className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                source === "iphone-sync"
                  ? "border-blue-500 ring-1 ring-blue-500"
                  : "border-gray-200 hover:border-gray-300"
              } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <input
                type="radio"
                name="importSource"
                value="iphone-sync"
                checked={source === "iphone-sync"}
                onChange={() => handleSourceChange("iphone-sync")}
                disabled={saving}
                className="mt-0.5 w-5 h-5"
              />
              <div>
                <div className="text-sm font-medium text-gray-900">
                  {IMPORT_SOURCE_LABELS["iphone-sync"]}
                </div>
                <div className="text-xs text-gray-500">
                  Sync from a connected iPhone{isMacOS ? " (same as Windows experience)" : " via backup"}
                </div>
                {source === "iphone-sync" && isWindowsArm64 && (
                  <div className="mt-2">
                    <WindowsArm64Unsupported variant="compact" />
                  </div>
                )}
                {source === "iphone-sync" && !isWindowsArm64 && (
                  <div className="mt-2 p-3 bg-blue-50 rounded text-xs text-blue-700" data-testid="iphone-sync-steps">
                    <p className="font-medium mb-1">To use iPhone Sync:</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Connect your iPhone to this {isMacOS ? "Mac" : "PC"} via USB</li>
                      <li>Trust this computer on your iPhone if prompted</li>
                      <li>Click "Import from iPhone" to sync messages</li>
                    </ol>
                  </div>
                )}
              </div>
            </label>

            {/* Android with Google Messages (BACKLOG-3659). BACKLOG-3156 stage G:
                the row carries the email-style connection control, so it is a
                div with the radio in a nested label — a click on the control,
                its menu, the Unlink confirm or the details disclosure must not
                select this source (ROW_CLICK_IGNORE). A click anywhere else on
                the row selects it, like the label rows above. */}
            <div
              data-testid="import-source-android-row"
              onClick={(e) => {
                if (saving || source === "android-messages-web") return;
                const target = e.target as Element | null;
                if (target?.closest?.(ROW_CLICK_IGNORE)) return;
                void handleSourceChange("android-messages-web");
              }}
              className={`p-3 bg-white rounded border cursor-pointer transition-all ${
                source === "android-messages-web"
                  ? "border-blue-500 ring-1 ring-blue-500"
                  : "border-gray-200 hover:border-gray-300"
              } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="importSource"
                    value="android-messages-web"
                    checked={source === "android-messages-web"}
                    onChange={() => handleSourceChange("android-messages-web")}
                    disabled={saving}
                    className="mt-0.5 w-5 h-5"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {IMPORT_SOURCE_LABELS["android-messages-web"]}
                    </div>
                    <div className="text-xs text-gray-500">
                      Includes RCS chats. Keepr reads them through a small Chrome extension.
                    </div>
                  </div>
                </label>
                <div className="shrink-0">
                  <ConnectionControl
                    state={link.linkView === "checking" ? "checking" : link.linkView === "linked" ? "connected" : "disconnected"}
                    testIdBase="gm-connection"
                    checkingContent={
                      <span className="inline-flex items-center gap-2" role="status">
                        <span className="w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                        {CHECKING_BROWSER}
                      </span>
                    }
                    connectLabel="Link"
                    onConnect={() => onLinkGoogleMessages?.()}
                    connectDisabled={!onLinkGoogleMessages}
                    menuAriaLabel="Google Messages connection options"
                    menuItems={[
                      {
                        label: "Relink",
                        ariaLabel: "Relink Google Messages",
                        onSelect: () => onLinkGoogleMessages?.(),
                        testId: "gm-connection-relink",
                        disabled: !onLinkGoogleMessages,
                      },
                      {
                        label: "Unlink",
                        ariaLabel: "Unlink Google Messages",
                        onSelect: () => setUnlinkAsk(true),
                        testId: "gm-connection-unlink",
                        tone: "destructive",
                      },
                    ]}
                  />
                </div>
              </div>

              {unlinkAsk && (
                <div className="flex items-center justify-between gap-3 mt-2 ml-8" role="alert" data-testid="gm-forget-confirm">
                  <span className="text-sm text-gray-900">{FORGET_ASK}</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-sm text-indigo-700 hover:text-indigo-900 font-medium"
                      onClick={() => setUnlinkAsk(false)}
                      data-testid="gm-forget-cancel"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all"
                      onClick={() => {
                        setUnlinkAsk(false);
                        void rcsImportService.linkForget().then(() => link.refresh());
                      }}
                      data-testid="gm-forget-yes"
                    >
                      Unlink
                    </button>
                  </div>
                </div>
              )}

              {/* Today's diagnostic lines, collapsed; only while Android is the
                  selected source (founder approved 2026-10-13). */}
              {source === "android-messages-web" && (
                <details className="group mt-2 ml-8" data-testid="gm-connection-details">
                  <summary className="list-none [&::-webkit-details-marker]:hidden text-xs text-indigo-700 hover:text-indigo-900 font-medium inline-flex items-center gap-1 cursor-pointer">
                    <span className="inline-block text-[10px] transition-transform group-open:rotate-90" aria-hidden="true">&#9654;</span> Show connection details
                  </summary>
                  <div className="mt-2 space-y-1 text-sm text-gray-700">
                    {link.loading ? (
                      <div className="text-xs text-gray-500">Loading…</div>
                    ) : (
                      <>
                        <div data-testid="gm-settings-extension">
                          Keepr extension: {link.state?.extensionVersion ? `installed (version ${link.state.extensionVersion})` : "not installed yet"}
                        </div>
                        <div>Google Messages connected: {link.state?.pairedAt ? "yes" : "not yet"}</div>
                        <div>Last sync: {formatWhen(link.state?.lastCacheFinishedAt)}</div>
                        <p className="text-xs text-gray-600 pt-1">To sync, click Sync Android on the dashboard.</p>
                      </>
                    )}
                  </div>
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ImportSourceSettings;
