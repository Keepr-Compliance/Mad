/**
 * @vitest-environment jsdom
 *
 * Report chart SVG structure (BACKLOG-4208)
 *
 * A normalized dump of every <svg> the three report chart components render,
 * for a 7-day, a 30-day and an empty period. Recorded against the hand-written
 * charts BEFORE they moved onto the @keepr/ui BarChart, so the switch is
 * checked element by element against what shipped.
 *
 * Normalization (applied to both sides, so it hides nothing that changed
 * between them except what is listed here):
 * - numbers in attribute values are rounded to 3 decimals;
 * - `var(--chart-N, #hex)` fills read as `#hex` (the token's fallback is the
 *   same colour the hand charts used);
 * - React `useId` values read as `:id:`.
 * Only what is inside the <svg> is dumped; the screen-reader table the kit
 * adds sits next to it and is counted separately.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bucketByDay, type ChartRun } from '@/lib/reports/iphone-sync-charts';
import { daysInRange, formatDayLabel, type PeriodRange } from '@/lib/reports/period';
import type { SubmissionDayBucket } from '@/lib/reports/submissions';
import type { ExportDayBucket } from '@/lib/reports/exports';
import { SyncCharts } from '../iphone-sync/SyncCharts';
import { SubmissionCharts } from '../submissions/SubmissionCharts';
import { ExportCharts } from '../exports/ExportCharts';

function range(fromDay: string, toDayExclusive: string): PeriodRange {
  return {
    key: 'custom',
    fromIso: `${fromDay}T00:00:00.000Z`,
    toIso: `${toDayExclusive}T00:00:00.000Z`,
    label: `${fromDay} to ${toDayExclusive}`,
    customFrom: fromDay,
    customTo: toDayExclusive,
  };
}

const RANGES = {
  '7d': range('2026-09-13', '2026-09-20'),
  '30d': range('2026-08-21', '2026-09-20'),
  empty: range('2026-09-13', '2026-09-20'),
} as const;
type RangeName = keyof typeof RANGES;

/** Deterministic pattern: day index i -> a small, uneven count (some zero). */
function pattern(i: number, mod: number, mult: number): number {
  return ((i * mult + 3) % mod) % 5 === 0 ? 0 : ((i * mult + 3) % mod);
}

function syncRuns(name: RangeName): ChartRun[] {
  if (name === 'empty') return [];
  const outcomes = ['complete', 'error', 'cancelled', 'complete', 'complete'];
  const runs: ChartRun[] = [];
  daysInRange(RANGES[name]).forEach((day, i) => {
    const n = pattern(i, 7, 3);
    for (let k = 0; k < n; k += 1) {
      const outcome = outcomes[(i + k) % outcomes.length];
      runs.push({
        createdAtIso: `${day}T1${k % 10}:00:00.000Z`,
        // Finished runs carry an uneven duration (fractional minutes), the
        // rest none, so some days have runs but no average.
        elapsedMs: outcome === 'complete' ? (i % 4) * 90_000 + k * 37_000 + 6_000 : null,
        outcome,
        stalled: (i + k) % 6 === 0,
      });
    }
  });
  return runs;
}

function submissionBuckets(name: RangeName): SubmissionDayBucket[] {
  return daysInRange(RANGES[name]).map((dayIso, i) => {
    const attempts = name === 'empty' ? 0 : pattern(i, 9, 4);
    const failed = attempts === 0 ? 0 : (i * 5) % 3;
    const didNotFinish = attempts === 0 ? 0 : (i * 7) % 2;
    return {
      dayIso,
      dayLabel: formatDayLabel(dayIso),
      attempts,
      committed: Math.max(0, attempts - failed - didNotFinish),
      failed,
      didNotFinish,
      cancelled: attempts === 0 ? 0 : i % 2,
      running: 0,
    };
  });
}

function exportBuckets(name: RangeName): ExportDayBucket[] {
  return daysInRange(RANGES[name]).map((dayIso, i) => {
    const exports = name === 'empty' ? 0 : pattern(i, 8, 5);
    return {
      dayIso,
      dayLabel: formatDayLabel(dayIso),
      exports,
      unique: exports === 0 ? 0 : (i * 3) % (exports + 1),
      formats: 'pdf',
    };
  });
}

const VAR_FILL = /^var\(--chart-\d+,\s*(#[0-9a-fA-F]{3,8})\)$/;

function normalizeValue(name: string, value: string): string {
  if (name === 'fill') {
    const m = VAR_FILL.exec(value);
    if (m) return m[1].toLowerCase();
  }
  if (name === 'id' || name === 'aria-labelledby') {
    return value.replace(/[^\s]+/g, ':id:');
  }
  return value.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 1000) / 1000));
}

function dumpElement(el: Element, depth: number, out: string[]): void {
  const attrs = [...el.attributes]
    .map((a) => `${a.name}="${normalizeValue(a.name, a.value)}"`)
    .sort();
  const text =
    el.children.length === 0 && el.textContent ? ` "${el.textContent}"` : '';
  out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${attrs.length ? ' ' : ''}${attrs.join(' ')}>${text}`);
  for (const child of el.children) dumpElement(child, depth + 1, out);
}

function dump(markup: string): { svgs: string; srTables: number } {
  const host = document.createElement('div');
  host.innerHTML = markup;
  const out: string[] = [];
  host.querySelectorAll('svg').forEach((svg) => {
    dumpElement(svg, 0, out);
    out.push('');
  });
  return { svgs: out.join('\n'), srTables: host.querySelectorAll('table.sr-only').length };
}

const NAMES: RangeName[] = ['7d', '30d', 'empty'];

describe('report chart SVG structure', () => {
  it('the fixtures draw bars, zero days and (for sync) runs without a duration', () => {
    // Guard against a vacuous snapshot: every non-empty fixture has both drawn
    // and empty days, and the empty one has columns but nothing in them.
    const runs = syncRuns('7d');
    expect(runs.some((r) => r.elapsedMs === null)).toBe(true);
    const sub = submissionBuckets('7d');
    expect(sub.some((b) => b.attempts === 0)).toBe(true);
    expect(sub.some((b) => b.attempts > 0)).toBe(true);
    const exp = exportBuckets('30d');
    expect(exp.some((b) => b.exports === 0)).toBe(true);
    expect(exp.some((b) => b.unique > 0)).toBe(true);
    expect(submissionBuckets('empty').length).toBe(7);
  });

  for (const name of NAMES) {
    it(`SyncCharts ${name}`, () => {
      const buckets = bucketByDay(syncRuns(name), RANGES[name]);
      const { svgs, srTables } = dump(renderToStaticMarkup(<SyncCharts buckets={buckets} />));
      expect(svgs).toMatchSnapshot();
      expect(srTables).toMatchSnapshot('sr-only tables');
    });

    it(`SubmissionCharts ${name}`, () => {
      const { svgs, srTables } = dump(
        renderToStaticMarkup(<SubmissionCharts buckets={submissionBuckets(name)} />)
      );
      expect(svgs).toMatchSnapshot();
      expect(srTables).toMatchSnapshot('sr-only tables');
    });

    it(`ExportCharts ${name}`, () => {
      const { svgs, srTables } = dump(
        renderToStaticMarkup(<ExportCharts buckets={exportBuckets(name)} />)
      );
      expect(svgs).toMatchSnapshot();
      expect(srTables).toMatchSnapshot('sr-only tables');
    });
  }
});
