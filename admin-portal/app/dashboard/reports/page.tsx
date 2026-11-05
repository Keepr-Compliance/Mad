import { requireMyReports } from '@/lib/reports/report-gate';
import { cookies } from 'next/headers';
import { REPORTS } from '@/lib/reports/registry';
import type { ParamRecord } from '@/lib/reports/report-url';
import { ReportsIndex } from './ReportsIndex';
import { REPORTS_VIEW_COOKIE, resolveReportsIndexView } from './reportsIndexView';

export const dynamic = 'force-dynamic';

/**
 * Reports index — Admin Portal (BACKLOG-3441)
 *
 * Lists the registered reports the caller may open (BACKLOG-4144: `report_list_my_reports`;
 * none at all is a 404). New reports are added to
 * `lib/reports/registry.ts`; the sidebar does not change.
 * Analytics (BACKLOG-3723) and Paywall Funnel (BACKLOG-3722) are registry
 * reports; neither has a sidebar entry of its own (BACKLOG-4005).
 *
 * BACKLOG-4091: Cards | List layout. The starting layout is resolved here,
 * after the gate: ?view first, then the reports-index-view cookie, then Cards.
 */
export default async function ReportsIndexPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  // BACKLOG-4144: only the reports the caller may open, in registry order.
  const { reports: mine } = await requireMyReports();
  const keys = new Set(mine.map((r) => r.reportKey));
  const reports = REPORTS.filter((r) => keys.has(r.slug));

  const params = await searchParams;
  const cookieStore = await cookies();
  const initialView = resolveReportsIndexView({
    url: params.view,
    cookie: cookieStore.get(REPORTS_VIEW_COOKIE)?.value,
  });

  return <ReportsIndex reports={reports} initialView={initialView} />;
}
