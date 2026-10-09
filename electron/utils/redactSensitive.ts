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
 * NOT exported, so `scrubServerErrorText` is the only way to reach it. Note
 * what that does and does not buy: it makes the email-only mistake
 * unavailable. It does NOT prevent the path-only mistake, because
 * `redactLocalPaths` is still exported for `updateDiagnostics.ts`. The mistake
 * that actually happened here is therefore still reachable — use
 * `scrubServerErrorText` for outbound server text.
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
 * path redactor was applied and the email one was not. `redactEmailsInText` is
 * unexported to close that specific hole; `redactLocalPaths` remains exported
 * (`updateDiagnostics.ts` needs it), so this is the safe default rather than a
 * mechanically enforced one.
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

/**
 * Redact phone numbers EMBEDDED IN a free-form string: a run of 7–15 digits,
 * optionally led by "+", with spaces, dashes or parentheses between them. An
 * ISO date (2026-10-06...) is left alone. Not exported: use
 * {@link scrubRcsText}. [SECURITY — BACKLOG-3668 L3]
 */
function redactPhonesInText(input: string): string {
  return input.replace(/(?<![\w.+])\+?\(?\d(?:[\s()-]*\d){6,14}(?![\w.])/g, (match) =>
    /^\d{4}-\d{2}-\d{2}/.test(match) ? match : "<phone>",
  );
}

/**
 * Redact double-quoted runs of 4+ characters: where a parser or driver error
 * echoes the input it choked on (a JSON body, a message's text), it quotes
 * it. Not exported: use {@link scrubRcsText}. [SECURITY — BACKLOG-3668 L3]
 */
function redactQuotedText(input: string): string {
  return input.replace(/"[^"\n]{4,}"/g, '"<text>"');
}

/**
 * Scrub an error from the Google Messages (RCS) import before it is logged or
 * sent to Sentry: {@link scrubServerErrorText} (emails, local paths,
 * truncation), then phone numbers and quoted text — an RCS error can carry
 * a participant's number or a message's words. Takes the error itself or
 * its message. [SECURITY — BACKLOG-3668 L3]
 *
 * @example
 *   scrubRcsText(new Error('bad "hello there" from +1 555 555 0199'))
 *   // 'bad "<text>" from <phone>'
 */
export function scrubRcsText(err: unknown, maxLength = 300): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  // Phones and quoted text first: truncation must never leave half a number.
  return scrubServerErrorText(redactPhonesInText(redactQuotedText(raw)), maxLength);
}

// ---------------------------------------------------------------------------
// Log-sink redaction [SECURITY — BACKLOG-3819]
//
// Applied to EVERY line electron-log writes (see electron/config/logFileConfig.ts)
// and to the existing log files once (electron/services/logScrub.ts). Because it
// runs over all log text rather than over a string known to be an error message,
// it is deliberately narrower than `redactPhonesInText` above, which would turn
// the 12-digit tail of a UUID ("...-446655440000") and every 7+ digit byte count
// into "<phone>". A phone here must look like a phone:
//
//   - "+"-led international (E.164), 8–15 digits, with optional single spaces,
//     dots, dashes or parentheses between digit groups: +15555550199,
//     +1 (555) 555-0199, +44 20 7946 0958
//   - North-American formats WITH separators: (555) 555-0199, 555-555-0199,
//     555.555.0199, 555 555 0199, 1-555-555-0199
//
// Bare digit runs (5555550199) are NOT treated as phones: in the real log they
// are byte counts, epoch seconds and repository ids (shape census of main.log,
// recorded on BACKLOG-3819), and a 10-digit byte count is indistinguishable
// from a 10-digit phone number.
// ---------------------------------------------------------------------------

/** "+"-led international number: 8–15 digits. */
const INTL_PHONE_RE = /(?<![\w/=+*])\+\d(?:[ .()-]{0,2}\d){7,14}(?!\d)/g;

/** North-American number with separators, optional leading country code 1. */
const NANP_PHONE_RE =
  /(?<![\w.+/:*-])(?:1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\w|[.:-]\d)/g;

/** Same email shape as `redactEmailsInText`. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Redact a phone number, keeping only its last two digits so support can still
 * tell two numbers apart in one log.
 *
 * The output is never itself phone-shaped, which is what makes re-running the
 * log scrub over already-scrubbed text a no-op.
 *
 * @example
 *   redactPhone("+1 (555) 555-0199")  // "***99"
 *   redactPhone("")                    // "***"
 */
