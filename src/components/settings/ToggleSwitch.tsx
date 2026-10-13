/**
 * BACKLOG-3156 stage G — the settings toggle switch.
 *
 * The switch the "iPhone Sync (USB)" row has always drawn (IphoneSyncSettings),
 * lifted out so the Mac "Import message text only" row and the Google Messages
 * photos / videos rows use the same control (founder, 2026-10-13). role="switch"
 * + aria-checked; the caller owns the value and what a change does.
 */
import React from "react";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  testId?: string;
  /** Extra classes on the button (e.g. "ml-4" beside a label block). */
  className?: string;
}

export function ToggleSwitch({ checked, onChange, ariaLabel, disabled = false, testId, className = "" }: ToggleSwitchProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
      disabled={disabled}
      className={`${className ? `${className} ` : ""}relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? "bg-blue-500" : "bg-gray-300"
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
