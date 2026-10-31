// @vitest-environment jsdom

/**
 * BACKLOG-4032 slice 3, control A1: Custom range on the Submissions report,
 * through the same URL round trip the page makes (buildPeriodUrl ->
 * resolvePeriod -> new `period` prop), so the snap-back is reproduced end to
 * end: before this slice, picking "Custom range" navigated to
 * `?period=custom` with no dates, resolvePeriod fell back to "This week", and
 * the pill snapped back.
 *
 * The page is mounted on a PRESET ("This month"), so PeriodPicker gets
 * from / to undefined, as the real page passes them.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '@/app/dashboard/reports/submissions/SubmissionsReport';

function RoutedPage({ onNavigate }: { onNavigate: (url: string) => void }) {
  const [period, setPeriod] = useState(() => resolvePeriod({ period: 'month' }, NOW));
  return (
    <SubmissionsReport
      report={buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openAttempts={buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openCap={200}
      period={period}
      rowCap={500}
      onNavigate={(url) => {
        onNavigate(url);
        // What router.push + the server page do: re-resolve the period from the URL.
        const params = new URLSearchParams(url.replace(/^\?/, ''));
        setPeriod(
          resolvePeriod(
            {
              period: params.get('period') ?? undefined,
              from: params.get('from') ?? undefined,
              to: params.get('to') ?? undefined,
            },
            NOW
          )
        );
      }}
    />
  );
}

const periodPill = () => screen.getByRole('button', { name: /^Period / });
const rangePill = () => screen.queryByRole('button', { name: /^Custom range / });

beforeEach(() => {
  // Only Date: the calendar opens on local "today" = Oct 15 2026.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 15, 12) });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('A1 Submissions report: Custom range survives the URL round trip', () => {
  it('picking Custom navigates nowhere and stays on Custom; Apply navigates once with both dates', () => {
    const onNavigate = vi.fn();
    render(<RoutedPage onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Period This month' })).toBeTruthy();

    fireEvent.click(periodPill());
    fireEvent.click(screen.getByRole('option', { name: 'Custom range' }));

    // The snap-back: the old picker navigated here to ?period=custom and the page fell back to This week.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Period Custom range' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Custom range' })).toBeTruthy();

    fireEvent.click(screen.getByRole('gridcell', { name: 'Thursday, October 1, 2026' }));
    fireEvent.click(screen.getByRole('gridcell', { name: 'Tuesday, October 20, 2026' }));
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith('?period=custom&from=2026-10-01&to=2026-10-20');
    expect(screen.getByRole('button', { name: 'Period Custom range' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Custom range Oct 1 – Oct 20, 2026' })).toBeTruthy();
  });

  it('a preset pick still navigates at once and drops the dates', () => {
    const onNavigate = vi.fn();
    render(<RoutedPage onNavigate={onNavigate} />);
    fireEvent.click(periodPill());
    fireEvent.click(screen.getByRole('option', { name: 'Last week' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith('?period=last-week');
    expect(screen.getByRole('button', { name: 'Period Last week' })).toBeTruthy();
    expect(rangePill()).toBeNull();
  });
});
