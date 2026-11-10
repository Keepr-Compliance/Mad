/**
 * Reports index — BACKLOG-3505.
 *
 * Lists the reports lib/reports/report-gate.ts says the caller may open. The
 * gate runs before anything renders and calls notFound() on any refusal, and
 * when the caller has no report at all, so this page exists exactly when the
 * sidebar entry does. PR-1 registers no report, so it 404s for everyone.
 *
 * No data is read here. A report page reads through the session client only.
 */

import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@keepr/ui';
import { requireMyReports } from '@/lib/reports/report-gate';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';

export default async function ReportsPage() {
  const { reports } = await requireMyReports();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">{PAGE_TITLES.reports}</h1>
      <ul className="grid gap-4 sm:grid-cols-2" data-testid="reports-index">
        {reports.map(({ report }) => (
          <li key={report.slug}>
            <Link href={`/dashboard/reports/${report.slug}`} className="block">
              <Card className="h-full transition-colors hover:bg-gray-50">
                <CardHeader>
                  <CardTitle>{report.title}</CardTitle>
                  <CardDescription>{report.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