export function redactPhone(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 2) return "***";
  return `***${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Key-context redaction [SECURITY — BACKLOG-3819, founder QA 2026-10-09]
//
// The pattern rules above deliberately skip BARE digit runs, because a bare
// 10-digit phone ("5555550123") is indistinguishable from a byte count
// ("bytes=6013820953"), epoch seconds or a repository id. A diagnostic export
// still leaked bare phones: logService serialises metadata with
// JSON.stringify(metadata, null, 2), so a sample such as
// `{ "phone": "5555550123" }` reached the file as text with no separators.
//
// The trade-off: a bare digit run is redacted only when the KEY it sits under
// names a phone/handle/email-like field. Anywhere else it is left alone, so
// byte counts, durations and ids survive, and a bare phone logged under an
// unrecognised key (e.g. `value: 5555550123`) is NOT caught — fix such calls
// at the source. Formatted and "+"-led numbers are still caught everywhere by
// the pattern rules above.
//
// Two key tiers (compared case-insensitively with "_" removed):
//
//   STRONG — the value IS contact data, so every phone-like digit group (4+
//   digits) and every email inside it is redacted, whatever its format:
//   phone, phones, phoneNumber(s), phone_e164, e164, normalized_phone,
//   mobile, mobilePhone, handle(s), chat_identifier, email(s), emailAddress,
//   participants, participants_flat — plus compound names ENDING in
//   phone/handle/email/e164 (primaryPhone, senderHandle, workEmail; see
//   STRONG_KEY_SUFFIX_RE), excluding boolean prefixes (hasPhone) and "iPhone".
//
//   WEAK — the key is ambiguous (`to: "develop"`, `from: "2026-10-01"`, a
//   property `address: "12 Main St"`, `sender: "me"`), so the value is redacted
//   only when the WHOLE value is phone-shaped: 10 digits, 11 digits starting
//   with 1, or "+" and 8–15 digits, separators allowed. Keys: from, to, sender,
//   recipient(s), address. (An epoch-seconds value under `from`/`to` would be
//   over-redacted; that is the accepted cost.)
//
// NOT keys: contactId, transactionId, id, udid, size, bytes, *Ms, count,
// phoneCount, phoneType, emailsProcessed, hasPhone, iPhone —
// identifiers and measurements, never redacted by key.
//
// Shapes covered (text): JSON `"phone": "…"` / `"phone":123`, util.inspect
// `phone: '…'`, inline `phone: 5555550123` / `phone=5555550123`, and arrays
// `"participants": [ "…", "…" ]` (multi-line allowed). Object arguments handed
// to electron-log directly are covered by {@link redactValueForKey}, which the
// sink hook (config/logFileConfig.ts) applies before the object is formatted.
// ---------------------------------------------------------------------------

const STRONG_CONTACT_KEYS = new Set([
  "phone",
  "phones",
  "phonenumber",
  "phonenumbers",
  "phonee164",
  "e164",
  "normalizedphone",
  "mobile",
  "mobilephone",
  "handle",
  "handles",
  "chatidentifier",
  "email",
  "emails",
  "emailaddress",
  "participants",
  "participantsflat",
]);

const WEAK_CONTACT_KEYS = new Set(["from", "to", "sender", "recipient", "recipients", "address"]);

/**
 * Compound names ending in a contact noun are STRONG too: primaryPhone,
 * otherPhone, recipientPhone, senderHandle, fromHandle, workEmail,
 * contact_email, mobilePhoneNumber. Matching the END of the name (not "contains")
 * keeps phoneCount, phoneType, emailsProcessed, handler and handledCount out;
 * a boolean prefix (hasPhone, isEmail) and Apple's "iPhone" are excluded.
 */
const STRONG_KEY_SUFFIX_RE = /(phone|phones|phonenumber|phonenumbers|e164|handle|handles|email|emails|emailaddress|emailaddresses)$/;
const NOT_CONTACT_KEY_RE = /^(has|is|should|can|did|needs|no|show|use|allow)[a-z]|iphones?$/;

function contactKeyTier(key: string): "strong" | "weak" | null {
  const k = key.toLowerCase().replace(/_/g, "");
  if (STRONG_CONTACT_KEYS.has(k)) return "strong";
  if (STRONG_KEY_SUFFIX_RE.test(k) && !NOT_CONTACT_KEY_RE.test(k)) return "strong";
  if (WEAK_CONTACT_KEYS.has(k)) return "weak";
  return null;
}

/** A digit group of 4+ digits, optionally "+"-led, with phone separators between digits. */
const DIGIT_GROUP_RE = /\+?\(?\d(?:[ ().-]{0,2}\d)+/g;

/** Redact every email and every 4+-digit group inside a value known to be contact data. */
function redactStrongValue(value: string): string {
  return value
    .replace(EMAIL_RE, (match) => redactEmail(match))
    .replace(DIGIT_GROUP_RE, (match) =>
      match.replace(/\D/g, "").length >= 4 ? redactPhone(match) : match,
    );
}

/** True when the whole value is a phone number: 10 digits, 1+10, or "+" and 8–15. */
function isWholePhone(value: string): boolean {
  const v = value.trim();
  if (!/^\+?[\d ().-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) return digits.length >= 8 && digits.length <= 15;
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

function redactByTier(tier: "strong" | "weak", value: string): string {
  if (tier === "strong") return redactStrongValue(value);
  return isWholePhone(value) ? redactPhone(value) : value;
}

/**
 * Redact the value of a contact-like key in an object argument (see the tier
 * list above). Strings, numbers and arrays of them are handled; anything else,
 * and any key that is not contact-like, comes back unchanged.
 */
export function redactValueForKey(key: string, value: unknown): unknown {
  const tier = contactKeyTier(key);
  if (!tier) return value;
  if (typeof value === "string") return redactByTier(tier, value);
  if (typeof value === "number" && Number.isFinite(value)) {
    const s = String(value);
    const out = redactByTier(tier, s);
    return out === s ? value : out;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" || typeof item === "number" ? redactValueForKey(key, item) : item,
    );
  }
  return value;
}

/**
 * `key` + `:` or `=` + a value: double-quoted, single-quoted, a bracketed list
 * of scalars (up to 4000 chars, may span lines), or a bare number (digits, "+",
 * parens, dots and dashes; no spaces). A list holding objects (`"samples": [ {`)
 * is deliberately NOT consumed as one value, so the keys inside its objects are
 * still visited.
 */
const KEY_CONTEXT_RE =
  /(?<![\w$])(["']?)([A-Za-z][\w]{0,40})\1(\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|\[([^[\]{}]{0,4000})\]|(\+?\(?\d[\d().-]*\d)(?![\w.]))/g;

/** Quoted or bare scalar elements of a bracketed list. */
const LIST_ITEM_RE = /"([^"\n]*)"|'([^'\n]*)'|(\+?\(?\d[\d().-]*\d)(?![\w.])/g;

function redactKeyContexts(input: string): string {
  return input.replace(
    KEY_CONTEXT_RE,
    (match, q: string, key: string, sep: string, dq?: string, sq?: string, list?: string, bare?: string) => {
      const tier = contactKeyTier(key);
      if (!tier) return match;
      const head = `${q}${key}${q}${sep}`;
      if (dq !== undefined) return `${head}"${redactByTier(tier, dq)}"`;
      if (sq !== undefined) return `${head}'${redactByTier(tier, sq)}'`;
      if (list !== undefined) {
        const items = list.replace(LIST_ITEM_RE, (item, idq?: string, isq?: string, ibare?: string) => {
          if (idq !== undefined) return `"${redactByTier(tier, idq)}"`;
          if (isq !== undefined) return `'${redactByTier(tier, isq)}'`;
          return redactByTier(tier, ibare ?? item);
        });
        return `${head}[${items}]`;
      }
      return `${head}${redactByTier(tier, bare ?? "")}`;
    },
  );
}

/**
 * Redact every email address and phone number embedded in free-form log text.
 * Emails first, so a phone-number handle such as "+15555550199@s.example.net"
 * is consumed as an address and not half-matched as a phone. Then the values
 * of contact-like keys (see "Key-context redaction" above), then formatted
 * and "+"-led numbers anywhere.
 *
 * Idempotent: `redactLogText(redactLogText(x)) === redactLogText(x)`.
 */
export function redactLogText(input: string): string {
  if (!input) return input;
  return redactKeyContexts(input.replace(EMAIL_RE, (match) => redactEmail(match)))
    .replace(INTL_PHONE_RE, (match) => redactPhone(match))
    .replace(NANP_PHONE_RE, (match) => redactPhone(match));
}
