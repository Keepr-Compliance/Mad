// @vitest-environment jsdom
/**
 * Every report's browser seam wires sharing (BACKLOG-4087): all 8 reports under
 * app/dashboard/reports/*, rendered through their *ReportClient with the real views api, parser and
 * share api against a fake client (share-rpc-stub.ts). An own row gets Share; a shared row gets
 * Leave. Invented names; the period in each row's blob is not read here.
 */

import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const stub = vi.hoisted(() => ({ current: null as null | import('@/lib/reports/__tests__/share-rpc-stub').ShareRpcStub }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => stub.current!.client }));
vi.mock('../analytics/components/VersionChart', () => ({ VersionChart: () => <div data-chart="versions" /> }));

import { createShareRpcStub, ownRow, sharedRow } from '@/lib/reports/__tests__/share-rpc-stub';
import { resolvePeriod } from '@/lib/reports/period';
import { getAnalyticsData, type AnalyticsData } from '@/lib/reports/analytics-queries';
import { resolveAnalyticsPeriod } from '@/lib/reports/analytics-period';
import { stubClient } from '@/lib/reports/__tests__/postgrest-stub';
import { NOW as ANALYTICS_NOW, TABLES } from '@/lib/reports/__tests__/analytics.fixture';
import { buildExportsReport } from '@/lib/reports/exports';
import { EXPORT_ROWS, LOOKUPS, PERIOD as EXPORTS_PERIOD } from '@/lib/reports/__tests__/exports.fixture';
import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { ALL_TIME_ROWS, NOW as FUNNEL_NOW } from '@/lib/reports/__tests__/funnel.fixture';
import { buildGoogleMessagesSyncReport } from '@/lib/reports/google-messages-sync';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW as SUBMISSIONS_NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { buildUserActivityReport } from '@/lib/reports/user-activity';
import * as UA from '@/lib/reports/__tests__/user-activity.fixture';
import { AnalyticsReportClient } from '../analytics/AnalyticsReportClient';
import { ExportsReportClient } from '../exports/ExportsReportClient';
import { FunnelReportClient } from '../funnel/FunnelReportClient';
import { GoogleMessagesSyncReportClient } from '../google-messages-sync/GoogleMessagesSyncReportClient';
import { IphoneSyncReportClient } from '../iphone-sync/IphoneSyncReportClient';
import { SubmissionsReportClient } from '../submissions/SubmissionsReportClient';
import { SupportSlaReportClient } from '../support-sla/SupportSlaReportClient';
import { UserActivityReportClient } from '../user-activity/UserActivityReportClient';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stub.current = createShareRpcStub();
});

const ANALYTICS_PERIOD = resolveAnalyticsPeriod({ period: '30' }, ANALYTICS_NOW);
let ANALYTICS_DATA: AnalyticsData;
beforeAll(async () => {
  ANALYTICS_DATA = await getAnalyticsData(stubClient(TABLES).client, ANALYTICS_PERIOD.fromIso);
});

const WEEK = resolvePeriod({ period: 'week' }, new Date('2026-10-04T12:00:00.000Z'));

const REPORTS: [string, () => ReactElement][] = [
  ['analytics', () => <AnalyticsReportClient data={ANALYTICS_DATA} period={ANALYTICS_PERIOD} rowCap={20000} />],
  [
    'exports',
    () => <ExportsReportClient report={buildExportsReport(EXPORT_ROWS, LOOKUPS)} period={EXPORTS_PERIOD} rowCap={500} />,
  ],
  [
    'funnel',
    () => (
      <FunnelReportClient
        funnel={computeFunnel(ALL_TIME_ROWS)}
        period={resolveFunnelPeriod({ period: '30' }, FUNNEL_NOW)}
        rowCap={20000}
      />
    ),
  ],
  [
    'google-messages-sync',
    () => <GoogleMessagesSyncReportClient report={buildGoogleMessagesSyncReport([], [])} period={WEEK} rowCap={200} />,
  ],
  [
    'iphone-sync',
    () => (
      <IphoneSyncReportClient report={buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24)} period={WEEK} rowCap={200} />
    ),
  ],
  [
    'submissions',
    () => (
      <SubmissionsReportClient
        report={buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, SUBMISSIONS_NOW)}
        openAttempts={buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, SUBMISSIONS_NOW)}
        openCap={200}
        period={resolvePeriod({ period: 'week' }, SUBMISSIONS_NOW)}
        rowCap={500}
      />
    ),
  ],
  ['support-sla', () => <SupportSlaReportClient report={null} settings={null} period={WEEK} rowCap={20000} />],
  [
    'user-activity',
    () => (
      <UserActivityReportClient
        report={buildUserActivityReport({
          users: UA.USERS,
          devices: UA.DEVICES,
          events: UA.EVENTS,
          memberships: UA.MEMBERSHIPS,
          orgs: UA.ORGS,
          staffIds: UA.STAFF_IDS,
        })}
        period={UA.LAST_WEEK}
        rowCap={20000}
      />
    ),
  ],
];

describe('every report offers Share and Leave once the database has sharing', () => {
  it('covers all 8 reports', () => {
    expect(REPORTS.map(([k]) => k)).toHaveLength(8);
  });

  for (const [key, element] of REPORTS) {
    it(key, async () => {
      stub.current!.setListRows([ownRow({ name: 'Mine' }), sharedRow('viewer')]);
      render(element());
      await waitFor(() =>
        expect(stub.current!.calls('report_list_saved_views')).toContainEqual({ p_report_key: key })
      );
      fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
      const panel = await screen.findByRole('dialog', { name: 'Saved views' });
      await waitFor(() => expect(within(panel).getByRole('button', { name: 'Share Mine' })).toBeTruthy());
      expect(within(panel).getByRole('button', { name: 'Leave Quinn view' })).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: 'Share Mine' }));
      expect(await screen.findByRole('dialog', { name: 'Share Mine' })).toBeTruthy();
      await waitFor(() => expect(stub.current!.calls('report_share_candidates')).toHaveLength(1));
    });
  }
});
