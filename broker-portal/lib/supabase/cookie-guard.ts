/**
 * Middleware cookie guard + safe auth-error logging.
 *
 * BACKLOG-1952 (H1): The @supabase/ssr single-cookie adapter, when the
 * `sb-<ref>-auth-token` cookie holds a BARE JSON session string (corruption /
 * chunk mismatch — a class the app already handles for the base64 form via
 * `clearCorruptedCookies()` in lib/supabase/client.ts), tries to assign `.user`
 * onto a string and throws:
 *
 *   TypeError: Cannot create property 'user' on string '{...full session...}'
 *
 * The thrown error interpolates the RAW cookie value, which IS the full session
 * (access_token + refresh_token + provider_token). If that error object reaches
 * Vercel logs or Sentry, live bearer credentials leak.
 *
 * Defenses in this module:
 *   1. `isBareAuthTokenCookie` — detect the poisoned auth-token cookie so the
 *      adapter can return `undefined` (SDK sees no session → clean redirect to
 *      login) BEFORE the SDK ever tries to parse it and throw.
 *   2. `safeAuthErrorInfo` — if getUser() throws anyway, extract ONLY a static
 *      `{ name, code }`. Never the error object, error.message, or the cookie
 *      value — any of which can carry the session string.
 */

/** Base name (chunk suffix stripped) of the Supabase auth-token cookie. */
const AUTH_TOKEN_SUFFIX = '-auth-token';

/**
 * True when `name` is a Supabase auth-token cookie (chunked or not).
 * Examples: `sb-abcd-auth-token`, `sb-abcd-auth-token.0`.
 */
export function isAuthTokenCookie(name: string): boolean {
  if (!name.startsWith('sb-')) return false;
  // Strip an optional numeric chunk suffix (.0, .1, ...) before matching.
  const base = name.replace(/\.\d+$/, '');
  return base.endsWith(AUTH_TOKEN_SUFFIX);
}

/**
 * True when an auth-token cookie value is the BARE-JSON session form that the
 * single-cookie adapter cannot parse (it assigns `.user` onto the string and
 * throws a TypeError containing the raw session).
 *
 * Healthy values are the `base64-<...>` encoded form (optionally chunked). A
 * value whose first non-whitespace character is `{` or `[` is the raw session
 * object / array-of-chunks the adapter chokes on, so we treat it as corrupt.
 *
 * Note: we deliberately do NOT `JSON.parse()` the value — parsing would pull
 * the session string into a local, and we want zero handling of the secret.
 * A cheap first-character sniff is sufficient and never touches the payload.
 */
export function isBareAuthTokenCookie(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (!isAuthTokenCookie(name)) return false;
  const trimmedStart = value.replace(/^\s+/, '');
  const firstChar = trimmedStart.charAt(0);
  return firstChar === '{' || firstChar === '[';
}

/**
 * Static, secret-free descriptor of a thrown error, safe to log.
 *
 * ONLY `name` and `code` are surfaced — never `message` or the error object,
 * because the bare-JSON TypeError's message embeds the full session string.
 */
export function safeAuthErrorInfo(error: unknown): { name: string; code: string } {
  // `code` is not on the base Error type; read it defensively without widening
  // the whole boundary to `any`.
  const name =
    error instanceof Error && typeof error.name === 'string' ? error.name : 'UnknownError';
  const code =
    typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'unknown';
  return { name, code };
}
