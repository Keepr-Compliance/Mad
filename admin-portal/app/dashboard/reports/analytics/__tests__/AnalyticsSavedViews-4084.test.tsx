// @vitest-environment jsdom
/**
 * Analytics: saved views store the time range (BACKLOG-4084 PR F).
 * Analytics has presets + All time and NO custom range; a view holding a
 * custom range reads as no period.
 */

import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { getAnalyticsData, type AnalyticsData } from '@/lib/reports/analytics-queries';
import { resolveAnalyticsPeriod } from '@/lib/reports/analytics-period';
import { stubClient } from '@/lib/reports/__tests__/postgrest-stub';
import { NOW, TABLES } from '@/lib/reports/__tests__/analytics.fixture';
import { analyticsViews } from '@/lib/reports/period-only-views';
import { runPeriodOnlyViewsSuite } from '@/lib/reports/__tests__/period-only-views.suite';
import { AnalyticsReport } from '../AnalyticsReport';

vi.mock('../components/VersionChart', () => ({ VersionChart: () => <div data-chart="versions" /> }));

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const THIRTY = resolveAnalyticsPeriod({ period: '30' }, NOW);
let DATA: AnalyticsData;
beforeAll(async () => {
  DATA = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
});

runPeriodOnlyViewsSuite({
  report: 'Analytics',
  reportKey: 'analytics',
  views: analyticsViews,
  element: (period, api, onNavigate) => (
    <AnalyticsReport data={DATA} period={period} rowCap={20000} onNavigate={onNavigate} viewsApi={api} />
  ),
  pagePeriod: THIRTY,
  other: { key: '7', period: resolveAnalyticsPeriod({ period: '7' }, NOW), url: '?period=7' },
  defaultKey: 'all',
  foreign: { key: 'custom', from: '2026-10-01', to: '2026-10-10' },
});
