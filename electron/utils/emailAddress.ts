/**
 * RFC 5322 email address-list parser (BACKLOG-1722).
 *
 * Parses an RFC 5322 address-list header value (From/To/Cc/Bcc) into structured
 * `{email_address, display_name}` rows that are written to the
 * `email_participants` junction table.
 *
 * Design notes:
 * - This is a pragmatic parser, not a full RFC 5322 compliance suite. It targets
 *   real-world Gmail/Outlook headers — which include quoted display names with
 *   commas, encoded-words, group syntax, and routing addresses.
 * - The Microsoft Graph API returns structured `emailAddress.{name,address}` for
 *   Outlook messages, so the Outlook writer can bypass this parser entirely and
 *   build participants directly. This module is primarily used by the Gmail
 *   writer (raw RFC 5322 headers) and the v41 backfill (parsing existing
 *   denormalized `sender`/`recipients`/`cc`/`bcc` columns).
 * - The parser is deliberately tolerant: on partial parse failure it returns the
 *   addresses it could extract plus an `errors[]` array. The migration backfill
 *   records errors in `email_participants_backfill_errors`.
 *
 * What we handle:
 * - `"Last, First" <a@x.com>` (quoted display name containing comma)
 * - `Alice <a@x.com>, Bob <b@y.com>` (unquoted display names)
 * - `<a@x.com>, <b@y.com>` (angle-bracket-only)
 * - `a@x.com, b@y.com` (bare addresses)
 * - `=?utf-8?Q?Al=C3=AFce?= <a@x.com>` (RFC 2047 encoded-word — best-effort)
 * - `Realtors: alice@x.com, bob@y.com;` (group syntax — group name dropped, members extracted)
 * - `@route1,@route2:user@x.com` (routing — extracts the last hop only)
 *
 * What we reject (returned in `errors[]`):
 * - Empty `<>`
 * - Missing `@` (e.g. `localpart`)
 * - Missing local part (e.g. `@example.com`)
 * - Missing domain (e.g. `user@`)
 */

import crypto from "crypto";

export type ParticipantRole = "from" | "to" | "cc" | "bcc";

export interface ParsedAddress {
  email_address: string;
  display_name: string | null;
}

export interface ParseError {
  raw: string;
  reason: string;
}

export interface ParseResult {
  addresses: ParsedAddress[];
  errors: ParseError[];
}

/**
 * Normalize an email address for storage / lookup.
 *
 * - LOWER-cases the whole address (display_name is preserved verbatim elsewhere)
 * - Trims surrounding whitespace
 * - Does NOT collapse internal whitespace (RFC 5321 forbids it; if present,
 *   the address is malformed and will fail the validity check upstream)
 */
