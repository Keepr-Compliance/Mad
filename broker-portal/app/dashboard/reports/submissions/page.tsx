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
 * PR-3b: the body is shared with every shared report (SubmissionsReportBody).
 * PR-3g: this page is "New report" (the index's New report button opens it);
 * "Save as report" saves the current filters as a new, private report.
 */

import { requireReportAccess } from '@/lib/reports/report-gate';
import { loadSubmissionsReport } from '@/lib/reports/datasets/submissions';
import {
  filtersToViewState,
  parseSubmissionsReportParams,
  type SubmissionsSearchParams,
} from '@/lib/reports/datasets/submissions-filters';
import { SubmissionsReportBody } from '@/components/reports/submissions/SubmissionsReportBody';
import { SaveAsReport } from '@/components/reports/SaveAsReport';

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
      title="New report"
      description="From Submissions: every deal sent for review."
      actions={<SaveAsReport orgId={caller.organizationId} current={filtersToViewState(filters)} />}
    />
  );
}
