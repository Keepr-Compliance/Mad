/**
 * Broker shared reports: the server reads — BACKLOG-3513 PR-3b.
 *
 * Session client only (the gate's caller.supabase). Functions in migration
 * 20261112200000 decide who sees what:
 *  - broker_report_def_list(p_org): the shared reports the caller has a level on;
 *  - broker_report_def_get(p_def): one of them, or "Report not found";
 *  - broker_report_share_list(p_def): owner / editor only; read here only to
 *    learn whether the owner is still an active member (owner.role is null when
 *    they are not, owner.id null when their account is gone).
 */

import { notFound } from 'next/navigation';
import { getReportsCaller, type ReportCaller } from '@/lib/reports/report-gate';
import { SUBMISSIONS_REPORT } from '@/lib/reports/registry';
import { parseDefinition, parseLevel, parseShareState, type DefinitionRecord, type ReportLevel } from '@/lib/reports/definitions/parse';

export const DEF_LIST_RPC = 'broker_report_def_list';
export const DEF_GET_RPC = 'broker_report_def_get';
export const SHARE_LIST_RPC = 'broker_report_share_list';

/** Used when the brokerage's name cannot be read. */
export const ORG_NAME_FALLBACK = 'your brokerage';

export interface SharedReportListItem {
  id: string;
  name: string;
  level: ReportLevel | null;
  ownerName: string;
}

/** The shared reports for the index. Any failure (e.g. the functions are not deployed yet) is an empty list. */
export async function listSharedReports(caller: ReportCaller): Promise<SharedReportListItem[]> {
  try {
    const { data, error } = await caller.supabase.rpc(DEF_LIST_RPC, { p_org: caller.organizationId });
    if (error || !Array.isArray(data)) {
      if (error) console.error('[reports] shared reports unavailable:', error.message);
      return [];
    }
    return (data as Record<string, unknown>[])
      .filter((r) => typeof r?.id === 'string' && r.dataset_key === 'submissions')
      .map((r) => ({
        id: r.id as string,
        name: typeof r.name === 'string' ? r.name : '',
        level: parseLevel(r.level),
        ownerName: typeof r.owner_name === 'string' ? r.owner_name : '',
      }));
  } catch (err) {
    console.error('[reports] shared reports unavailable:', err);
    return [];
  }
}

export interface DefinitionAccess {
  caller: ReportCaller;
  definition: DefinitionRecord;
  /** The owner is gone or no longer an active member. Known only to owners and editors (share_list). */
  ownerInactive: boolean;
  orgName: string;
}

async function readOrgName(caller: ReportCaller): Promise<string> {
  try {
    const { data, error } = await caller.supabase.from('organizations').select('name').eq('id', caller.organizationId).maybeSingle();
    const name = (data as { name?: unknown } | null)?.name;
    if (error || typeof name !== 'string' || !name.trim()) return ORG_NAME_FALLBACK;
    return name.trim();
  } catch {
    return ORG_NAME_FALLBACK;
  }
}

async function readOwnerInactive(caller: ReportCaller, def: DefinitionRecord): Promise<boolean> {
  // The caller IS the owner: active by definition. A viewer cannot read share_list: unknown, not offered.
  if (def.level !== 'editor') return false;
  try {
    const { data, error } = await caller.supabase.rpc(SHARE_LIST_RPC, { p_def: def.id });
    if (error || data === null || typeof data !== 'object') return false;
    const { owner } = parseShareState(data);
    return owner.id === null || owner.role === null;
  } catch {
    return false;
  }
}

/**
 * For /dashboard/reports/d/<id>. notFound() when the report gate refuses, the
 * database refuses the definition, it belongs to another organization than the
 * one the gate admitted, or it is not a Submissions report.
 */
export async function requireDefinitionAccess(id: string): Promise<DefinitionAccess> {
  const caller = await getReportsCaller();
  if (!caller) notFound();
  const { data, error } = await caller.supabase.rpc(DEF_GET_RPC, { p_def: id });
  if (error || data === null || typeof data !== 'object') notFound();
  const raw = data as Record<string, unknown>;
  const definition = parseDefinition(raw);
  if (!definition || !definition.level) notFound();
  if (raw.organization_id !== caller.organizationId || raw.dataset_key !== 'submissions') notFound();
  const [ownerInactive, orgName] = await Promise.all([readOwnerInactive(caller, definition), readOrgName(caller)]);
  return { caller, definition, ownerInactive, orgName };
}

/** The dataset a definition reads: today only Submissions. */
export const DEFINITION_DATASET = SUBMISSIONS_REPORT;
