/**
 * Bulk-mail header retention (BACKLOG-2513)
 *
 * `List-Unsubscribe`, `Precedence`, `Auto-Submitted` and `Authentication-Results`
 * arrive from both providers on every message and were discarded — only
 * `Message-ID` was ever read. They are per-message facts: recovering them later
 * means re-reading every mailbox for every user.
 *
 * **These are the negative-filter stage** of the auto-detection design
 * (BACKLOG-2500 §4.2) — the stage that exists because auto-detect manufactured
 * transactions from commercial newsletters and bank mail and had to be switched
 * off (BACKLOG-2499). Marketing mail announces itself in its headers; without
 * them the only way to tell a newsletter from a person is to guess from content,
 * which is exactly what failed.
 *
 * **This module stores raw values and classifies nothing.** A classifier written
 * now would freeze a decision before scoring has measured anything
 * (BACKLOG-2273). Keeping the headers is cheap and permanent; interpreting them
 * is a later, revisable choice. Do not add an `isBulk()` here.
 *
 * Lives under `electron/` because both callers (gmailFetchService,
 * outlookFetchService) are main-process: `electron/` cannot import from `src/`
 * (tsconfig `rootDir`), and the renderer cannot value-import from `electron/`.
 * No renderer code imports this module.
 *
 * @module electron/utils/bulkMailHeaders
 * @see BACKLOG-2513
 */

/**
 * Single-valued headers: wire name → JSON key.
 *
 * **This object is the contract.** The JSON keys written into
 * `emails.bulk_mail_headers` are declared here exactly once, and the builder
 * iterates this map rather than naming keys inline — otherwise a typo'd key
 * would be emitted by the builder and then faithfully asserted by every test,
 * proving only that the typo is consistent. The future BACKLOG-2500 scorer
 * reads its key names from here too.
 */
export const SINGLE_VALUE_HEADERS = {
  "list-unsubscribe": "list_unsubscribe",
  "list-unsubscribe-post": "list_unsubscribe_post",
  precedence: "precedence",
  "auto-submitted": "auto_submitted",
} as const;

/**
 * Multi-valued headers: wire name → JSON key.
 *
 * `Authentication-Results` legitimately appears MORE THAN ONCE — one instance
 * per authenticating hop (per `authserv-id`). Keeping only the first would
 * silently discard the hop that may be the failing one, which for a precision
 * signal is worse than storing nothing because it still looks authoritative.
 * Values are kept as an array in wire order.
 */
export const MULTI_VALUE_HEADERS = {
  "authentication-results": "authentication_results",
} as const;

/** JSON keys produced for single-valued headers. */
export type SingleValueKey =
  (typeof SINGLE_VALUE_HEADERS)[keyof typeof SINGLE_VALUE_HEADERS];

/** JSON keys produced for multi-valued headers. */
export type MultiValueKey =
  (typeof MULTI_VALUE_HEADERS)[keyof typeof MULTI_VALUE_HEADERS];

/**
 * The retained-header object stored as JSON in `emails.bulk_mail_headers`.
 * Absent headers are omitted entirely rather than stored as null, so the column
 * records what the provider actually sent.
 */
export type BulkMailHeaders = Partial<Record<SingleValueKey, string>> &
  Partial<Record<MultiValueKey, string[]>>;

/** Every JSON key this module can emit — the declared contract, for tests. */
export const BULK_MAIL_HEADER_JSON_KEYS: readonly string[] = [
  ...Object.values(SINGLE_VALUE_HEADERS),
  ...Object.values(MULTI_VALUE_HEADERS),
];

/**
 * Build the retained-header object from provider-agnostic header accessors.
 *
 * Both fetch services call this with their own lookups so the two providers
 * cannot drift in key naming or in which headers are captured.
 *
 * @param getOne - case-insensitive lookup returning the FIRST matching header
 *   value, or null. (`gmailFetchService`'s `getHeader`, `outlookFetchService`'s
 *   `getInternetHeader`.)
 * @param getAll - case-insensitive lookup returning EVERY matching header value
 *   in wire order. Required for `Authentication-Results`; see MULTI_VALUE_HEADERS.
 * @returns the retained headers, or `null` when the message carried none — so an
 *   ordinary person-to-person email leaves the column NULL rather than `{}`.
 */
export function buildBulkMailHeaders(
  getOne: (name: string) => string | null,
  getAll: (name: string) => string[],
): BulkMailHeaders | null {
  const result: Record<string, string | string[]> = {};

  for (const [wireName, jsonKey] of Object.entries(SINGLE_VALUE_HEADERS)) {
    const value = getOne(wireName);
    // Trim guards against a header present but empty — that carries no signal
    // and would otherwise make the column non-NULL for no reason.
    if (value && value.trim()) {
      result[jsonKey] = value;
    }
  }

  for (const [wireName, jsonKey] of Object.entries(MULTI_VALUE_HEADERS)) {
    const values = getAll(wireName).filter((v) => v && v.trim());
    if (values.length > 0) {
      result[jsonKey] = values;
    }
  }

  return Object.keys(result).length > 0 ? (result as BulkMailHeaders) : null;
}
