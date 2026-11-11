/**
 * Redirect addresses an AI app may use to receive a Keepr authorization
 * (BACKLOG-4237). Matching is EXACT string equality on the authorization's
 * redirect address: no prefix, host-only, case-folding or normalising match.
 *
 * - Claude: https://claude.ai/api/mcp/auth_callback
 * - ChatGPT: https://chatgpt.com/connector_platform_oauth_redirect (the
 *   stable address in OpenAI's Apps SDK auth docs). The per-connector
 *   https://chatgpt.com/connector/oauth/{callback_id} form cannot be matched
 *   exactly without knowing the id, so it is not listed; a known one can be
 *   added through MCP_EXTRA_REDIRECT_URIS.
 *
 * Loopback and non-https addresses are refused, including from the env list.
 */

export const BUILT_IN_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
] as const;

function isLoopbackOrInsecure(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return true;
  }
  if (url.protocol !== 'https:') return true;
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  );
}

export function allowedRedirectUris(): string[] {
  const extra = (process.env.MCP_EXTRA_REDIRECT_URIS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isLoopbackOrInsecure(s));
  return [...BUILT_IN_REDIRECT_URIS, ...extra];
}

/** The authorization's redirect address is on the allowlist, exactly. */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  if (isLoopbackOrInsecure(uri)) return false;
  return allowedRedirectUris().includes(uri);
}

/**
 * A full redirect URL returned by Supabase (code and state appended) goes to
 * `expectedUri`: its origin + path equals `expectedUri` exactly, and
 * `expectedUri` is itself allow-listed.
 */
export function redirectUrlGoesTo(redirectUrl: unknown, expectedUri: string): boolean {
  if (typeof redirectUrl !== 'string' || !isAllowedRedirectUri(expectedUri)) return false;
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return `${url.origin}${url.pathname}` === expectedUri;
}

/** Which allow-listed address a full redirect URL goes to, or null. */
export function allowedTargetOf(redirectUrl: unknown): string | null {
  for (const uri of allowedRedirectUris()) {
    if (redirectUrlGoesTo(redirectUrl, uri)) return uri;
  }
  return null;
}

/** The host shown on the consent page. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}
