/**
 * Reports index — BACKLOG-3505, redesigned in BACKLOG-3513 PR-3g.
 *
 * The gate (lib/reports/report-gate.ts, requireMyReports) runs before anything
 * renders and calls notFound() on any refusal, and when the caller has no report
 * at all, so this page exists exactly when the sidebar entry does.
 *
 * Two lists from broker_report_def_list (session client):
 *  - My reports: the caller owns them (level 'owner'). The summary says who it
 *    is shared with (broker_report_share_list, asked for these rows only);
 *  - Shared with me: someone else owns them and gave the caller edit or view.
 * Newest-updated first. A new report starts private (general_access defaults to
 * 'restricted', no grants), so a fresh one reads "Only you".
 *
 * A failed list says so and never shows "No reports yet". A shared report whose
 * owner is gone or deactivated is marked; reassigning it happens on the
 * report's own page (PR-3f; founder ruling A: no "Needs an owner" group).
 */

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { EmptyState, buttonVariants } from '@keepr/ui';
import { requireMyReports } from '@/lib/reports/report-gate';
import {
  ORG_NAME_FALLBACK,
  listMyReportSharing,
  listSharedReports,
  readOrgName,
  type SharedReportListItem,
} from '@/lib/reports/definitions/server';
import { definitionReportPath, SUBMISSIONS_REPORT_PATH } from '@/lib/reports/datasets/submissions-filters';
import {
  AGENT_SUBTITLE,
  FULL_SUBTITLE,
  formatUpdated,
  myReportSummary,
  sharedWithMeSummary,
  sortByUpdated,
} from '@/lib/reports/definitions/summary';
import { ReportsIndexSection, type ReportsIndexRow } from '@/components/reports/ReportsIndexList';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';

export default async function ReportsPage() {
  const { caller } = await requireMyReports();
  const { ok, shared } = await listSharedReports(caller);
  const now = new Date();

  const mine = sortByUpdated(shared.filter((r) => r.level === 'owner'));
  const withMe = sortByUpdated(shared.filter((r) => r.level === 'editor' || r.level === 'viewer'));
  const sharing = await listMyReportSharing(
    caller,
    mine.map((r) => r.id)
  );
  const orgName = [...sharing.values()].some((s) => s?.generalAccess === 'organization')
    ? await readOrgName(caller)
    : ORG_NAME_FALLBACK;

  const row = (r: SharedReportListItem, summary: string | null): ReportsIndexRow => ({
    id: r.id,
    name: r.name,
    href: definitionReportPath(r.id),
    summary,
    updated: formatUpdated(r.updatedAt, now),
  });

  const mySection = (
    <ReportsIndexSection
      key="mine"
      id="my-reports-heading"
      title="My reports"
      testId="my-reports"
      rows={mine.map((r) => row(r, myReportSummary(sharing.get(r.id) ?? null, orgName)))}
      empty={
        ok ? (
          <EmptyState
            data-testid="my-reports-empty"
            title="No reports yet"
            description="Use New report to save filters as a report. Only you can see it until you share it."
          />
        ) : null
      }
    />
  );
  const withMeSection =
    withMe.length > 0 ? (
      <ReportsIndexSection
        key="with-me"
        id="shared-with-me-heading"
        title="Shared with me"
        testId="shared-with-me"
        rows={withMe.map((r) =>
          row(r, sharedWithMeSummary({ ownerName: r.ownerName, level: r.level as 'editor' | 'viewer', ownerState: r.ownerState }))
        )}
      />
    ) : null;

  return (
    <div className="space-y-7">
      <PageHeader
        className="mb-0"
        phoneHideTitle
        title={PAGE_TITLES.reports}
        subtitle={caller.kind === 'agent' ? AGENT_SUBTITLE : FULL_SUBTITLE}
        actions={
          <Link href={SUBMISSIONS_REPORT_PATH} className={buttonVariants({ variant: 'primary' })} data-testid="new-report">
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            New report
          </Link>
        }
      />
      {!ok ? (
        <p role="alert" data-testid="reports-index-error" className="text-sm text-red-700">
          Your reports could not be loaded. Try again in a moment.
        </p>
      ) : null}
      {caller.kind === 'agent' ? [withMeSection, mySection] : [mySection, withMeSection]}
    </div>
  );
}
