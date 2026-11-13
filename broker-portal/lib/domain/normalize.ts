/**
 * Domain normalisation for brokerage domain claims — BACKLOG-3962.
 *
 * One rule, in two halves. This is the TypeScript half; the SQL half is
 * public._normalize_claim_domain (supabase/migrations/20261112100000_backlog_3962_domain_claims.sql),
 * which the database applies again on every claim. The two agree on the shape below.
 *
 *   - Trim. Refuse anything with a scheme, path, port, '@' or whitespace: the admin types
 *     only the domain ("brokerage.com"), never a URL or an email address.
 *   - Strip ONE trailing dot.
 *   - Convert a Unicode name to its ASCII A-label (url.domainToASCII), which also lowercases.
 *   - Accept only lowercase LDH labels, at least two of them, a final label with a letter,
 *     253 characters at most.
 *
 * Matching elsewhere is exact on the whole A-label: a.b.com is not b.com.
 *
 * Server only: imports Node's url module.
 */

import { domainToASCII, domainToUnicode } from 'url';

const LABELS = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REFUSED_CHARACTERS = /[\s/:@?#\\]/;

/** Is this already a claimable A-label (the SQL CHECK on domain_claims.domain)? */
export function isClaimDomainShape(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  if (!LABELS.test(domain)) return false;
  const last = domain.slice(domain.lastIndexOf('.') + 1);
  return /[a-z]/.test(last);
}

/** The A-label for what the admin typed, or null when it is not a domain. */
export function normalizeClaimDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (value.length === 0 || REFUSED_CHARACTERS.test(value)) return null;
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (value.length === 0) return null;
  const ascii = domainToASCII(value);
  if (!ascii) return null;
  return isClaimDomainShape(ascii) ? ascii : null;
}

/**
 * How a claimed domain is shown. `unicode` is the readable form; `ascii` is what is in DNS and
 * what matching uses. `differs` is true for an internationalised name, where the UI shows both
 * so a look-alike name cannot pass for another (R10).
 */
export function displayDomain(ascii: string): { ascii: string; unicode: string; differs: boolean } {
  const unicode = domainToUnicode(ascii) || ascii;
  return { ascii, unicode, differs: unicode !== ascii };
}
