/**
 * The ONE month-to-days rule for every "last N months" window (founder,
 * 2026-10-02): Mac Messages, iPhone, Google Messages, the Android companion
 * (a mirror in `android-companion/services/syncWindow.ts`) and email.
 *
 * A month is 30.4375 days (365.25 / 12), rounded to whole days:
 *   1 → 30, 1.5 → 46, 2 → 61, 3 → 91, 4 → 122, 5 → 152, 6 → 183, 12 → 365.
 *
 * Days, not calendar months: `Date#setMonth` truncates a fractional month
 * (1.5 would read as 1), and calendar months make the same setting a
 * different length depending on today's date.
 */

export const LOOKBACK_DAYS_PER_MONTH = 30.4375;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window's length in whole days. */
export function lookbackDays(months: number): number {
  return Math.round(months * LOOKBACK_DAYS_PER_MONTH);
}

/** The window's lower bound (epoch ms) for `months` back from `nowMs`. */
export function lookbackStartMs(months: number, nowMs: number): number {
  return nowMs - lookbackDays(months) * DAY_MS;
}
