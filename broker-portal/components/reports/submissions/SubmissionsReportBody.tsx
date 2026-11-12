/**
 * The Submissions report body — BACKLOG-3513 PR-3a, shared by PR-3b.
 *
 * Header with the deal count, the service-off line, the controls, the table and
 * paging. Used by the code report (/dashboard/reports/submissions) and by every
 * shared report on it (/dashboard/reports/d/<id>), so both read and show rows
 * the same way. Data comes in already loaded (lib/reports/datasets/submissions.ts).
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@keepr/design-system';
import type { ReportCaller } from '@/lib/reports/report-gate';
import type { ReportDefinition } from '@/lib/reports/registry';
import type { SubmissionsReportData } from '@/lib/reports/datasets/submissions';
import {
  SERVICE_OFF_LINE,
  SUBMISSIONS_REPORT_PATH,
  buildSubmissionsReportUrl,
  type SubmissionsReportFilters as Filters,
} from '@/lib/reports/datasets/submissions-filters';
import { SubmissionsReportFilters } from '@/components/reports/submissions/SubmissionsReportFilters';
import { SubmissionsReportTable } from '@/components/reports/submissions/SubmissionsReportTable';

export interface SubmissionsReportBodyProps {
  caller: ReportCaller;
  report: ReportDefinition;
  filters: Filters;
  data: SubmissionsReportData;
  title: string;
  /** Buttons beside the title (Share, Update, Delete, Save as shared report). */
  actions?: ReactNode;
  /** Shown above the controls (e.g. the take-over notice). */
  notice?: ReactNode;
  basePath?: string;
  explicit?: boolean;
  viewsKey?: string;
}

export function SubmissionsReportBody({
  caller,
  report,
  filters,
  data,
  title,
  actions,
  notice,
  basePath = SUBMISSIONS_REPORT_PATH,
  explicit = false,
  viewsKey,
}: SubmissionsReportBodyProps) {
  const full = caller.kind === 'full';
  const pageUrl = (page: number) => buildSubmissionsReportUrl({ ...filters, page }, basePath, explicit);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        phoneHideTitle
        title={title}
        subtitle={
          data.ok ? (
            <span data-testid="submissions-report-count">
              {data.total} deal{data.total !== 1 ? 's' : ''}
            </span>
          ) : undefined
        }
        actions={actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : undefined}
      />

      {notice}

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
        basePath={basePath}
        explicit={explicit}
        viewsKey={viewsKey}
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
                <Link href={pageUrl(data.page - 1)} className="hover:underline">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span>
                Page {data.page} of {data.totalPages}
              </span>
              {data.page < data.totalPages ? (
                <Link href={pageUrl(data.page + 1)} className="hover:underline">
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
