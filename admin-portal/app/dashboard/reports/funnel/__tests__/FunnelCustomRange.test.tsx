// @vitest-environment jsdom

/**
 * Paywall Funnel — custom range end to end (BACKLOG-3722, R6). Modelled on
 * __tests__/period-picker-4032/customRange.test.tsx: the same URL round trip
 * the page makes (buildFunnelPeriodUrl -> resolveFunnelPeriod -> new period
 * prop), so a resolver that drops `custom` snaps the pill back here.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { ALL_TIME_ROWS, NOW } from '@/lib/reports/__tests__/funnel.fixture';
import { FunnelReport } from '../FunnelReport';

function RoutedPage({ onNavigate, initial }: { onNavigate: (url: string) => void; initial: string }) {
  const [period, setPeriod] = useState(() => resolveFunnelPeriod({ period: initial }, NOW));
  return (
    <FunnelReport
      funnel={computeFunnel(ALL_TIME_ROWS)}
      period={period}
      rowCap={20000}
      onNavigate={(url) => {
        onNavigate(url);
        const params = new URLSearchParams(url.replace(/^\?/, ''));
        setPeriod(
          resolveFunnelPeriod(
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 15, 12) });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('R6 Funnel: Custom range survives the URL round trip', () => {
  it('picking Custom navigates nowhere; Apply navigates once with both dates and stays on Custom', () => {
    const onNavigate = vi.fn();
    render(<RoutedPage onNavigate={onNavigate} initial="7" />);
    expect(screen.getByRole('button', { name: 'Period 7d' })).toBeTruthy();

    fireEvent.click(periodPill());
    fireEvent.click(screen.getByRole('option', { name: 'Custom range' }));
    expect(onNavigate).not.toHaveBeenCalled();
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

  it('presets navigate at once on the legacy values; 30d is written too (BACKLOG-4084)', () => {
    const onNavigate = vi.fn();
    render(<RoutedPage onNavigate={onNavigate} initial="7" />);
    fireEvent.click(periodPill());
    fireEvent.click(screen.getByRole('option', { name: 'All time' }));
    expect(onNavigate).toHaveBeenLastCalledWith('?period=all');
    expect(screen.getByRole('button', { name: 'Period All time' })).toBeTruthy();

    fireEvent.click(periodPill());
    fireEvent.click(screen.getByRole('option', { name: '30d' }));
    expect(onNavigate).toHaveBeenLastCalledWith('?period=30');
    expect(screen.getByRole('button', { name: 'Period 30d' })).toBeTruthy();
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
