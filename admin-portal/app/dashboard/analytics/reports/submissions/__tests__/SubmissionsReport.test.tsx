/**
 * Submissions report — render tests (BACKLOG-3715)
 *
 * Static render, no router: `SubmissionsReport` takes navigation as a prop.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport, STALL_MINUTES } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OLD_OPEN,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';
import { STALLED_DEFINITION, SWEEP_WINDOW_WARNING } from '../OpenAttemptsPanel';

const THIS_WEEK = resolvePeriod({}, NOW);

function html(periodRows = PERIOD_ROWS, openRows = OPEN_ROWS) {
  return renderToStaticMarkup(
    <SubmissionsReport
      report={buildSubmissionsReport(periodRows, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openAttempts={buildOpenAttempts(openRows, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openCap={200}
      period={THIS_WEEK}
      rowCap={500}
    />
  );
}

const tileValue = (markup: string, id: string) =>
  markup.match(new RegExp(`data-tile-value="${id}"[^>]*>(\\d+)<`))?.[1];

describe('open-attempts panel', () => {
  it('renders when the period has NO rows (C10)', () => {
    const markup = html([], OPEN_ROWS);
    expect(markup).toContain('data-open-attempts-panel');
    expect(markup).toContain(`data-open-attempt="${OLD_OPEN.submission_id}"`);
    expect(markup).toContain('No submit attempts in this period');
  });

  it('defines "Stalled" at 30 min on the panel (SR condition 3)', () => {
    expect(STALLED_DEFINITION).toContain(`${STALL_MINUTES} min or more`);
    expect(STALLED_DEFINITION).toContain('a large upload can show here while still running');
    expect(html()).toContain('a large upload can show here while still running');
  });

  it('shows the 3 h+ sweep-window warning on the old row only, never "missed" (SR condition 2)', () => {
    const markup = html();
    expect(markup.match(/data-sweep-window/g)).toHaveLength(1);
    expect(SWEEP_WINDOW_WARNING).toContain('Open 3 h+');
    expect(SWEEP_WINDOW_WARNING).toContain('If it was still sending files, this is expected.');
    expect(markup).not.toMatch(/sweep missed|should have cleaned/i);
  });
});

describe('"Stalled now" tile uses the panel\'s set and rule (SR condition 3)', () => {
  it('counts stalled open attempts from any date, matching the panel', () => {
    const markup = html();
    // OLD_OPEN (before the period) and STALLED are stalled; RUNNING is not.
    expect(tileValue(markup, 'stalled-now')).toBe('2');
    const panel = (markup.split('data-open-attempts-panel')[1] ?? '').split('</section>')[0];
    const panelStalled = panel.match(
      /data-status="stalled"/g
    );
    expect(panelStalled).toHaveLength(2);
  });
});

describe('charts', () => {
  it('give every day of the range a data-day column in both charts (C13)', () => {
    const markup = html();
    for (const chart of ['attempts', 'failures']) {
      const svg = markup.split(`data-chart="${chart}"`)[1].split('</svg>')[0];
      const days = [...svg.matchAll(/data-day="([^"]+)"/g)].map((m) => m[1]);
      expect(days).toEqual([
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
      ]);
    }
  });
});

describe('table', () => {
  it('lists every period row, in_progress included, ten at a time', () => {
    const markup = html();
    expect((markup.match(/data-submission-row=/g) ?? []).length).toBe(10);
    expect(markup).toContain('Showing 10 of 10 attempts');
    expect(tileValue(markup, 'attempts')).toBe('10');
  });
});
