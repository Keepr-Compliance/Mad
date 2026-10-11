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

// Re-export type for consumers
export type { ImportSource } from "../../services/settingsService";

interface ImportSourceSettingsProps {
  userId: string;
  /** Callback when the user changes the import source (BACKLOG-1458) */
  onSourceChange?: (source: ImportSource) => void;
}

/**
 * Import source settings.
 * Allows switching between macOS native import, iPhone sync, and Google Messages.
 */
export function ImportSourceSettings({ userId, onSourceChange }: ImportSourceSettingsProps) {
  const { isMacOS, isWindowsArm64 } = usePlatform();
  // BACKLOG-3418: `null` = the user has chosen no source, so no radio is
  // checked (Windows/Linux). Clicking "iPhone Sync" is then a real change that
  // saves the choice and turns iPhone checking on — before, it was pre-checked
  // and clicking it did nothing.
  const [source, setSource] = useState<ImportSource | null>(isMacOS ? "macos-native" : null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

            {/* Radio: iPhone Sync */}
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
              </div>
            </label>

            {/* Radio: Android with Google Messages (BACKLOG-3659) */}
            <label
              className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                source === "android-messages-web"
                  ? "border-indigo-500 ring-1 ring-indigo-500"
                  : "border-gray-200 hover:border-gray-300"
              } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
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
          </div>

          {/* Show iPhone instructions when that source is selected */}
          {/* BACKLOG-3363: Windows on ARM — no connect/Trust steps; they can't work. */}
          {source === "iphone-sync" && isWindowsArm64 && (
            <div className="mt-3">
              <WindowsArm64Unsupported variant="compact" />
            </div>
          )}
          {source === "iphone-sync" && !isWindowsArm64 && (
            <div className="mt-3 p-3 bg-blue-50 rounded text-xs text-blue-700">
              <p className="font-medium mb-1">To use iPhone Sync:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Connect your iPhone to this {isMacOS ? "Mac" : "PC"} via USB</li>
                <li>Trust this computer on your iPhone if prompted</li>
                <li>Click "Import from iPhone" to sync messages</li>
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ImportSourceSettings;
