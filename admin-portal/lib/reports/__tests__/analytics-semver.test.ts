/**
 * compareSemver order (BACKLOG-4082) and platform pct denominator (BACKLOG-4081).
 */

import { describe, expect, it } from 'vitest';
import { buildPlatformBreakdown, compareSemver } from '../analytics';

const sorted = (vs: string[]) => [...vs].sort(compareSemver);

describe('compareSemver', () => {
  it('orders the report versions: pre-release just before its release, Unknown last', () => {
    expect(sorted(['Unknown', '2.44.0', '2.41.0', '2.44.0-pre.2', '2.40.0-beta.3'])).toEqual([
      '2.40.0-beta.3', '2.41.0', '2.44.0-pre.2', '2.44.0', 'Unknown',
    ]);
  });

  it('beta.3 < 2.40.0 < 2.41.0', () => {
    expect(compareSemver('2.40.0-beta.3', '2.40.0')).toBeLessThan(0);
    expect(compareSemver('2.40.0', '2.40.0-beta.3')).toBeGreaterThan(0);
    expect(compareSemver('2.40.0', '2.41.0')).toBeLessThan(0);
    expect(compareSemver('2.40.0-beta.3', '2.41.0')).toBeLessThan(0);
  });

  it('numeric suffix parts compare numerically: beta.2 < beta.10', () => {
    expect(compareSemver('2.40.0-beta.2', '2.40.0-beta.10')).toBeLessThan(0);
    expect(compareSemver('2.40.0-beta.10', '2.40.0-beta.2')).toBeGreaterThan(0);
  });

  it('text suffix parts compare alphabetically: alpha < beta', () => {
    expect(compareSemver('2.40.0-alpha.5', '2.40.0-beta.1')).toBeLessThan(0);
    expect(compareSemver('2.40.0-beta.1', '2.40.0-alpha.5')).toBeGreaterThan(0);
  });

  it('release number compares numerically: 2.9.1 < 2.10.1', () => {
    expect(sorted(['2.10.1', '2.9.1'])).toEqual(['2.9.1', '2.10.1']);
  });

  it('Unknown sorts after every version, including pre-releases', () => {
    expect(compareSemver('Unknown', '2.40.0-beta.3')).toBeGreaterThan(0);
    expect(compareSemver('2.44.0', 'Unknown')).toBeLessThan(0);
    expect(sorted(['Unknown', '2.40.0-beta.3', '9.0.0'])).toEqual(['2.40.0-beta.3', '9.0.0', 'Unknown']);
  });

  it('equal versions compare 0', () => {
    expect(compareSemver('2.44.0', '2.44.0')).toBe(0);
    expect(compareSemver('2.44.0-pre.2', '2.44.0-pre.2')).toBe(0);
  });
});

describe('buildPlatformBreakdown pct', () => {
  it('22 Windows, 11 macOS, 28 distinct users: pct over the sum of counts (33), user counts kept', () => {
    const rows = [
      ...Array.from({ length: 22 }, (_, i) => ({ platform: 'windows', user_id: `u${i + 1}` })),
      ...Array.from({ length: 11 }, (_, i) => ({ platform: 'macos', user_id: `u${i + 18}` })),
    ];
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(28);
    expect(buildPlatformBreakdown(rows)).toEqual([
      { platform: 'windows', user_count: 22, pct: 67 },
      { platform: 'macos', user_count: 11, pct: 33 },
    ]);
  });

  it('no rows -> empty', () => {
    expect(buildPlatformBreakdown([])).toEqual([]);
  });
});
