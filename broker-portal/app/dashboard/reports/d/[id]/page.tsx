/**
 * One shared report — BACKLOG-3513 PR-3b.
 *
 * Dynamic: every request reads the definition afresh (broker_report_def_get)
 * and then its rows (broker_report_submissions_rows with p_def = this report),
 * so a level or row-scope change shows on the next load. requireDefinitionAccess
 * calls notFound() on any refusal.
 *
 * The filters are the report's own unless the person changed them on this page
 * (the URL then carries them). Share, Save filters and Delete are offered by
 * level; Reassign when broker_report_def_get says reassign_available (an IT
 * admin, or an admin when the brokerage has no IT admin, when the owner is gone).
 */

import { requireDefinitionAccess, DEFINITION_DATASET } from '@/lib/reports/definitions/server';
import { loadSubmissionsReport } from '@/lib/reports/datasets/submissions';
import {
  definitionReportPath,
  filtersToViewState,
  resolveDefinitionFilters,
  type SubmissionsSearchParams,
} from '@/lib/reports/datasets/submissions-filters';
import { SubmissionsReportBody } from '@/components/reports/submissions/SubmissionsReportBody';
import { BrokerReportShareButton } from '@/components/reports/BrokerReportShareButton';
import { DeleteReportButton, UpdateReportButton } from '@/components/reports/ReportDefinitionActions';
import { ReassignReport } from '@/components/reports/ReassignReport';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<SubmissionsSearchParams>;
}

export default async function SharedReportPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { caller, definition, orgName } = await requireDefinitionAccess(id);
  const filters = resolveDefinitionFilters(await searchParams, definition.definition);
  const data = await loadSubmissionsReport(caller, filters, definition.id);
  const current = filtersToViewState(filters);

  return (
    <SubmissionsReportBody
      caller={caller}
      report={DEFINITION_DATASET}
      filters={filters}
      data={data}
      title={definition.name}
      basePath={definitionReportPath(definition.id)}
      explicit
      notice={
        <ReassignReport defId={definition.id} name={definition.name} kind={caller.kind} reassignAvailable={definition.reassignAvailable} />
      }
      actions={
        <>
          <UpdateReportButton
            defId={definition.id}
            name={definition.name}
            description={definition.description}
            rowScope={definition.rowScope}
            updatedAt={definition.updatedAt}
            level={definition.level}
            current={current}
          />
          <BrokerReportShareButton defId={definition.id} name={definition.name} orgName={orgName} level={definition.level} />
          <DeleteReportButton defId={definition.id} name={definition.name} level={definition.level} />
        </>
      }
    />
  );
}
