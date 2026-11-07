/**
 * Broker Reports access gate — BACKLOG-3505.
 *
 * One place decides what the Reports surfaces show the caller: the sidebar
 * entry (app/dashboard/layout.tsx via listMyReports), the index
 * (requireMyReports) and every report page (requireReportAccess), so the link
 * and the pages cannot disagree.
 *
 * FAIL-CLOSED on every refusal, in this fixed order:
 *   1. impersonating (a support session never sees a customer's reports);
 *   2. not signed in;
 *   3. the caller's own licence is suspended, OR the licence read failed
 *      (`suspended !== false`);
 *   4. the brokerage is suspended, OR that read failed (`orgSuspended !== false`);
 *   5. the role is not admitted. Admitted: a FULL portal user (broker, admin,
 *      it_admin — founder ruling 85aaac88) and a floor user routed on a
 *      BROKERAGE row whose role is exactly 'agent'. Everyone else refuses: the
 *      owner of a personal organization, an unlicensed or deactivated member,
 *      an unrecognised role (which the classifier floors), unknown, none.
 *   6. the plan feature `broker_reports` is off, absent, or the feature read
 *      failed (isFeatureEnabledFailClosed). Asked only on the brokerage
 *      organization step 5 admitted, never on a personal one.
 *
 * Scope per report: 'all' for a full role the report names; 'own' for an agent,
 * and only when the report is agentScoped (founder: every active agent of the
 * organization, own rows only). A report page applies 'own' as a filter on the
 * agent column in its query; the database policy remains the outer bound.
 *
 * Reads go through the SESSION client only (lib/supabase/server). Never the
 * service client: RLS must bound every report row.
 */

import { notFound } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { getPortalAccess, type PortalAccessResult } from '@/lib/auth/portalAccess';
import { FULL_PORTAL_ROLES } from '@/lib/auth/membership';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';
import { REPORT_REGISTRY, type ReportDefinition, type ReportRole } from '@/lib/reports/registry';
import type { createClient } from '@/lib/supabase/server';

/** feature_definitions.key seeded by 20261108140000_backlog_3505_broker_reports_feature.sql */
export const BROKER_REPORTS_FEATURE_KEY = 'broker_reports';

/** The one floor role Reports admits (agent-scoped reports only). */
const AGENT_ROLE = 'agent';

export type ReportScope = 'all' | 'own';

/** Who is asking, once the gate has admitted them. */
export type ReportCallerKind = 'full' | 'agent';

export interface ReportCaller {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  organizationId: string;
  role: string;
  kind: ReportCallerKind;
}

export interface ReportGrant {
  caller: ReportCaller;
  report: ReportDefinition;
  scope: ReportScope;
}

export interface MyReports {
  caller: ReportCaller;
  reports: { report: ReportDefinition; scope: ReportScope }[];
}

function isFullRole(role: string): role is ReportRole {
  return (FULL_PORTAL_ROLES as readonly string[]).includes(role);
}

/**
 * The scope this caller gets on this report, or null when they may not open it.
 * Pure. Expects a caller getReportsCaller admitted.
 */
export function reportScopeFor(
  report: ReportDefinition,
  caller: Pick<ReportCaller, 'kind' | 'role'>
): ReportScope | null {
  // getReportsCaller admitted the role already: 'full' is broker/admin/it_admin,
  // 'agent' is exactly a brokerage agent. One guard each, so each is load-bearing.
  if (caller.kind === 'full') {
    return report.access.roles.includes(caller.role as ReportRole) ? 'all' : null;
  }
  if (caller.kind === 'agent') {
    return report.access.agentScoped ? 'own' : null;
  }
  return null;
}

/**
 * The admitted caller, or null. Never throws for a refusal: the layout calls
 * this through listMyReports and must not 404 every dashboard page.
 *
 * `portal`: an access result the caller already read IN THIS REQUEST (the
 * layout passes its own), so the membership, licence and brokerage reads are
 * not repeated. Omitted -> read here. Not React cache(): getPortalAccess is
 * also read by billing server actions after writes, where a per-request memo
 * could hand back a stale answer, and react@18.3.1 (jest) has no cache().
 */
export async function getReportsCaller(portal?: PortalAccessResult | null): Promise<ReportCaller | null> {
  if (await getImpersonationSession()) return null;

  if (portal === undefined) portal = await getPortalAccess();
  if (!portal) return null;
  if (portal.suspended !== false) return null;
  if (portal.orgSuspended !== false) return null;

  const { access } = portal;
  let kind: ReportCallerKind;
  if (access.kind === 'full' && isFullRole(access.role)) {
    kind = 'full';
  } else if (access.kind === 'floor' && access.via === 'brokerage' && access.role === AGENT_ROLE) {
    kind = 'agent';
  } else {
    return null;
  }

  if (!(await isFeatureEnabledFailClosed(access.organizationId, BROKER_REPORTS_FEATURE_KEY))) return null;

  return {
    supabase: portal.supabase,
    userId: portal.user.id,
    organizationId: access.organizationId,
    role: access.role,
    kind,
  };
}

/** The reports this caller may open, or null when the gate refuses. */
export async function listMyReports(
  registry: readonly ReportDefinition[] = REPORT_REGISTRY,
  portal?: PortalAccessResult | null
): Promise<MyReports | null> {
  const caller = await getReportsCaller(portal);
  if (!caller) return null;
  const reports: MyReports['reports'] = [];
  for (const report of registry) {
    const scope = reportScopeFor(report, caller);
    if (scope) reports.push({ report, scope });
  }
  return { caller, reports };
}

/**
 * For the Reports index. notFound() when the gate refuses OR the caller has no
 * report at all, so the index exists exactly when the sidebar entry does.
 */
export async function requireMyReports(
  registry: readonly ReportDefinition[] = REPORT_REGISTRY
): Promise<MyReports> {
  const mine = await listMyReports(registry);
  if (!mine || mine.reports.length === 0) notFound();
  return mine;
}

/** For one report page. notFound() on an unknown slug or any refusal. */
export async function requireReportAccess(
  slug: string,
  registry: readonly ReportDefinition[] = REPORT_REGISTRY
): Promise<ReportGrant> {
  const report = registry.find((r) => r.slug === slug);
  if (!report) notFound();
  const caller = await getReportsCaller();
  if (!caller) notFound();
  const scope = reportScopeFor(report, caller);
  if (!scope) notFound();
  return { caller, report, scope };
}
