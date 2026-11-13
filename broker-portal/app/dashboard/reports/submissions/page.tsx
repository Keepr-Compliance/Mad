/**
 * Submissions report — BACKLOG-3513 PR-3a.
 *
 * The gate (lib/reports/report-gate.ts) runs first and calls notFound() on any
 * refusal. Rows come only from lib/reports/datasets/submissions.ts, which asks
 * the database row function; this page never reads transaction_submissions.
 *
 * When the brokerage's service is off, the database limits every reader to the
 * submissions they sent themselves, and this page says so in one line.
 *
 * PR-3b: the body is shared with every shared report (SubmissionsReportBody),
 * and "Save as shared report" saves the current filters as a new one.
 */

import { requireReportAccess } from '@/lib/reports/report-gate';
import { loadSubmissionsReport } from '@/lib/reports/datasets/submissions';
import {
  filtersToViewState,
  parseSubmissionsReportParams,
  type SubmissionsSearchParams,
} from '@/lib/reports/datasets/submissions-filters';
import { SubmissionsReportBody } from '@/components/reports/submissions/SubmissionsReportBody';
import { SaveAsSharedReport } from '@/components/reports/SaveAsSharedReport';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<SubmissionsSearchParams>;
}

export default async function SubmissionsReportPage({ searchParams }: PageProps) {
  const { caller, report } = await requireReportAccess('submissions');
  const filters = parseSubmissionsReportParams(await searchParams);
  const data = await loadSubmissionsReport(caller, filters);

  return (
    <SubmissionsReportBody
      caller={caller}
      report={report}
      filters={filters}
      data={data}
      title={report.title}
      actions={<SaveAsSharedReport orgId={caller.organizationId} current={filtersToViewState(filters)} />}
    />
  );
}
