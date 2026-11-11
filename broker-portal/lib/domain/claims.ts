/**
 * Brokerage domain claims: shared types and the wording for every outcome — BACKLOG-3962.
 *
 * No server imports: the settings client component imports the types and copy from here.
 */

export type DomainClaimStatus = 'pending' | 'verified' | 'lapsed' | 'withdrawn' | 'revoked';

export type DomainCheckResult =
  | 'verified'
  | 'not_found'
  | 'mismatch'
  | 'resolver_unavailable'
  | 'domain_taken';

/** One claim as the settings page shows it. Built on the server (lib/domain/claimView.ts). */
export interface DomainClaimView {
  id: string;
  /** The A-label: what is in DNS and what matching uses. */
  domain: string;
  /** The readable form. Equals `domain` unless the name is internationalised. */
  unicodeDomain: string;
  /** True when `unicodeDomain` differs from `domain`; the UI then shows both. */
  isInternationalized: boolean;
  status: DomainClaimStatus;
  recordName: string;
  /** The TXT value to publish. Shown to this org's admins by design; null once revoked. */
  recordValue: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckResult: DomainCheckResult | null;
  /** Who added the domain: display name, else email, else null. Resolved server-side. */
  addedBy: string | null;
}

export interface DomainClaimActionResult {
  success: boolean;
  message: string;
  result?: DomainCheckResult;
  status?: DomainClaimStatus;
  /** Display-only: the record was found at the doubled name. Never means verified. */
  doubledName?: boolean;
}

export const DOMAIN_CLAIM_UNAVAILABLE = "Domain verification isn't available yet.";
export const DOMAIN_CLAIM_NOT_AUTHORIZED = 'Only an admin or IT admin of this brokerage can verify a domain.';
export const DOMAIN_CLAIM_FAILED = 'Something went wrong. Try again.';
export const DOMAIN_CLAIM_INVALID = 'Enter only the domain, for example brokerage.com.';
export const DOMAIN_CLAIM_CONSUMER = "A personal email domain such as gmail.com can't be verified.";
export const DOMAIN_CLAIM_TOO_MANY = 'This brokerage already has 10 domains. Remove one first.';
export const DOMAIN_CLAIM_NOT_FOUND = 'That domain is no longer on this brokerage.';
export const DOMAIN_CLAIM_TOO_SOON = 'Wait 30 seconds between checks.';

export function domainTakenMessage(domain: string): string {
  return `Another organization has already verified ${domain}. Contact support@keeprcompliance.com.`;
}

/** Shown instead of the not-found text when the record sits at `_keepr.<domain>.<domain>`. */
export function doubledNameMessage(domain: string): string {
  return `We found the record at _keepr.${domain}.${domain}. Your DNS host added the domain twice. Change the Host to just _keepr.`;
}

/** The message for a check result (plan section 3). */
export function checkResultMessage(result: DomainCheckResult, domain: string): string {
  switch (result) {
    case 'verified':
      return `${domain} is verified.`;
    case 'not_found':
      return `We couldn't find the TXT record at _keepr.${domain} yet. New records usually show within minutes; some DNS hosts take up to 48 hours.`;
    case 'mismatch':
      return `We found a Keepr record at _keepr.${domain}, but its value doesn't match. Copy the value again exactly.`;
    case 'resolver_unavailable':
      return "We couldn't reach the DNS lookup service. Try again in a minute.";
    case 'domain_taken':
      return domainTakenMessage(domain);
  }
}

export const CHECK_RESULTS: readonly DomainCheckResult[] = [
  'verified',
  'not_found',
  'mismatch',
  'resolver_unavailable',
  'domain_taken',
];

export const CLAIM_STATUSES: readonly DomainClaimStatus[] = [
  'pending',
  'verified',
  'lapsed',
  'withdrawn',
  'revoked',
];

/** A PostgREST "function (or table) does not exist yet" error: the migration is not applied. */
export function isNotDeployedError(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01' || error.code === '42883');
}
