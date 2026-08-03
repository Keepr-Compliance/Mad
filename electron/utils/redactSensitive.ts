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
 * Redact every email address EMBEDDED IN a free-form string, via
 * {@link redactEmail}. Use this on text you did not author — server error
 * messages, exception bodies — where an address may appear anywhere.
 *
 * `redactEmail` handles a string that IS an address; this handles a string that
 * CONTAINS one. Postgres is the motivating case: a constraint violation renders
 * the offending value inline, e.g.
 *
 *   'duplicate key value violates unique constraint "x"
 *    DETAIL: Key (requester_email)=(jane@example.com) already exists.'
 *
 * which would otherwise reach Sentry verbatim, including in the issue title.
 * [SECURITY — BACKLOG-2431]
 *
 * NOT exported. `scrubServerErrorText` is the only way to reach this, which is
 * what makes "you cannot apply one redactor and forget the other" an actual
 * boundary rather than a convention someone has to remember.
 *
 * @example
 *   redactEmailsInText("Key (requester_email)=(jane@example.com) exists")
 *   // "Key (requester_email)=(j***@example.com) exists"
 */
function redactEmailsInText(input: string): string {
  // Local part per RFC 5322 practical subset; domain must contain a dot so
  // "@mentions" and bare handles are not mangled.
  return input.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (match) => redactEmail(match),
  );
}

/**
 * Scrub a server-authored error message before it leaves the app (Sentry, any
 * outbound telemetry). Removes embedded email addresses and absolute local
 * filesystem paths, then truncates.
 *
 * Use this for ANY string whose content the server chose. Applying the two
 * redactors by hand at each call site is how one of them gets forgotten —
 * which is exactly what happened in the first cut of BACKLOG-2431, where the
 * path redactor was applied and the email one was not.
 * [SECURITY — BACKLOG-2431]
 *
 * @param message Raw error text.
 * @param maxLength Max length before truncation (default 500).
 */
export function scrubServerErrorText(
  message: unknown,
  maxLength = 500,
): string {
  if (typeof message !== "string" || !message) return "Unknown error";
  let scrubbed = redactEmailsInText(redactLocalPaths(message));
  if (scrubbed.length > maxLength) {
    scrubbed = scrubbed.slice(0, maxLength) + "...";
  }
  return scrubbed;
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
