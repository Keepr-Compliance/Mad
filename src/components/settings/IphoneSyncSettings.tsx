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
import { ToggleSwitch } from "./ToggleSwitch";
import { MessagesStoredBlock } from "./MessagesStoredBlock";

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
  /** BACKLOG-3156 stage G: whose stored iPhone texts the Stored block counts (omitted → no block). */
  userId?: string;
  /** BACKLOG-3156 stage G: "Import from iPhone" — Settings closes and the iPhone sync opens. */
  onImportIphone?: () => void;
}

export function IphoneSyncSettings({ disabled = false, lookbackPicker, userId, onImportIphone }: IphoneSyncSettingsProps) {
  const { enabled, setIphoneSyncEnabled } = useIPhoneSyncEnabled();

  return (
    // The greyed state sits on a wrapper, so the block keeps the one card
    // class string every settings block shares (same pattern as the macOS
    // panel's opacity wrapper).
    <div className={`space-y-4${disabled ? " opacity-50" : ""}`}>
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
          <ToggleSwitch
            className="ml-4"
            checked={enabled}
            onChange={(next) => void setIphoneSyncEnabled(next)}
            disabled={disabled}
            ariaLabel="Enable iPhone sync over USB"
          />
        </div>
      </div>
      {/* BACKLOG-3156 stage G: blocks 3 and 4 of the iPhone pane — what is
          stored from iPhone, and the import (the dashboard's iPhone sync). */}
      {userId && <MessagesStoredBlock userId={userId} source="iphone" testId="iphone-block-stored" />}
      {onImportIphone && (
        <div data-testid="iphone-block-actions" className="flex gap-2 items-center">
          <button
            type="button"
            onClick={() => onImportIphone()}
            disabled={disabled}
            data-testid="iphone-import"
            className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Import from iPhone
          </button>
        </div>
      )}
    </div>
  );
}

export default IphoneSyncSettings;
