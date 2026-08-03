/**
 * Redaction utilities for sensitive data in log statements.
 *
 * Follows the existing `redactDeepLinkUrl()` pattern in electron/main.ts.
 * These functions sanitize PII and credentials before logging, keeping
 * log messages useful for debugging while preventing data leakage.
 *
 * @module redactSensitive
 * @see electron/main.ts - redactDeepLinkUrl() for the original pattern
 */

/**
 * Redact an email address, preserving the first character and domain.
 *
 * @example
 *   redactEmail("user@example.com")  // "u***@example.com"
 *   redactEmail("a@b.co")            // "a***@b.co"
 *   redactEmail("")                   // "***"
 *   redactEmail("no-at-sign")        // "***"
 */
export function redactEmail(email: string): string {
  if (!email) return "***";
  const atIndex = email.indexOf("@");
  if (atIndex < 1) return "***";
  const domain = email.substring(atIndex + 1);
  return `${email[0]}***@${domain}`;
}

/**
 * Redact a token or secret, showing only the first 4 and last 4 characters.
 *
 * @example
 *   redactToken("eyJhbGciOiJIUzI1NiJ9.long-token")  // "eyJh...oken"
 *   redactToken("short")                               // "***"
 *   redactToken("")                                     // "***"
 */
export function redactToken(token: string): string {
  if (!token || token.length <= 8) return "***";
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

/**
 * Redact a UUID or other identifier, showing only the first 8 characters.
 *
 * User IDs (Supabase UUIDs) are pseudonymous but can be used to correlate
 * activity across log files. Showing only the prefix preserves debuggability
 * while reducing correlation risk.
 *
 * @example
 *   redactId("550e8400-e29b-41d4-a716-446655440000")  // "550e8400..."
 *   redactId("abc")                                     // "abc..."
 *   redactId("")                                        // "***"
 */
export function redactId(id: string): string {
  if (!id) return "***";
  if (id.length <= 8) return `${id}...`;
  return `${id.substring(0, 8)}...`;
}

/**
 * Redact absolute local filesystem paths from a string, replacing each with a
 * `<path>` placeholder. Covers POSIX absolute paths, Windows drive paths, UNC
 * paths, and `file://` URLs. The username embedded in a home/cache path is PII,
 * and I/O errors (esp. EACCES/ENOSPC) routinely carry it — so it must never
 * reach Sentry via the message body. [SECURITY — BACKLOG-1903]
 *
 * BACKLOG-2447: promoted here from `services/updateDiagnostics.ts`, which still
 * uses it via `sanitizeUpdaterMessage`. It is now also the scrubber for support
 * upload failures (BACKLOG-2431), which report from a different code path and
 * therefore are NOT covered by the `beforeSend` hook in main.ts — that hook
 * only scrubs events tagged `component: "auto-updater"`. Callers outside the
 * updater must scrub at the call site.
 *
 * @example
 *   redactLocalPaths("EACCES: /Users/jane/Library/x")  // "EACCES: <path>"
 */
export function redactLocalPaths(input: string): string {
  return (
    input
      // file:// URLs (with or without host) up to the next whitespace/quote.
      .replace(/file:\/\/\/?[^\s"')]+/gi, "<path>")
      // UNC paths: \\server\share\...
      .replace(/\\\\[^\s"')]+/g, "<path>")
      // Windows drive paths: C:\Users\... or C:/Users/...
      .replace(/\b[A-Za-z]:[\\/][^\s"')]*/g, "<path>")
      // POSIX absolute paths: /Users/..., /home/..., /private/var/...
      // Require at least one more segment so a bare "/" or a URL path isn't hit.
      .replace(/(?<![\w:/])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, "<path>")
  );
}
