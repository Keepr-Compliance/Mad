/**
 * Redirects back to a client's redirect URI (BACKLOG-4238).
 *
 * The base must be an https URI with no query, fragment or userinfo. The given
 * parameters are appended in order (null values are left out), then `iss`
 * (RFC 9207).
 */

export function clientRedirect(base: string, params: ReadonlyArray<[string, string | null]>, issuer: string): string | null {
  if (base.includes('?') || base.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const q = new URLSearchParams();
  for (const [k, v] of params) if (v !== null) q.append(k, v);
  q.append('iss', issuer);
  return `${base}?${q.toString()}`;
}
