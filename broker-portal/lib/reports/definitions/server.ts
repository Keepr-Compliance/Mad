/**
 * Broker shared reports: the server reads — BACKLOG-3513 PR-3b.
 *
 * Session client only (the gate's caller.supabase). Functions in migrations
 * 20261112200000 and 20261112210000 decide who sees what:
 *  - broker_report_def_list(p_org): the shared reports the caller has a level on;
 *  - broker_report_orphans(p_org): reports whose owner is gone or deactivated,
 *    for an active broker / admin / IT admin; used only to mark those reports
 *    in Shared reports (the "Needs an owner" group was removed, ruling A).
 *    No definition, no rows;
 *  - broker_report_def_get(p_def): one report the caller has a level on, with
 *    reassign_available, or "Report not found".
 */

import { notFound } from 'next/navigation';
import { getReportsCaller, type ReportCaller } from '@/lib/reports/report-gate';
import { SUBMISSIONS_REPORT } from '@/lib/reports/registry';
import {
  parseDefinition,
  parseLevel,
  parseOrphans,
  type DefinitionRecord,
  type OrphanReport,
  type ReportLevel,
} from '@/lib/reports/definitions/parse';

export const DEF_LIST_RPC = 'broker_report_def_list';
export const DEF_GET_RPC = 'broker_report_def_get';
export const ORPHANS_RPC = 'broker_report_orphans';

/** Used when the brokerage's name cannot be read. */
export const ORG_NAME_FALLBACK = 'your brokerage';

export interface SharedReportListItem {
  id: string;
  name: string;
  level: ReportLevel | null;
  ownerName: string;
  /** Set when the owner is gone or deactivated and the caller may take it over. */
  ownerState: OrphanReport['ownerState'] | null;
}

export interface SharedReportLists {
  /** Reports the caller can open (has a level on). */
  shared: SharedReportListItem[];
  /** Reports whose owner is gone, NOT shared with the caller: Take over only, no link. */
  needsOwner: OrphanReport[];
}

async function readList(caller: ReportCaller, fn: string): Promise<unknown> {
  try {
    const { data, error } = await caller.supabase.rpc(fn, { p_org: caller.organizationId });
    if (error) {
      console.error(`[reports] ${fn} unavailable:`, error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[reports] ${fn} unavailable:`, err);
    return null;
  }
}

/**
 * The index lists. Any failure (e.g. the functions are not deployed yet) is an
 * empty list. Orphans are asked for full roles only (the database refuses
 * everyone else anyway) and merged into the shared list by id.
 */
export async function listSharedReports(caller: ReportCaller): Promise<SharedReportLists> {
  const [rawList, rawOrphans] = await Promise.all([
    readList(caller, DEF_LIST_RPC),
    caller.kind === 'full' ? readList(caller, ORPHANS_RPC) : Promise.resolve(null),
  ]);
  const orphans = parseOrphans(rawOrphans);
  const orphanById = new Map(orphans.map((o) => [o.id, o]));
  const shared: SharedReportListItem[] = (Array.isArray(rawList) ? (rawList as Record<string, unknown>[]) : [])
    .filter((r) => typeof r?.id === 'string' && r.dataset_key === 'submissions')
    .map((r) => ({
      id: r.id as string,
      name: typeof r.name === 'string' ? r.name : '',
      level: parseLevel(r.level),
      ownerName: typeof r.owner_name === 'string' ? r.owner_name : '',
      ownerState: orphanById.get(r.id as string)?.ownerState ?? null,
    }));
  const listed = new Set(shared.map((s) => s.id));
  const needsOwner: OrphanReport[] = [];
  for (const o of orphans) {
    if (listed.has(o.id)) continue;
    if (o.level) shared.push({ id: o.id, name: o.name, level: o.level, ownerName: o.ownerName, ownerState: o.ownerState });
    else needsOwner.push(o);
  }
  return { shared, needsOwner };
}

export interface DefinitionAccess {
  caller: ReportCaller;
  definition: DefinitionRecord;
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
  const orgName = await readOrgName(caller);
  return { caller, definition, orgName };
}

/** The dataset a definition reads: today only Submissions. */
export const DEFINITION_DATASET = SUBMISSIONS_REPORT;
