/**
 * The "Import messages from" months dropdown, shared by the macOS Messages,
 * Android companion and Google Messages sections (one list of options).
 *
 * The value is the stored `lookbackMonths` as displayed (null = All time);
 * `onChange` receives the option value ("3".."24" or "all"), which each
 * panel saves under its own preference key.
 */

import React from "react";

export const LOOKBACK_MONTH_OPTIONS: readonly number[] = [3, 6, 9, 12, 18, 24];

/** The macOS section's style; the other sections reuse it unless they pass their own. */
const DEFAULT_CLASS =
  "text-xs border border-gray-300 rounded px-3 py-2.5 bg-white text-gray-900 disabled:opacity-50 min-h-[44px]";

interface LookbackMonthsSelectProps {
  value: number | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

export function LookbackMonthsSelect({ value, onChange, disabled, className = DEFAULT_CLASS, ...rest }: LookbackMonthsSelectProps) {
  return (
    <select value={value ?? "all"} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className} {...rest}>
      {LOOKBACK_MONTH_OPTIONS.map((m) => (
        <option key={m} value={String(m)}>
          Last {m} months
        </option>
      ))}
      <option value="all">All time</option>
    </select>
  );
}

/** An option value → the months to store (null = All time). */
export function parseLookbackOption(value: string): number | null {
  return value === "all" ? null : Number(value);
}
