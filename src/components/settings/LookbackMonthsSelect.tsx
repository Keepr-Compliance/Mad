/**
 * The "Import messages from" months dropdown, shared by the macOS Messages,
 * Android companion, Google Messages and email sections (one list of options).
 *
 * Founder (2026-10-02): the options are 1, 1.5, 2, 3, 4, 5, 6 months and 1
 * year; the default (1.5) is marked "(default)". The list and the default are
 * PARAMETERS (`options`, `defaultMonths`), so a section can differ without a
 * fork. A stored value outside the list (9, 18, 24 …) is shown as
 * "Custom: N months", and a stored "All time" (null) as "All time" — never
 * blank — but neither is offered as a new choice.
 *
 * A month is 30.4375 days wherever a window is computed
 * (`electron/utils/lookbackWindow.ts`), so 1.5 months = 46 days.
 *
 * The value is the stored `lookbackMonths` as displayed (null = All time);
 * `onChange` receives the option value ("1.5", "3", … or "all"), which each
 * panel saves under its own preference key.
 */

import React from "react";
import { DEFAULT_LOOKBACK_MONTHS } from "./messageImportPreferences";

export const LOOKBACK_MONTH_OPTIONS: readonly number[] = [1, 1.5, 2, 3, 4, 5, 6, 12];

/** The macOS section's style; the other sections reuse it unless they pass their own. */
const DEFAULT_CLASS =
  "text-xs border border-gray-300 rounded px-3 py-2.5 bg-white text-gray-900 disabled:opacity-50 min-h-[44px]";

/** "Last 1 month", "Last 1.5 months (default)", "Last 1 year". */
export function lookbackOptionLabel(months: number, defaultMonths: number | null = DEFAULT_LOOKBACK_MONTHS): string {
  const base = months === 12 ? "Last 1 year" : `Last ${months} month${months === 1 ? "" : "s"}`;
  return months === defaultMonths ? `${base} (default)` : base;
}

/** For sentences: "the last month", "the last 1.5 months", "the last year". */
export function lastMonthsPhrase(months: number): string {
  if (months === 1) return "the last month";
  if (months === 12) return "the last year";
  return `the last ${months} months`;
}

/**
 * SR (2026-10-02): every Force dialog states the window it keeps — a Force
 * run replaces everything with the window's rows. "Keeps texts from the last
 * 1.5 months; older texts not in an audit period are removed."
 */
export function forceWindowLine(months: number | null, what: "texts" | "emails"): string {
  if (months === null) return `Keeps all your ${what}.`;
  return what === "emails"
    ? `Keeps emails from ${lastMonthsPhrase(months)}; older emails are removed from this computer.`
    : `Keeps texts from ${lastMonthsPhrase(months)}; older texts not in an audit period are removed.`;
}

interface LookbackMonthsSelectProps {
  value: number | null;
  onChange: (value: string) => void;
  /** The choices offered (default: the shared list). */
  options?: readonly number[];
  /** The option marked "(default)"; null marks none. */
  defaultMonths?: number | null;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

export function LookbackMonthsSelect({
  value,
  onChange,
  options = LOOKBACK_MONTH_OPTIONS,
  defaultMonths = DEFAULT_LOOKBACK_MONTHS,
  disabled,
  className = DEFAULT_CLASS,
  ...rest
}: LookbackMonthsSelectProps) {
  return (
    <select value={value ?? "all"} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className} {...rest}>
      {/* A stored value outside the list (e.g. 9) is shown as it is, never blank. */}
      {value !== null && !options.includes(value) && (
        <option value={String(value)}>
          Custom: {value} month{value === 1 ? "" : "s"}
        </option>
      )}
      {options.map((m) => (
        <option key={m} value={String(m)}>
          {lookbackOptionLabel(m, defaultMonths)}
        </option>
      ))}
      {/* A stored All time is shown as it is; it is no longer offered. */}
      {value === null && <option value="all">All time</option>}
    </select>
  );
}

/** An option value → the months to store (null = All time). */
export function parseLookbackOption(value: string): number | null {
  return value === "all" ? null : Number(value);
}
