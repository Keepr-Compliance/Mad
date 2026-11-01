// @vitest-environment jsdom
/**
 * Support SLA: saved views store the time range (BACKLOG-4084 PR F).
 * The shared report periods (24h ... last month + custom); a view holding a
 * Funnel key ('30') reads as no period. Nothing here touches the SLA numbers:
 * the report renders with a failed read (report null, settings null).
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resolvePeriod } from '@/lib/reports/period';
import { NOW } from '@/lib/reports/__tests__/support-sla.fixture';
import { supportSlaViews } from '@/lib/reports/period-only-views';
import { runPeriodOnlyViewsSuite } from '@/lib/reports/__tests__/period-only-views.suite';
import { SupportSlaReport } from '../SupportSlaReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

runPeriodOnlyViewsSuite({
  report: 'Support SLA',
  reportKey: 'support-sla',
  views: supportSlaViews,
  element: (period, api, onNavigate) => (
    <SupportSlaReport
      report={null}
      settings={null}
      period={period}
      rowCap={1000}
      onNavigate={onNavigate}
      viewsApi={api}
    />
  ),
  pagePeriod: resolvePeriod({ period: 'week' }, NOW),
  other: { key: 'month', period: resolvePeriod({ period: 'month' }, NOW), url: '?period=month' },
  defaultKey: 'last-month',
  custom: {
    stored: { key: 'custom', from: '2026-10-01', to: '2026-10-10' },
    url: '?period=custom&from=2026-10-01&to=2026-10-10',
  },
  foreign: { key: '30' },
});
