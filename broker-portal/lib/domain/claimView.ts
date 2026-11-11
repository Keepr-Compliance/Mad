/**
 * Server-side read and shaping of this organization's domain claims — BACKLOG-3962.
 *
 * Reads through the caller's own session client: the domain_claims select policy admits only
 * an admin or IT admin of the organization (is_org_admin), so RLS is the second gate behind the
 * page's role check.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { displayDomain } from '@/lib/domain/normalize';
import { claimRecordName } from '@/lib/domain/doh';
import {
  CHECK_RESULTS,
  CLAIM_STATUSES,
  isNotDeployedError,
  type DomainCheckResult,
  type DomainClaimStatus,
  type DomainClaimView,
} from '@/lib/domain/claims';

export interface DomainClaimRow {
  id: string;
  domain: string;
  token: string;
  status: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_check_result: string | null;
  created_by?: string | null;
}

export const DOMAIN_CLAIM_SELECT = 'id, domain, token, status, verified_at, last_checked_at, last_check_result, created_by';

/** Statuses the page lists. Withdrawn rows are history; a revoked row tells the admin why it stopped. */
export const LISTED_STATUSES = ['pending', 'verified', 'lapsed', 'revoked'] as const;

export function toDomainClaimView(row: DomainClaimRow, addedBy: string | null = null): DomainClaimView | null {
  if (!(CLAIM_STATUSES as readonly string[]).includes(row.status)) return null;
  const status = row.status as DomainClaimStatus;
  const shown = displayDomain(row.domain);
  const result = (CHECK_RESULTS as readonly string[]).includes(row.last_check_result ?? '')
    ? (row.last_check_result as DomainCheckResult)
    : null;
  return {
    id: row.id,
    domain: shown.ascii,
    unicodeDomain: shown.unicode,
    isInternationalized: shown.differs,
    status,
    recordName: claimRecordName(row.domain),
    recordValue: status === 'revoked' ? null : row.token,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    lastCheckResult: result,
    addedBy,
  };
}

type Reader = Pick<SupabaseClient, 'from'>;

export type LoadDomainClaims =
  | { ok: true; claims: DomainClaimView[] }
  | { ok: false; reason: 'unavailable' | 'error' };

export async function loadDomainClaims(client: Reader, organizationId: string): Promise<LoadDomainClaims> {
  const { data, error } = await client
    .from('domain_claims')
    .select(DOMAIN_CLAIM_SELECT)
    .eq('organization_id', organizationId)
    .in('status', LISTED_STATUSES)
    .order('created_at', { ascending: true });
  if (error) return { ok: false, reason: isNotDeployedError(error) ? 'unavailable' : 'error' };
  const rows = Array.isArray(data) ? (data as DomainClaimRow[]) : [];
  const names = await memberNames(client, organizationId, rows.map((r) => r.created_by));
  return {
    ok: true,
    claims: rows
      .map((r) => toDomainClaimView(r, r.created_by ? (names.get(r.created_by) ?? null) : null))
      .filter((v): v is DomainClaimView => v !== null),
  };
}

interface MemberUser {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
}

/** Display name, else email, else null. */
function personLabel(u: MemberUser | null | undefined): string | null {
  if (!u) return null;
  const display = u.display_name?.trim();
  if (display) return display;
  const full = [u.first_name, u.last_name].map((p) => p?.trim()).filter(Boolean).join(' ');
  return full || u.email?.trim() || null;
}

/**
 * Names for the people who added the listed claims, read through the caller's session client
 * from this organization's own member rows (the same read /dashboard/users makes). A failure or a
 * person who has left the organization leaves the name out; the page then shows a dash.
 */
async function memberNames(
  client: Reader,
  organizationId: string,
  userIds: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter((i): i is string => typeof i === 'string' && i !== ''))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await client
      .from('organization_members')
      .select('user_id, user:users!organization_members_user_id_public_users_fkey (email, first_name, last_name, display_name)')
      .eq('organization_id', organizationId)
      .in('user_id', ids);
    if (error || !Array.isArray(data)) return out;
    for (const row of data as unknown as Array<{ user_id: string; user: MemberUser | MemberUser[] | null }>) {
      const u = Array.isArray(row.user) ? row.user[0] : row.user;
      const label = personLabel(u);
      if (label) out.set(row.user_id, label);
    }
  } catch {
    /* names are a convenience */
  }
  return out;
}

/** The ASCII names of this organization's verified domains, oldest first. Never throws. */
export async function loadVerifiedDomains(client: Reader, organizationId: string): Promise<string[]> {
  try {
    const { data, error } = await client
      .from('domain_claims')
      .select('domain')
      .eq('organization_id', organizationId)
      .eq('status', 'verified')
      .order('created_at', { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return (data as Array<{ domain: string }>).map((r) => displayDomain(r.domain).unicode);
  } catch {
    return [];
  }
}
