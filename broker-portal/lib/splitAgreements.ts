/**
 * Commission split agreements — BACKLOG-3504, reading BACKLOG-3503's schema.
 *
 * `agent_split_agreements` (renamed from `agent_commission_agreements`, PR #2715)
 * is an APPEND-ONLY, effective-dated ledger: one row is the whole agreement in
 * force for one agent from one date. A "change" is a new row with a later
 * `effective_from` (or, same date, a later `seq`). Nothing here is ever
 * UPDATEd or DELETEd — the grants on the table permit neither.
 *
 * Ordering contract, from the migration's own header (BACKLOG-3504 depends on
 * it and must not re-derive or "improve" it):
 *
 *   effective_from DESC, seq DESC — NEVER set_at.
 *
 * `set_at` defaults to `now()`, which is transaction-START time, so a
 * transaction that began earlier and wrote later has an EARLIER `set_at` and a
 * LATER `seq`. Ordering on `set_at` would return the row the broker wrote
 * FIRST instead of the correction.
 *
 * Columns selected below are exactly the post-trim shape (BACKLOG-3503,
 * `chore/BACKLOG-3503-trim-fees` @ 107c29deb): `agent_pct`, `brokerage_pct`,
 * `effective_from`, `note`, plus the identity/audit columns `id`, `seq`,
 * `organization_id`, `agent_user_id`, `set_by`, `set_at`. No office-fee
 * columns exist in that shape — do not add any here.
 *
 * RLS note (not re-implemented here, only relied on): `agent_split_agreements`
 * has two SELECT policies OR'd together — the broker/admin read
 * (`agent_split_agreements_select_writer`, via `can_write_split_agreements`)
 * and the own-row read (`agent_split_agreements_select_own`, via
 * `is_active_split_member`, which requires `license_status = 'active'`). A
 * plain `SELECT` against this table therefore returns the right rows for
 * BOTH a broker/admin viewing someone else's history AND an agent viewing
 * their own, including returning ZERO rows for a suspended agent's own read
 * — the same function below serves every caller in `getSplitHistory`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Role } from './types/users';

// ============================================================================
// Types
// ============================================================================

/** One row of `agent_split_agreements`, post-trim shape. */
export interface SplitAgreementRow {
  id: string;
  seq: number;
  organization_id: string;
  agent_user_id: string;
  agent_pct: number;
  brokerage_pct: number;
  /** date, "YYYY-MM-DD" — see formatEffectiveDate() for why this is never
   *  passed through `new Date(string)` for display. */
  effective_from: string;
  note: string | null;
  set_by: string;
  set_at: string;
}

