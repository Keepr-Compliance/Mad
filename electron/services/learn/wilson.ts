/**
 * Wilson score interval — BACKLOG-4120.
 *
 * 95% two-sided interval for a proportion k/n, returned as percentages
 * rounded to one decimal. n = 0 has no interval (null).
 */

/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959964;

export interface WilsonInterval {
  /** Point estimate k/n, percent, one decimal. */
  rate: number;
  low: number;
  high: number;
}

function round1(x: number): number {
  return Math.round(x * 1000) / 10;
}

export function wilsonInterval(k: number, n: number, z: number = Z_95): WilsonInterval | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    rate: round1(p),
    low: round1(Math.max(0, centre - half)),
    high: round1(Math.min(1, centre + half)),
  };
}
