/**
 * Domain claims on the organization page (BACKLOG-3962 PR2): row shape from admin_list_domain_claims
 * (supabase/migrations/20261112100000_backlog_3962_domain_claims.sql) and the staff-facing labels.
 */

export interface AdminDomainClaim {
  id: string;
  domain: string;
  status: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_check_result: string | null;
  consecutive_misses: number;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/** Statuses a staff member can revoke (admin_revoke_domain_claim refuses the others). */
export const REVOCABLE_STATUSES = ['pending', 'verified', 'lapsed'] as const;

export const REVOKE_REASON_MAX = 500;

export function isRevocable(status: string): boolean {
  return (REVOCABLE_STATUSES as readonly string[]).includes(status);
}

export function domainClaimStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'verified':
      return 'Verified';
    case 'lapsed':
      return 'Lapsed';
    case 'withdrawn':
      return 'Withdrawn';
    case 'revoked':
      return 'Revoked';
    default:
      return status;
  }
}

export function checkRevokeReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmed) return { ok: false, error: 'Enter a reason.' };
  if (trimmed.length > REVOKE_REASON_MAX) return { ok: false, error: `Keep the reason under ${REVOKE_REASON_MAX} characters.` };
  return { ok: true, reason: trimmed };
}

export function revokeErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_authenticated':
    case 'not_internal_user':
    case 'insufficient_permissions':
      return 'You need permission to edit organizations to revoke a domain.';
    case 'invalid_reason':
      return 'Enter a reason.';
    case 'claim_not_found':
      return 'This domain claim no longer exists.';
    case 'not_revocable':
      return 'This domain claim is already withdrawn or revoked.';
    default:
      return 'The domain could not be revoked. Try again.';
  }
}
