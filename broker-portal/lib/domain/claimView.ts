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
}

export const DOMAIN_CLAIM_SELECT = 'id, domain, token, status, verified_at, last_checked_at, last_check_result';

/** Statuses the page lists. Withdrawn rows are history; a revoked row tells the admin why it stopped. */
export const LISTED_STATUSES = ['pending', 'verified', 'lapsed', 'revoked'] as const;

export function toDomainClaimView(row: DomainClaimRow): DomainClaimView | null {
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
  return { ok: true, claims: rows.map(toDomainClaimView).filter((v): v is DomainClaimView => v !== null) };
}
