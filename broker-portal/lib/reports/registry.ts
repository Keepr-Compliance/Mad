/**
 * Broker Reports registry — BACKLOG-3505.
 *
 * One entry per report the broker portal offers. The Reports index, the
 * sidebar entry and every report page read this list through
 * lib/reports/report-gate.ts, so a report that is not listed here does not
 * exist for anybody.
 *
 * `access.roles` names the FULL portal roles that may open the report
 * (broker, admin, it_admin — founder ruling 85aaac88). `access.agentScoped`
 * opens it to every active brokerage agent of the organization as well,
 * limited to the agent's own rows (scope 'own').
 *
 * The first report, Submissions (BACKLOG-3513 PR-3a), reads its rows through
 * public.broker_report_submissions_rows (migration 20261112200000), a SECURITY
 * INVOKER function: transaction_submissions RLS bounds every row it returns.
 *
 * Report authors (BACKLOG-3511): bound every report source's rows with the
 * helper public.org_report_scope(org) from migration 20261108190000 and these
 * two SELECT policies, nothing wider:
 *   org-wide : USING (public.org_report_scope(organization_id) = 'all')
 *   own rows : USING (public.org_report_scope(organization_id) = 'own'
 *                     AND agent_user_id = (SELECT auth.uid()))
 * The helper answers 'all' for an active broker / admin / it_admin and 'own'
 * for an active agent of a brokerage organization, NULL otherwise. The page's
 * 'own' filter only narrows inside that bound. Harness and controls:
 * supabase/tests/backlog-3511/. The helper's role list is compared to
 * FULL_PORTAL_ROLES by __tests__/reports-3511/roleParity.test.ts.
 */

import type { FULL_PORTAL_ROLES } from '@keepr/shared';

/** A full portal role: broker, admin or it_admin. */
export type ReportRole = (typeof FULL_PORTAL_ROLES)[number];

export interface ReportAccess {
  /** Full portal roles that may open the report. */
  roles: readonly ReportRole[];
  /** Brokerage agents may open it too, scoped to their own rows. */
  agentScoped: boolean;
}

export interface ReportDefinition {
  /** URL segment: /dashboard/reports/<slug>. Unique. */
  slug: string;
  title: string;
  description: string;
  /** Where the rows come from (table, view or RPC), named for review. */
  source: string;
  access: ReportAccess;
}

/** The Submissions report's sorts: the row function's sort whitelist. */
export const SUBMISSIONS_SORT_KEYS = ['newest', 'oldest', 'status', 'price_desc', 'price_asc'] as const;

export const SUBMISSIONS_REPORT: ReportDefinition = {
  slug: 'submissions',
  title: 'Submissions',
  description: 'Every deal sent for review, one row per deal, with filters for status, agent and date.',
  source: 'rpc broker_report_submissions_rows_multi (migration 20261114100000)',
  access: { roles: ['broker', 'admin', 'it_admin'], agentScoped: true },
};

export const REPORT_REGISTRY: readonly ReportDefinition[] = [SUBMISSIONS_REPORT];
