/**
 * Submissions report — BACKLOG-3513 PR-3a.
 *
 * The gate (lib/reports/report-gate.ts) runs first and calls notFound() on any
 * refusal. Rows come only from lib/reports/datasets/submissions.ts, which asks
 * the database row function; this page never reads transaction_submissions.
 *
 * When the brokerage's service is off, the database limits every reader to the
 * submissions they sent themselves, and this page says so in one line.
 */

import Link from 'next/link';
import { PageHeader } from '@keepr/design-system';
import { requireReportAccess } from '@/lib/reports/report-gate';
import { loadSubmissionsReport } from '@/lib/reports/datasets/submissions';
import {
  SERVICE_OFF_LINE,
  buildSubmissionsReportUrl,
  parseSubmissionsReportParams,
  type SubmissionsSearchParams,
} from '@/lib/reports/datasets/submissions-filters';
import { SubmissionsReportFilters } from '@/components/reports/submissions/SubmissionsReportFilters';
import { SubmissionsReportTable } from '@/components/reports/submissions/SubmissionsReportTable';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<SubmissionsSearchParams>;
}

export default async function SubmissionsReportPage({ searchParams }: PageProps) {
  const { caller, report } = await requireReportAccess('submissions');
  const filters = parseSubmissionsReportParams(await searchParams);
  const data = await loadSubmissionsReport(caller, filters);
  const full = caller.kind === 'full';

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        phoneHideTitle
        title={report.title}
        subtitle={
          data.ok ? (
            <span data-testid="submissions-report-count">
              {data.total} deal{data.total !== 1 ? 's' : ''}
            </span>
          ) : undefined
        }
      />

      {data.ok && data.serviceOff ? (
        <p role="status" data-testid="report-service-off" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {SERVICE_OFF_LINE}
        </p>
      ) : null}

      <SubmissionsReportFilters
        orgId={caller.organizationId}
        report={report}
        filters={filters}
        showAgent={full}
        agents={data.ok ? data.agents : []}
      />

      {!data.ok ? (
        <p role="alert" data-testid="submissions-report-error" className="text-sm text-red-700">
          This report could not be loaded. Try again in a moment.
        </p>
      ) : data.rows.length === 0 ? (
        <p data-testid="submissions-report-empty" className="text-sm text-gray-600">
          No submissions match these filters.
        </p>
      ) : (
        <>
          <SubmissionsReportTable rows={data.rows} full={full} names={data.names} />
          {data.totalPages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between text-sm text-gray-700">
              {data.page > 1 ? (
                <Link href={buildSubmissionsReportUrl({ ...filters, page: data.page - 1 })} className="hover:underline">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span>
                Page {data.page} of {data.totalPages}
              </span>
              {data.page < data.totalPages ? (
                <Link href={buildSubmissionsReportUrl({ ...filters, page: data.page + 1 })} className="hover:underline">
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
