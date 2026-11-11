/**
 * Server-side reads for the domain capture screens — BACKLOG-3962 PR3b.
 *
 * loadCaptureSection: the "Move people onto your brokerage" table. Returns null unless the caller
 * passed requireDomainClaimAccess AND the brokerage has at least one verified claim. The
 * organization is the session's (access.organizationId), never a browser value.
 *   - Candidates come from domain_capture_candidates through the caller's own session client (the
 *     function re-checks is_org_admin on auth.uid()).
 *   - Ended moves (opted out, switched, cancelled) come from domain_capture_history, also through the
 *     session client (admin of the organization, checked inside). Read only.
 *
 * loadCaptureNotice: the signed-in person's own scheduled move (caller_capture_notice), for the
 * personal-owner banner. Read only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DomainClaimAccess } from '@/lib/domain/access';
import { isNotDeployedError, type DomainClaimView } from '@/lib/domain/claims';

export interface CaptureEnded {
  status: string;
  reason: string | null;
}

export interface CaptureRow {
  userId: string;
  email: string;
  /** Display name, else the email (the database's fallback). */
  name: string;
  convertible: boolean;
  reason: string | null;
  switchId: string | null;
  switchAt: string | null;
  noticeDelivered: boolean | null;
  /** Why the hourly job last put a scheduled move off (dns_not_fresh | billing_not_ready | billing_setup_incomplete). */
  lastDeferReason: string | null;
  ended: CaptureEnded | null;
}

export interface CaptureDomainView {
  claimId: string;
  domain: string;
  state: 'ok' | 'unavailable' | 'error';
  rows: CaptureRow[];
}

type Rpc = Pick<SupabaseClient, 'rpc'>;

export interface EndedRow {
  claimId: string;
  userId: string;
  email: string;
  name: string;
  status: string;
  reason: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toRow(v: unknown): CaptureRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const userId = str(r.user_id);
  if (!userId) return null;
  const email = str(r.email) ?? '';
  return {
    userId,
    email,
    name: str(r.name)?.trim() || email,
    convertible: r.convertible === true,
    reason: str(r.reason),
    switchId: str(r.switch_id),
    switchAt: str(r.switch_at),
    noticeDelivered: typeof r.notice_delivered === 'boolean' ? r.notice_delivered : null,
    lastDeferReason: str(r.last_defer_reason),
    ended: null,
  };
}

/** The organization's ended moves, newest first (domain_capture_history). Empty on any failure. */
async function loadEnded(client: Rpc, organizationId: string): Promise<EndedRow[]> {
  try {
    const { data, error } = (await client.rpc('domain_capture_history', { p_org: organizationId })) as {
      data: unknown;
      error: { code?: string } | null;
    };
    if (error || !data || typeof data !== 'object') return [];
    const reply = data as Record<string, unknown>;
    if (reply.success !== true || !Array.isArray(reply.switches)) return [];
    const out: EndedRow[] = [];
    for (const v of reply.switches) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      const claimId = str(r.claim_id);
      const userId = str(r.user_id);
      const status = str(r.status);
      if (!claimId || !userId || !status || status === 'scheduled') continue;
      const email = str(r.email) ?? '';
      out.push({ claimId, userId, email, name: str(r.name)?.trim() || email, status, reason: str(r.reason) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Merge the candidate list with each person's latest ended move on the same claim. */
export function mergeEnded(rows: CaptureRow[], ended: EndedRow[], claimId: string): CaptureRow[] {
  const latest = new Map<string, EndedRow>();
  for (const e of ended) {
    if (e.claimId !== claimId) continue;
    if (!latest.has(e.userId)) latest.set(e.userId, e); // newest first
  }
  const out = rows.map((r) => {
    if (r.switchId) return r; // a scheduled move outranks history
    const e = latest.get(r.userId);
    return e ? { ...r, ended: { status: e.status, reason: e.reason } } : r;
  });
  const listed = new Set(rows.map((r) => r.userId));
  for (const e of latest.values()) {
    if (listed.has(e.userId)) continue;
    // No longer a candidate (for example, now a member after the move). Shown, never selectable.
    out.push({
      userId: e.userId,
      email: e.email,
      name: e.name,
      convertible: false,
      reason: null,
      switchId: null,
      switchAt: null,
      noticeDelivered: null,
      lastDeferReason: null,
      ended: { status: e.status, reason: e.reason },
    });
  }
  return out;
}

/** Whether the admin may tick this row for a new move. */
export function isSelectable(row: CaptureRow): boolean {
  if (!row.convertible || row.switchId) return false;
  if (row.ended && (row.ended.status === 'opted_out' || row.ended.status === 'switched')) return false;
  return true;
}

export async function loadCaptureSection(
  access: DomainClaimAccess,
  claims: DomainClaimView[],
): Promise<CaptureDomainView[] | null> {
  if (!access.ok) return null;
  const verified = claims.filter((c) => c.status === 'verified');
  if (verified.length === 0) return null;

  const ended = await loadEnded(access.supabase as Rpc, access.organizationId);
  const out: CaptureDomainView[] = [];
  for (const claim of verified) {
    const { data, error } = (await (access.supabase as Rpc).rpc('domain_capture_candidates', {
      p_org: access.organizationId,
      p_claim: claim.id,
    })) as { data: unknown; error: { code?: string } | null };
    if (error) {
      out.push({ claimId: claim.id, domain: claim.domain, state: isNotDeployedError(error) ? 'unavailable' : 'error', rows: [] });
      continue;
    }
    const reply = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    if (reply.success !== true) {
      out.push({ claimId: claim.id, domain: claim.domain, state: 'error', rows: [] });
      continue;
    }
    const rows = (Array.isArray(reply.candidates) ? reply.candidates : [])
      .map(toRow)
      .filter((r): r is CaptureRow => r !== null);
    out.push({ claimId: claim.id, domain: claim.domain, state: 'ok', rows: mergeEnded(rows, ended, claim.id) });
  }
  return out;
}

export interface CaptureNotice {
  switchId: string;
  brokerageName: string;
  domain: string;
  switchAt: string;
}

/** The caller's own scheduled move, or null. Never writes. */
export async function loadCaptureNotice(client: Rpc): Promise<CaptureNotice | null> {
  try {
    const { data, error } = (await client.rpc('caller_capture_notice')) as {
      data: unknown;
      error: { code?: string } | null;
    };
    if (error || !data || typeof data !== 'object') return null;
    const reply = data as Record<string, unknown>;
    if (reply.success !== true || !Array.isArray(reply.switches)) return null;
    for (const s of reply.switches) {
      if (!s || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      const switchId = str(r.switch_id);
      const switchAt = str(r.switch_at);
      if (!switchId || !switchAt) continue;
      const name = str(r.brokerage_name)?.trim();
      return { switchId, switchAt, brokerageName: name || 'Your brokerage', domain: str(r.domain) ?? '' };
    }
    return null;
  } catch {
    return null;
  }
}