/** A history row with the setter's name resolved, for the "Set by" column. */
export interface SplitAgreementHistoryRow extends SplitAgreementRow {
  setByUser: {
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

const SPLIT_COLUMNS =
  'id, seq, organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from, note, set_by, set_at';

// Foreign key name transcribed from
// supabase/migrations/20260922220719_backlog_3503_commission_agreements.sql:
//   CONSTRAINT agent_split_agreements_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.users(id)
const HISTORY_COLUMNS = `${SPLIT_COLUMNS}, setByUser:users!agent_split_agreements_set_by_fkey(display_name, first_name, last_name, email)`;

// ============================================================================
// Role gates
// ============================================================================

/** Splits apply to agent and broker agreements only — not the admin/it_admin
 *  role (mock: "Splits apply to agent and broker agreements, not the admin
 *  role"). Governs whether the Commission split section/column/card appears
 *  for a given SUBJECT, independent of who's viewing. */
export function splitAppliesToRole(role: Role): boolean {
  return role === 'agent' || role === 'broker';
}

/** Broker and admin may view AND edit another member's split; it_admin may
 *  not even read one (founder, 2026-09-22, restated by the PM 2026-09-25:
 *  "canManage does not change... a separate gate... is_admin'/'broker'`, and
 *  it_admin sees no split section at all"). View and edit are the same
 *  population today — kept as two names because the DB's own read/write
 *  policies are already unified this way (`can_write_split_agreements`
 *  fronts both SELECT policies for broker/admin), not because they differ. */
export function canViewSplit(role: Role): boolean {
  return role === 'admin' || role === 'broker';
}
export const canEditSplit = canViewSplit;

// ============================================================================
// Pure derivation — no I/O, so the ordering contract itself is unit-testable
// ============================================================================

/** Today as "YYYY-MM-DD" in the server's local calendar day. */
export function todayISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The agreement in force as of `asOfDate`, given rows ALREADY ordered
 * `effective_from DESC, seq DESC` (exactly what getSplitHistory returns).
 * Mirrors `split_agreement_in_force()`'s own SQL:
 *   WHERE effective_from <= p_on_date ORDER BY effective_from DESC, seq DESC LIMIT 1
 * done in application code so a single fetched history array serves both the
 * "current" figure and the history table without a second round trip.
 *
 * Pure — the ordering-contract regression test lives on this function: feed
 * it an UNORDERED or wrongly-ordered array and it will return the wrong row,
 * which is the point (see splitAgreements.test.ts's "ordering contract").
 */
export function deriveCurrentSplit<T extends SplitAgreementRow>(
  rows: readonly T[],
  asOfDate: string = todayISODate()
): T | null {
  for (const row of rows) {
    if (row.effective_from <= asOfDate) return row;
  }
  return null;
}

/** Effective_from is a plain SQL `date` ("YYYY-MM-DD"), not a timestamptz.
 *  `new Date("2026-01-01")` parses that as UTC midnight, which
 *  `Intl.DateTimeFormat` then renders in the VIEWER's local zone — a day
 *  earlier for every negative-UTC-offset timezone (all of the US). Every
 *  other date on this page (`joined_at`, `set_at`, ...) is a timestamptz and
 *  correctly uses `formatDate()`; this column is the one place that utility
 *  is wrong to reuse. Parsed as calendar-date components instead, exactly
 *  the way the signed-off mock's own `formatDateInputValue()` does it. */
export function formatEffectiveDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(y, m - 1, d)
  );
}

/** The three states the Users list's Split column can show. */
export type SplitListDisplay =
  | { kind: 'split'; agentPct: number; brokeragePct: number }
  | { kind: 'no-agreement' }
  | { kind: 'not-applicable'; reason: 'pending' | 'role' };

/**
 * The list-row display state for one member, given the org's current-splits
 * map (see getCurrentSplitsForOrg). Pure — no Supabase involved, so every
 * branch (pending / role-not-applicable / no-agreement-on-file / real split)
 * is a plain unit test.
 */
export function resolveSplitListDisplay(
  member: { role: Role; user_id: string | null },
  current: Pick<SplitAgreementRow, 'agent_pct' | 'brokerage_pct'> | undefined
): SplitListDisplay {
  if (!member.user_id) return { kind: 'not-applicable', reason: 'pending' };
  if (!splitAppliesToRole(member.role)) return { kind: 'not-applicable', reason: 'role' };
  if (!current) return { kind: 'no-agreement' };
  return { kind: 'split', agentPct: current.agent_pct, brokeragePct: current.brokerage_pct };
}

// ============================================================================
// Reads
// ============================================================================

/**
 * Every row ever set for one agent in one org, newest-in-force first
 * (`effective_from DESC, seq DESC`). Serves BOTH the broker/admin detail-page
 * read and an agent's own My Account read — see the RLS note at the top of
 * this file for why the same query is correct for both callers.
 *
 * Returns [] on any Supabase error (including an RLS refusal, e.g. a
 * suspended agent's own-row read) rather than throwing — a refused read and a
 * genuinely empty history are meant to be indistinguishable to the caller
 * (PM ruling 2026-09-25: same empty-state string for both).
 */
export async function getSplitHistory(
  client: SupabaseClient,
  organizationId: string,
  agentUserId: string
): Promise<SplitAgreementHistoryRow[]> {
  const { data, error } = await client
    .from('agent_split_agreements')
    .select(HISTORY_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('agent_user_id', agentUserId)
    .order('effective_from', { ascending: false })
    .order('seq', { ascending: false });

  if (error || !data) return [];

  // The join comes back as an array in some PostgREST configurations —
  // normalize to a single object or null, same pattern as
  // getUserDetails()/getOrganizationMembers() elsewhere in this portal.
  return (data as unknown[]).map((row) => {
    const r = row as SplitAgreementRow & { setByUser: unknown };
    const setByUser = Array.isArray(r.setByUser) ? (r.setByUser[0] ?? null) : (r.setByUser ?? null);
    return { ...r, setByUser } as SplitAgreementHistoryRow;
  });
}

/**
 * One query for the WHOLE org's currently-in-force splits, keyed by
 * agent_user_id — not N calls to split_agreement_in_force(), one per row.
 * PostgREST has no `DISTINCT ON`, so the reduction to "first row per agent"
 * happens here in application code, on rows the database has already sorted
 * `agent_user_id, effective_from DESC, seq DESC` — the same ordering contract
 * deriveCurrentSplit() applies for a single agent.
 */
export async function getCurrentSplitsForOrg(
  client: SupabaseClient,
  organizationId: string
): Promise<Map<string, SplitAgreementRow>> {
  const { data, error } = await client
    .from('agent_split_agreements')
    .select(SPLIT_COLUMNS)
    .eq('organization_id', organizationId)
    .order('agent_user_id', { ascending: true })
    .order('effective_from', { ascending: false })
    .order('seq', { ascending: false });

  const result = new Map<string, SplitAgreementRow>();
  if (error || !data) return result;

  // Group by agent — the DB has already sorted each group internally
  // `effective_from DESC, seq DESC`, so deriveCurrentSplit() (the same
  // function a single agent's query uses) applies per group unchanged rather
  // than re-deriving the ordering rule here a second time.
  const byAgent = new Map<string, SplitAgreementRow[]>();
  for (const row of data as SplitAgreementRow[]) {
    const group = byAgent.get(row.agent_user_id);
    if (group) group.push(row);
    else byAgent.set(row.agent_user_id, [row]);
  }

  const today = todayISODate();
  for (const [agentUserId, rows] of byAgent) {
    const current = deriveCurrentSplit(rows, today);
    if (current) result.set(agentUserId, current);
  }
  return result;
}
