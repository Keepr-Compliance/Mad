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
 * PR-1 registers NO report: the section ships invisible. The first report is
 * registered by a later PR, together with the database policy that bounds its
 * rows.
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

export const REPORT_REGISTRY: readonly ReportDefinition[] = [];
