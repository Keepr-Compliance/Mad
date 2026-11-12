/**
 * Submissions report: the server read — BACKLOG-3513 PR-3a.
 *
 * Rows come from ONE place: public.broker_report_submissions_rows (migration
 * 20261112200000). That function is SECURITY INVOKER, so transaction_submissions
 * RLS bounds every row, and it applies the Submissions page's list rules (no
 * 'uploading' rows, one row per deal) and the caller's scope in the database.
 * This module never reads transaction_submissions itself and never decides
 * whose rows the caller sees.
 *
 * The brokerage service state comes from public.broker_report_scope (same
 * migration), the function the row function asks for its scope.
 *
 * Every call goes through the caller's SESSION client (report-gate.ts). The
 * organization is the one the gate admitted, never a URL value.
 */

import type { ReportCaller } from '@/lib/reports/report-gate';
import { resolveUserNames } from '@/lib/submissions/names';
import {
  SUBMISSIONS_REPORT_PAGE_SIZE,
  dateBounds,
  type SubmissionsReportFilters,
} from '@/lib/reports/datasets/submissions-filters';

export const SUBMISSIONS_ROWS_RPC = 'broker_report_submissions_rows';
export const REPORT_SCOPE_RPC = 'broker_report_scope';

/** At most this many row-function pages are read to list the agents in scope. */
const AGENT_OPTION_PAGES = 10;
const AGENT_OPTION_PAGE_SIZE = 200;

export interface SubmissionsReportRow {
  id: string;
  submitted_by: string | null;
  property_address: string;
  property_city: string | null;
  property_state: string | null;
  transaction_type: string;
  status: string;
  listing_price: number | null;
  sale_price: number | null;
  created_at: string;
  closed_at: string | null;
}

interface RpcRow extends SubmissionsReportRow {
  total_count: number | string;
}

export interface AgentOption {
  id: string;
  label: string;
}

export type SubmissionsReportData =
  | {
      ok: true;
      rows: SubmissionsReportRow[];
      /** Deals matching the filters (the row function's total_count). */
      total: number;
      page: number;
      totalPages: number;
      /** The brokerage's service is off: the database limits everyone to their own submissions. */
      serviceOff: boolean;
      /** Submitter names for the rows shown. null: not looked up (agent) or the lookup failed. */
      names: ReadonlyMap<string, string> | null;
      /** Agents with a deal under the current status and date filters. Empty for an agent caller. */
      agents: AgentOption[];
    }
  | { ok: false };

type Rpc = ReportCaller['supabase'];

function rowArgs(caller: ReportCaller, filters: SubmissionsReportFilters, agent: string | null, limit: number, offset: number) {
  const { from, to } = dateBounds(filters);
  return {
    p_org: caller.organizationId,
    p_def: null,
    p_status: filters.status === 'all' ? null : filters.status,
    p_agent: agent,
    p_from: from,
    p_to: to,
    p_sort: filters.sort,
    p_limit: limit,
    p_offset: offset,
  };
}

async function readRows(
  supabase: Rpc,
  args: ReturnType<typeof rowArgs>
): Promise<{ rows: RpcRow[]; total: number } | null> {
  const { data, error } = await supabase.rpc(SUBMISSIONS_ROWS_RPC, args);
  if (error || !Array.isArray(data)) {
    console.error('[reports] submissions rows unavailable:', error?.message);
    return null;
  }
  const rows = data as RpcRow[];
  return { rows, total: rows.length > 0 ? Number(rows[0].total_count) : 0 };
}

async function readServiceOff(supabase: Rpc, orgId: string): Promise<boolean | null> {
  const { data, error } = await supabase.rpc(REPORT_SCOPE_RPC, { p_org: orgId, p_def: null });
  if (error || data === null || typeof data !== 'object') {
    console.error('[reports] report scope unavailable:', error?.message);
    return null;
  }
  return (data as { service_off?: unknown }).service_off === true;
}

/** Every submitter with a deal under the status and date filters (the agent filter ignored). */
async function readAgentOptions(caller: ReportCaller, filters: SubmissionsReportFilters): Promise<AgentOption[]> {
  const ids = new Set<string>();
  for (let page = 0; page < AGENT_OPTION_PAGES; page += 1) {
    const read = await readRows(
      caller.supabase,
      rowArgs(caller, { ...filters, sort: 'newest' }, null, AGENT_OPTION_PAGE_SIZE, page * AGENT_OPTION_PAGE_SIZE)
    );
    if (!read) return [];
    for (const r of read.rows) if (r.submitted_by) ids.add(r.submitted_by);
    if ((page + 1) * AGENT_OPTION_PAGE_SIZE >= read.total) break;
  }
  if (filters.agent) ids.add(filters.agent);
  const names = await resolveUserNames(caller.supabase, ids);
  const sorted = Array.from(ids).sort();
  if (names === null) return sorted.map((id, i) => ({ id, label: `Agent ${i + 1}` }));
  return sorted
    .map((id) => ({ id, label: names.get(id) ?? 'Former member' }))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
}

function strip(row: RpcRow): SubmissionsReportRow {
  const { total_count: _total, ...rest } = row;
  return rest;
}

/**
 * One page of the report. A page past the end shows the last page. Any failed
 * read returns { ok: false }: the page says the report could not load, never
 * "no submissions".
 */
export async function loadSubmissionsReport(
  caller: ReportCaller,
  filters: SubmissionsReportFilters
): Promise<SubmissionsReportData> {
  const pageSize = SUBMISSIONS_REPORT_PAGE_SIZE;
  const serviceOff = await readServiceOff(caller.supabase, caller.organizationId);
  if (serviceOff === null) return { ok: false };

  let page = filters.page;
  let read = await readRows(caller.supabase, rowArgs(caller, filters, filters.agent, pageSize, (page - 1) * pageSize));
  if (!read) return { ok: false };

  // total_count rides on each row, so a page past the end carries no total: read the first page for it.
  if (read.rows.length === 0 && page > 1) {
    const first = await readRows(caller.supabase, rowArgs(caller, filters, filters.agent, pageSize, 0));
    if (!first) return { ok: false };
    page = Math.max(1, Math.ceil(first.total / pageSize));
    read = page === 1 ? first : await readRows(caller.supabase, rowArgs(caller, filters, filters.agent, pageSize, (page - 1) * pageSize));
    if (!read) return { ok: false };
  }

  const rows = read.rows.map(strip);
  const full = caller.kind === 'full';
  const names = full ? await resolveUserNames(caller.supabase, rows.map((r) => r.submitted_by)) : null;
  const agents = full ? await readAgentOptions(caller, filters) : [];

  return {
    ok: true,
    rows,
    total: read.total,
    page,
    totalPages: Math.max(1, Math.ceil(read.total / pageSize)),
    serviceOff,
    names,
    agents,
  };
}
