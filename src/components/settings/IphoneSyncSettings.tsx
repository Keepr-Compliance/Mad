/**
 * IphoneSyncSettings — iPhone-over-USB detection opt-in (BACKLOG-1706)
 *
 * Renders a toggle that enables/disables iPhone cable-sync detection. Backed by
 * the IPhoneSyncEnabledContext, so flipping it starts/stops device detection
 * live (no app restart) and persists `integrations.iphoneSyncEnabled`.
 *
 * On macOS this defaults OFF (opt-in); on Windows it stays ON to preserve the
 * existing primary import path. The toggle reflects and controls that state.
 *
 * BACKLOG-3156 stage F: the panel is ONE Import Preferences block in the shared
 * settings shape (label first, controls below), holding "Import messages from"
 * (supplied by Settings while iPhone is the live source) and the toggle.
 *
 * @module settings/IphoneSyncSettings
 */

import React from "react";
import { useIPhoneSyncEnabled } from "../../contexts/IPhoneSyncContext";

interface IphoneSyncSettingsProps {
  /**
   * BACKLOG-1937: When true the toggle is grayed out and non-interactive
   * (import source is not iPhone). The persisted value is NOT changed —
   * only interaction is blocked.
   */
  disabled?: boolean;
  /**
   * BACKLOG-3156 stage F: the shared "Import messages from" picker, rendered as
   * the first row of Import Preferences. Settings supplies it only while iPhone
   * is the live source, so exactly one picker renders on the page.
   */
  lookbackPicker?: React.ReactNode;
}

export function IphoneSyncSettings({ disabled = false, lookbackPicker }: IphoneSyncSettingsProps) {
  const { enabled, setIphoneSyncEnabled } = useIPhoneSyncEnabled();

  return (
    // The greyed state sits on a wrapper, so the block keeps the one card
    // class string every settings block shares (same pattern as the macOS
    // panel's opacity wrapper).
    <div className={disabled ? "opacity-50" : ""}>
      <div
        data-testid="iphone-block-preferences"
        className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      >
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Import Preferences
        </p>
        {lookbackPicker}
        <div
          data-testid="iphone-usb-toggle-row"
          className={`flex items-center justify-between${lookbackPicker ? " mt-3" : ""}`}
        >
          <div className="flex-1">
            <p className={`text-sm font-medium ${disabled ? "text-gray-400" : "text-gray-900"}`}>
              iPhone Sync (USB)
            </p>
            <p className={`text-xs mt-1 ${disabled ? "text-gray-400" : "text-gray-600"}`}>
              Automatically detect a connected iPhone so you can import messages over USB.
              When off, Keepr won&apos;t look for iPhones in the background.
            </p>
          </div>
          <button
            onClick={() => {
              if (disabled) return;
              void setIphoneSyncEnabled(!enabled);
            }}
            disabled={disabled}
            className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              enabled ? "bg-blue-500" : "bg-gray-300"
            }`}
            role="switch"
            aria-checked={enabled}
            aria-label="Enable iPhone sync over USB"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

export default IphoneSyncSettings;
