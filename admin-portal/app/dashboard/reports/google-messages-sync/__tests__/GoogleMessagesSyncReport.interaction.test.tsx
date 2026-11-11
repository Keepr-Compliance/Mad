// @vitest-environment jsdom

/**
 * Google Messages Sync — chart tooltips in a real client render (BACKLOG-4208)
 *
 * The report renders the shared SyncCharts. Hovering a day's column must show
 * that day's Google Messages runs, in the same wording as before the charts
 * moved onto the @keepr/ui BarChart.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGoogleMessagesSyncReport, type GmSyncOutcomeRow } from '@/lib/reports/google-messages-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { GoogleMessagesSyncReport } from '../GoogleMessagesSyncReport';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const WEEK = resolvePeriod({}, NOW);

function row(over: Partial<GmSyncOutcomeRow>): GmSyncOutcomeRow {
  return {
    id: 'run-1',
    user_id: 'u-1',
    created_at: '2026-10-01T10:00:00.000Z',
    source: 'google-messages',
    outcome: 'complete',
    elapsed_ms: 100_000,
    phases: [],
    app_version: '2.38.1',
    platform: 'win32',
    is_packaged: true,
    ...over,
  };
}

// Oct 1: two finished runs (100 s and 260 s) and one error with no duration.
// Oct 2: one cancelled run.
const ROWS = [
  row({ id: 'run-1' }),
  row({ id: 'run-2', created_at: '2026-10-01T11:00:00.000Z', elapsed_ms: 260_000 }),
  row({ id: 'run-3', created_at: '2026-10-01T12:00:00.000Z', outcome: 'error', elapsed_ms: null }),
  row({ id: 'run-4', created_at: '2026-10-02T09:00:00.000Z', outcome: 'cancelled', elapsed_ms: null }),
];

afterEach(cleanup);

function mount() {
  return render(
    <GoogleMessagesSyncReport report={buildGoogleMessagesSyncReport(ROWS, [])} period={WEEK} rowCap={200} />
  );
}

/** Hover one day's column in a chart; return the tooltip's lines. */
function hoverLines(container: HTMLElement, chart: string, day: string): string[] {
  const column = container.querySelector(`[data-chart="${chart}"] rect[data-day="${day}"]`) as Element;
  fireEvent.mouseMove(column, { clientX: 10, clientY: 10 });
  const tip = screen.getByRole('tooltip');
  const lines = [...tip.children].map((line) => line.textContent ?? '');
  fireEvent.mouseLeave(column);
  return lines;
}

describe('chart tooltips name the hovered day (BACKLOG-4208)', () => {
  it('the duration chart, Oct 1', () => {
    const { container } = mount();
    expect(hoverLines(container, 'duration', '2026-10-01')).toEqual([
      'Oct 1',
      '2 runs · average 3 min',
      'longest 4 min',
    ]);
  });

  it('the failures chart, Oct 2', () => {
    const { container } = mount();
    expect(hoverLines(container, 'failures', '2026-10-02')).toEqual([
      'Oct 2',
      '0 errors · 1 cancelled · 0 completed',
    ]);
  });
});
