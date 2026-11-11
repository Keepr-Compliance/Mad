/**
 * Host matching for sender rules — BACKLOG-4175.
 *
 * A host matches a listed domain when it IS that domain or a true subdomain of
 * it. Never a substring match, never a dot-less suffix match, never widened to
 * the registrable domain.
 */

/** The host part of a parsed, lowercased address; null when there is none. */
export function hostOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at >= 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

/** The local part of a parsed, lowercased address; null when there is none. */
export function localPartOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : null;
}

/** `host` is `domain` or ends with "." + `domain`. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** `host` matches any of `domains`. */
export function hostMatchesAny(host: string | null, domains: readonly string[]): boolean {
  if (!host) return false;
  for (const d of domains) if (hostMatches(host, d)) return true;
  return false;
}
