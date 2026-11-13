/**
 * Reports index — BACKLOG-3505.
 *
 * Lists the reports lib/reports/report-gate.ts says the caller may open. The
 * gate runs before anything renders and calls notFound() on any refusal, and
 * when the caller has no report at all, so this page exists exactly when the
 * sidebar entry does.
 *
 * BACKLOG-3513 PR-3b: "Shared reports" lists the shared reports the caller has
 * a level on (broker_report_def_list, session client). A failed read shows no
 * section; it never hides the built-in reports.
 *
 * "Needs an owner" (a broker, admin or IT admin only): reports whose owner is
 * gone or deactivated and that are NOT shared with the caller
 * (broker_report_orphans). Take over, no link: without a level the report
 * cannot be opened. Orphans the caller can open are marked in Shared reports.
 */

import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@keepr/ui';
import { requireMyReports } from '@/lib/reports/report-gate';
import { listSharedReports } from '@/lib/reports/definitions/server';
import { definitionReportPath } from '@/lib/reports/datasets/submissions-filters';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { TakeOverButton } from '@/components/reports/ReportDefinitionActions';

const LEVEL_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' } as const;
const OWNER_STATE_LABEL = { gone: "Owner's account removed", deactivated: 'Owner deactivated' } as const;

export default async function ReportsPage() {
  const { caller, reports } = await requireMyReports();
  const { shared, needsOwner } = await listSharedReports(caller);

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
      {shared.length > 0 ? (
        <section className="space-y-3" aria-labelledby="shared-reports-heading">
          <h2 id="shared-reports-heading" className="text-lg font-semibold text-gray-900">
            Shared reports
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2" data-testid="shared-reports-index">
            {shared.map((r) => (
              <li key={r.id}>
                <Link href={definitionReportPath(r.id)} className="block">
                  <Card className="h-full transition-colors hover:bg-gray-50">
                    <CardHeader>
                      <CardTitle>{r.name}</CardTitle>
                      <CardDescription>
                        {[
                          r.level ? LEVEL_LABEL[r.level] : null,
                          r.ownerState ? OWNER_STATE_LABEL[r.ownerState] : r.ownerName && r.level !== 'owner' ? `Owner: ${r.ownerName}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {needsOwner.length > 0 ? (
        <section className="space-y-3" aria-labelledby="needs-owner-heading">
          <h2 id="needs-owner-heading" className="text-lg font-semibold text-gray-900">
            Needs an owner
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2" data-testid="needs-owner-index">
            {needsOwner.map((o) => (
              <li key={o.id}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle>{o.name}</CardTitle>
                    <CardDescription>
                      {[OWNER_STATE_LABEL[o.ownerState], o.ownerName || null].filter(Boolean).join(' · ')}
                    </CardDescription>
                    <div className="pt-2">
                      <TakeOverButton defId={o.id} name={o.name} />
                    </div>
                  </CardHeader>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
