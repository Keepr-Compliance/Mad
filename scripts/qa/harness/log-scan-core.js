'use strict';
/**
 * QA Harness — LOG-SCAN core (BACKLOG-1854 / QA-H7). PURE, DB-free, no I/O.
 *
 * Two independent scanners over raw log text, kept pure so CI covers them with
 * committed fixtures without a packaged build:
 *
 *   1. TELEMETRY (BACKLOG-1843) — detect the per-transaction sync telemetry
 *      lines that went MISSING from main.log in the installed DMG:
 *        - `[CACHE-HITMISS] transaction=… reason=… fetched=… hits=… misses=…`
 *        - `Fetched N emails …` (fetch telemetry)
 *        - `Sync and fetch emails for transaction` (per-transaction sync entry)
 *      The exact marker strings are pinned to their SOURCE:
 *        electron/services/emailSyncService.ts  (CACHE-HITMISS @ ~L782, "Fetched …")
 *        electron/handlers/emailSyncHandlers.ts ("Sync and fetch emails for transaction")
 *      If that source's log format changes, the committed telemetry fixture test
 *      MUST fail — the fixture, not a real log, is the assertion's source of truth.
 *
 *   2. REDACTION (SCOPE ADD 2026-07-10, guards BACKLOG-1785) — scan for email
 *      addresses / PII in plaintext. Returns a leak COUNT and MASKED samples
 *      (never the raw address). This is REPORTED-NOT-GATED until 1785 lands:
 *      the asserter reports the count and NEVER fails the ceremony on it.
 *
 * SECURITY: masked samples truncate the local-part and never echo a full
 * address, so neither CLI stdout nor a committed fixture leaks a real value.
 */

// ---------------------------------------------------------------------------
// 1. Telemetry marker detection (BACKLOG-1843)
// ---------------------------------------------------------------------------

/**
 * The canonical 1843 telemetry markers. `id` is stable for reporting; `test`
 * matches a line. Sourced from electron/services/emailSyncService.ts +
 * electron/handlers/emailSyncHandlers.ts — keep in sync with those emit sites.
 * @type {Array<{id: string, label: string, test: RegExp}>}
 */
const TELEMETRY_MARKERS = [
  {
    id: 'cache-hitmiss',
    label: 'per-transaction cache hit/miss telemetry',
    // [CACHE-HITMISS] transaction=<id> reason=<r> fetched=<n> hits=<n> misses=<n> hitRate=<x>
    test: /\[CACHE-HITMISS\]\s+transaction=\S+\s+reason=\S+\s+fetched=\d+\s+hits=\d+\s+misses=\d+/,
  },
  {
    id: 'fetch',
    label: 'fetch telemetry ("Fetched N emails …")',
    test: /Fetched\s+\d+\s+emails?\b/i,
  },
  {
    id: 'sync-entry',
    label: 'per-transaction sync entry ("Sync and fetch emails for transaction")',
    test: /Sync and fetch emails for transaction/i,
  },
];

/**
 * Detect telemetry markers in log text.
 * @param {string} logText
 * @returns {{
 *   markers: Array<{id: string, label: string, present: boolean, count: number}>,
 *   presentCount: number,
 *   totalMarkers: number,
 *   allPresent: boolean
 * }}
 */
function scanTelemetry(logText) {
  const text = String(logText === null || logText === undefined ? '' : logText);
  const lines = text.split(/\r?\n/);
  const markers = TELEMETRY_MARKERS.map((m) => {
    let count = 0;
    for (const line of lines) if (m.test.test(line)) count += 1;
    return { id: m.id, label: m.label, present: count > 0, count };
  });
  const presentCount = markers.filter((m) => m.present).length;
  return {
    markers,
    presentCount,
    totalMarkers: markers.length,
    allPresent: presentCount === markers.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Redaction / PII scanner (guards BACKLOG-1785)
// ---------------------------------------------------------------------------

/**
 * Email-address matcher. Deliberately broad (RFC-lite) so it errs toward
 * OVER-reporting a potential leak — a QA privacy gate should never UNDER-count.
 * Global so we can enumerate every hit on a line.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mask an email so a sample can be reported without echoing a real address.
 * "amanda@cascadetitle.com" -> "am***@***.com". The masked form keeps only the
 * first 2 local chars and the TLD, enough to triage without leaking identity.
 * @param {string} addr
 * @returns {string}
 */
function maskEmail(addr) {
  const s = String(addr);
  const at = s.indexOf('@');
  if (at < 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const localHead = local.slice(0, 2);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${localHead}***@***${tld}`;
}

/**
 * Scan log text for plaintext email addresses (the BACKLOG-1785 leak class).
 * @param {string} logText
 * @param {{sampleLimit?: number, allowlist?: string[]}} [opts]
 *   allowlist: lowercased substrings that are NOT leaks (e.g. build/noreply
 *   addresses baked into the app). Defaults to none.
 * @returns {{
 *   leakCount: number,
 *   uniqueLeakCount: number,
 *   maskedSamples: string[],
 *   lineNumbers: number[]
 * }}
 */
function scanRedaction(logText, opts) {
  const options = opts || {};
  const sampleLimit = options.sampleLimit === null || options.sampleLimit === undefined ? 5 : options.sampleLimit;
  const allowlist = (options.allowlist || []).map((a) => String(a).toLowerCase());
  const text = String(logText === null || logText === undefined ? '' : logText);
  const lines = text.split(/\r?\n/);

  let leakCount = 0;
  const uniqueMasked = new Set();
  const maskedSamples = [];
  const lineNumbers = [];

  const isAllowed = (addr) => {
    const low = addr.toLowerCase();
    return allowlist.some((a) => low.includes(a));
  };

  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(EMAIL_RE);
    if (!matches) continue;
    for (const addr of matches) {
      if (isAllowed(addr)) continue;
      leakCount += 1;
      const masked = maskEmail(addr);
      uniqueMasked.add(masked);
      if (maskedSamples.length < sampleLimit && !maskedSamples.includes(masked)) {
        maskedSamples.push(masked);
      }
      if (lineNumbers.length < sampleLimit) lineNumbers.push(i + 1);
    }
  }

  return {
    leakCount,
    uniqueLeakCount: uniqueMasked.size,
    maskedSamples,
    lineNumbers,
  };
}

module.exports = {
  TELEMETRY_MARKERS,
  scanTelemetry,
  scanRedaction,
  maskEmail,
  EMAIL_RE,
};
