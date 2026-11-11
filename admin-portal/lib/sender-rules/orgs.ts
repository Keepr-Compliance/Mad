/**
 * Sender rules — the test-org picker's list (BACKLOG-4186).
 *
 * Source: admin_list_organizations() (supabase/migrations/20261031160000_backlog_4098_...sql),
 * which answers {success: false} to a caller without an internal role and
 * {success: true, organizations: [...] | null} otherwise (jsonb_agg of no rows is null).
 * Every org is listed (founder 2026-11-09): test orgs are badged and sorted first, nothing is
 * filtered out. A refusal or an unreadable answer is a failure, never an empty list.
 *
 * Pure: no Supabase, no React.
 */

export interface PickOrg {
  id: string;
  name: string;
  isTest: boolean;
}

export type OrgListResult = { ok: true; orgs: PickOrg[] } | { ok: false };

/** The rpc answer -> the picker's orgs, test orgs first, then by name. */
export function parseOrgList(data: unknown, error: unknown): OrgListResult {
  if (error) return { ok: false };
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
  const d = data as { success?: unknown; organizations?: unknown };
  if (d.success !== true) return { ok: false };
  if (d.organizations === null) return { ok: true, orgs: [] };
  if (!Array.isArray(d.organizations)) return { ok: false };
  const orgs: PickOrg[] = [];
  for (const row of d.organizations) {
    if (row === null || typeof row !== 'object') continue;
    const { id, name, is_test } = row as { id?: unknown; name?: unknown; is_test?: unknown };
    if (typeof id !== 'string' || id === '') continue;
    orgs.push({ id, name: typeof name === 'string' && name !== '' ? name : id, isTest: is_test === true });
  }
  orgs.sort((a, b) => (a.isTest === b.isTest ? a.name.localeCompare(b.name) : a.isTest ? -1 : 1));
  return { ok: true, orgs };
}

/** Orgs whose name contains `query` (case-insensitive). An empty query matches every org. */
export function filterOrgs(orgs: PickOrg[], query: string): PickOrg[] {
  const q = query.trim().toLowerCase();
  return q === '' ? orgs : orgs.filter((o) => o.name.toLowerCase().includes(q));
}
