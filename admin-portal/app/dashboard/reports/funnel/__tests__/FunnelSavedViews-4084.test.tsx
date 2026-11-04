// @vitest-environment jsdom
/**
 * Paywall Funnel: saved views store the time range (BACKLOG-4084 PR F).
 * Funnel keeps its own period set (1/7/30/90/all + custom); a view holding a
 * shared-report key ('week') reads as no period.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { ALL_TIME_ROWS, NOW } from '@/lib/reports/__tests__/funnel.fixture';
import { funnelViews } from '@/lib/reports/period-only-views';
import { runPeriodOnlyViewsSuite } from '@/lib/reports/__tests__/period-only-views.suite';
import { FunnelReport } from '../FunnelReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const FUNNEL = computeFunnel(ALL_TIME_ROWS);

runPeriodOnlyViewsSuite({
  report: 'Funnel',
  reportKey: 'funnel',
  views: funnelViews,
  element: (period, api, onNavigate) => (
    <FunnelReport funnel={FUNNEL} period={period} rowCap={20000} onNavigate={onNavigate} viewsApi={api} />
  ),
  pagePeriod: resolveFunnelPeriod({ period: '30' }, NOW),
  other: { key: '7', period: resolveFunnelPeriod({ period: '7' }, NOW), url: '?period=7' },
  defaultKey: 'all',
  custom: {
    stored: { key: 'custom', from: '2026-10-01', to: '2026-10-10' },
    url: '?period=custom&from=2026-10-01&to=2026-10-10',
  },
  foreign: { key: 'week' },
});
