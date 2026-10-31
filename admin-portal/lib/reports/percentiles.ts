/**
 * Median and nearest-rank percentile (BACKLOG-4086)
 *
 * Both sort a COPY of the input; callers pass values in any order.
 * - median: the middle value; for an even count, the mean of the two middle
 *   values (same definition as the iPhone sync report).
 * - percentileNearestRank(values, p): sorted[ceil(p/100 * n) - 1]. For p = 90:
 *   n < 10 -> the maximum; n = 10 -> the 9th smallest; n = 0 -> null.
 */

function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number | null {
  const n = values.length;
  if (n === 0) return null;
  const s = sortedCopy(values);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `p` is a whole percent in (0, 100]. Integer arithmetic keeps the rank exact. */
export function percentileNearestRank(values: readonly number[], p: number): number | null {
  const n = values.length;
  if (n === 0) return null;
  const s = sortedCopy(values);
  const rank = Math.max(1, Math.ceil((p * n) / 100));
  return s[Math.min(n, rank) - 1];
}