export function normalizeEmailAddress(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Compute a deterministic per-row hash. Used for de-dup safety nets and to
 * give consumers a stable ID without requiring a SELECT round-trip.
 */
export function computeParticipantHash(
  email_id: string,
  role: ParticipantRole,
  position: number,
  email_address: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${email_id}|${role}|${position}|${email_address}`)
    .digest("hex");
}

/**
 * Best-effort decode of RFC 2047 encoded-words ("=?charset?Q?text?=").
 *
 * Falls back to returning the raw value if decoding fails — display_name is a
 * convenience field, never a correctness concern.
 */
function decodeEncodedWord(raw: string): string {
  // Match: =?charset?encoding?text?=
  const RE = /=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g;
  return raw.replace(RE, (_match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString(charset || "utf-8");
      }
      // Q encoding: '_' = space, '=XX' = byte
      const decoded = String(text)
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
          Buffer.from([parseInt(hex, 16)]).toString(charset || "utf-8")
        );
      return decoded;
    } catch {
      return raw;
    }
  });
}

/**
 * Strip surrounding ASCII double-quotes and unescape backslash-escaped quotes.
 */
function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * Validate an extracted email_address.
 * Returns `null` if valid, or a human-readable error reason if invalid.
 */
function validateAddress(addr: string): string | null {
  if (!addr || addr.length === 0) return "empty address";
  const atIdx = addr.indexOf("@");
  if (atIdx === -1) return "missing '@'";
  if (atIdx === 0) return "missing local part";
  if (atIdx === addr.length - 1) return "missing domain";
  // Reject internal whitespace (RFC 5321 §3.4 forbids SP in local-part/domain)
  if (/\s/.test(addr)) return "invalid character: whitespace in address";
  // Reject semicolons — indicates un-split list or corrupt angle-bracket content
  if (addr.includes(";")) return "invalid character: semicolon in address";
  return null;
}

/**
 * Split a header value on commas or semicolons that are NOT inside
 * double-quotes or angle brackets. This is the core state machine.
 *
 * Returns each separator-delimited chunk as a trimmed string (caller parses
 * each chunk individually into name+address).
 */
function splitAddresses(headerValue: string): string[] {
  const chunks: string[] = [];
  let buf = "";
  let inQuotes = false;
  let inAngle = false;
  let escape = false;

  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];

    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && inQuotes) {
      buf += ch;
      escape = true;
      continue;
    }

    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }

    if (ch === "<" && !inQuotes) {
      inAngle = true;
      buf += ch;
      continue;
    }
    if (ch === ">" && !inQuotes) {
      inAngle = false;
      buf += ch;
      continue;
    }

    if ((ch === "," || ch === ";") && !inQuotes && !inAngle) {
      const piece = buf.trim();
      if (piece) chunks.push(piece);
      buf = "";
      continue;
    }

    buf += ch;
  }

  const last = buf.trim();
  if (last) chunks.push(last);

  return chunks;
}

/**
 * Parse a single "mailbox" chunk: `display? <addr>` or bare `addr`.
 *
 * Handles:
 *  - `"Last, First" <a@x.com>`
 *  - `Alice Smith <a@x.com>`
 *  - `<a@x.com>`
 *  - `a@x.com`
 *  - `a@x.com (Alice Smith)` (comment form — display from comment)
 *  - `=?utf-8?Q?Al=C3=AFce?= <a@x.com>` (encoded-word)
 *  - `@route1,@route2:user@x.com` (routing — last hop)
 */
function parseMailbox(chunk: string): ParsedAddress | { error: string } {
  const trimmed = chunk.trim();
  if (!trimmed) return { error: "empty mailbox" };

  // Angle-bracket form: `display? <addr>`
  const angleIdx = trimmed.lastIndexOf("<");
  const closeIdx = trimmed.lastIndexOf(">");
  if (angleIdx !== -1 && closeIdx > angleIdx) {
    let inner = trimmed.slice(angleIdx + 1, closeIdx).trim();

    // Strip RFC 5321 routing: `@host1,@host2:user@domain` → `user@domain`
    if (inner.startsWith("@")) {
      const colonIdx = inner.lastIndexOf(":");
      if (colonIdx !== -1) inner = inner.slice(colonIdx + 1).trim();
    }

    const normalized = normalizeEmailAddress(inner);
    const validationError = validateAddress(normalized);
    if (validationError) return { error: validationError };

    let displayRaw = trimmed.slice(0, angleIdx).trim();
    if (displayRaw) {
      displayRaw = unquote(displayRaw);
      displayRaw = decodeEncodedWord(displayRaw).trim();
    }

    return {
      email_address: normalized,
      display_name: displayRaw && displayRaw.length > 0 ? displayRaw : null,
    };
  }

  // No angle brackets. Try comment-form: `a@x.com (Alice)`
  const parenMatch = trimmed.match(/^(\S+@\S+)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const normalized = normalizeEmailAddress(parenMatch[1]);
    const validationError = validateAddress(normalized);
    if (validationError) return { error: validationError };
    return {
      email_address: normalized,
      display_name: parenMatch[2].trim() || null,
    };
  }

  // Bare address: `a@x.com`
  const bare = normalizeEmailAddress(trimmed);
  const validationError = validateAddress(bare);
  if (validationError) return { error: validationError };
  return { email_address: bare, display_name: null };
}

/**
 * Strip group syntax: `GroupName: a@x.com, b@y.com;` → `a@x.com, b@y.com`.
 *
 * Returns the inner member list. If no group syntax found, returns the input
 * unchanged.
 */
function stripGroupSyntax(headerValue: string): string {
  // A group is: phrase `:` member-list `;`
  // Heuristic: if there is a `:` before any `<` or `@` AND a trailing `;`,
  // treat as group.
  const colonIdx = headerValue.indexOf(":");
  if (colonIdx === -1) return headerValue;

  const atIdx = headerValue.indexOf("@");
  const angleIdx = headerValue.indexOf("<");

  // The colon must come BEFORE the first address signal.
  if (atIdx !== -1 && colonIdx > atIdx) return headerValue;
  if (angleIdx !== -1 && colonIdx > angleIdx) return headerValue;

  const semiIdx = headerValue.lastIndexOf(";");
  if (semiIdx === -1 || semiIdx < colonIdx) return headerValue;

  return headerValue.slice(colonIdx + 1, semiIdx).trim();
}

/**
 * Parse an RFC 5322 address-list header value.
 *
 * @param headerValue raw header value (may be null/empty)
 * @returns `{ addresses, errors }`
 */
export function parseEmailAddressList(headerValue: string | null | undefined): ParseResult {
  const result: ParseResult = { addresses: [], errors: [] };
  if (!headerValue || typeof headerValue !== "string") return result;

  const trimmedHeader = headerValue.trim();
  if (!trimmedHeader) return result;

  // Strip group syntax wrapping (best-effort — see stripGroupSyntax docs).
  const inner = stripGroupSyntax(trimmedHeader);

  // Top-level split on commas (RFC 2822 splits group members on commas too).
  const chunks = splitAddresses(inner);

  for (const chunk of chunks) {
    const parsed = parseMailbox(chunk);
    if ("error" in parsed) {
      result.errors.push({ raw: chunk, reason: parsed.error });
      continue;
    }
    result.addresses.push(parsed);
  }

  return result;
}
