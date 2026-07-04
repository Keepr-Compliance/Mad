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
 * @module settings/IphoneSyncSettings
 */

import React from "react";
import { useIPhoneSyncEnabled } from "../../contexts/IPhoneSyncContext";

export function IphoneSyncSettings() {
  const { enabled, setIphoneSyncEnabled } = useIPhoneSyncEnabled();

  return (
    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
      <div className="flex-1">
        <h4 className="text-sm font-medium text-gray-900">iPhone Sync (USB)</h4>
        <p className="text-xs text-gray-600 mt-1">
          Automatically detect a connected iPhone so you can import messages over USB.
          When off, Keepr won&apos;t look for iPhones in the background.
        </p>
      </div>
      <button
        onClick={() => {
          void setIphoneSyncEnabled(!enabled);
        }}
        className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
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
  );
}

export default IphoneSyncSettings;
