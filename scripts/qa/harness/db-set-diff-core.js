'use strict';
/**
 * QA Harness — DB-side MEASUREMENT helpers (BACKLOG-1850 / QA-H3).
 *
 * Pure, dependency-free CommonJS. Require-able from BOTH:
 *   - the Electron-main measurement shell (scripts/qa/harness/db-assert.js), and
 *   - Jest unit tests (no Electron, no native module, no keychain needed).
 *
 * This module NEVER requires `electron` or `better-sqlite3-multiple-ciphers`
 * at the top level, so it loads cleanly under plain Node / Jest.
 *
 * ── SCOPE (post SR review + live validation of PR #1866) ──────────────────
 * H3 owns ONLY the DB-side measurement: replaying the app's email_participants
 * junction query and turning DB rows into `(subject, shiftedDate)` members. The
 * set-IDENTITY semantics (canonical parse, MULTISET diff, exact-count eval) live
 * in H1's shared modules (`canonicalList.ts` + `diff.ts`, BACKLOG-1848) and are
 * consumed by the `db-set-diff-asserter.ts` adapter.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SET-IDENTITY RULE (mirrors H1 types.ts): membership is keyed by
 * (subject, shiftedDate) — NEVER Message-ID. Membership is a MULTISET (canonical
 * rows 20/21 are two distinct emails on the same key), so this module does NOT
 * de-duplicate.
 *
 * DATE / TIMEZONE (live-validation defect 1): the app stores `sent_at` as
 * `new Date(x).toISOString()` (UTC), but the canonical checklist's "shifted
 * date" is the email's date in the CORPUS's own local timezone (Pacific for
 * tx1). A naive UTC `slice(0,10)` therefore lands 4 evening emails +1 day
 * (e.g. 2026-02-09 22:30Z is 2026-02-09 in Pacific but slices to the same day,
 * while 2026-04-15 00:xxZ is 2026-04-14 Pacific). `shiftedDateOf` converts the
 * UTC timestamp into the source timezone so the DB-measure date matches the
 * canonical (H1) authority.
 */

// ---------------------------------------------------------------------------
// Set identity
// ---------------------------------------------------------------------------

/**
 * The calendar date of an email, as YYYY-MM-DD, in `timeZone`.
 *
 * `sent_at` is a UTC ISO string ("YYYY-MM-DDTHH:mm:ss.sssZ"). When `timeZone`
 * is provided (e.g. 'America/Los_Angeles'), the timestamp is converted to that
 * zone's calendar date — this is what matches the canonical checklist, whose
 * dates are the corpus author's local dates. When `timeZone` is falsy, falls
 * back to a raw UTC `slice(0,10)` (kept only for the unit-testable default;
 * db-assert always passes the scenario's source timezone).
 *
 * @param {string|null|undefined} sentAt
 * @param {string} [timeZone] IANA tz, e.g. 'America/Los_Angeles'
 * @returns {string}
 */
function shiftedDateOf(sentAt, timeZone) {
  if (sentAt == null) return '';
  const s = String(sentAt);
  const utcSlice = () => (s.length >= 10 ? s.slice(0, 10) : s);
  if (!timeZone) return utcSlice();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return utcSlice();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = get('year');
  const m = get('month');
  const day = get('day');
  return y && m && day ? `${y}-${m}-${day}` : utcSlice();
}

/**
 * Normalise a raw DB row ({ subject, sent_at }) to an EmailSetMember
 * ({ subject, shiftedDate }) in `timeZone`. Does NOT de-duplicate.
 * @param {{subject?: string, sent_at?: string}} row
 * @param {string} [timeZone]
 * @returns {{subject: string, shiftedDate: string}}
 */
function rowToMember(row, timeZone) {
  return {
    subject: (row.subject == null ? '' : String(row.subject)).trim(),
    shiftedDate: shiftedDateOf(row.sent_at, timeZone),
  };
}

// ---------------------------------------------------------------------------
// Query builder — replays the app's own junction SQL (autoLinkService.ts)
// ---------------------------------------------------------------------------

/**
 * Build the participant-derived query that replays the app's email_participants
 * junction logic. Returns EXACT-match rows (id, user_id, subject, sent_at).
 *
 * Mirrors autoLinkService.ts (BACKLOG-1722): indexed exact match on the
 * lowercase junction, plus the optional address-token AND-clause for filter-ON.
 * `user_id` is selected so the caller can scope to the corpus user (the app DB
 * can accumulate multiple accounts — live-validation found a stale 519-email
 * user alongside the 190-email tx1 corpus).
 *
 * Two intentional divergences from the app query (both documented):
 *   1. The app's `LEFT JOIN communications … c.id IS NULL` de-dup is OMITTED:
 *      we derive the FULL expected set (what SHOULD be linked).
 *   2. The app's `AND e.sent_at >= ? AND e.sent_at <= ?` date window is OMITTED.
 *      The canonical filter-OFF rule is pure participant membership; the window
 *      feeds ONLY the ghost scan (in the adapter). Full window reconciliation is
 *      deferred to BACKLOG-1887 / FU-1.
 *
 * @param {{contacts: string[], tokens?: string[], userId?: string|null}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildDerivedQuery(opts) {
  const contacts = opts.contacts || [];
  const tokens = opts.tokens || [];
  const userId = opts.userId || null;

  if (contacts.length === 0) {
    throw new Error('buildDerivedQuery: at least one contact address is required');
  }

  const placeholders = contacts.map(() => '?').join(', ');
  /** @type {string[]} */
  const params = [];

  let sql =
    'SELECT DISTINCT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM email_participants ep\n' +
    '  JOIN emails e ON e.id = ep.email_id\n' +
    ` WHERE ep.email_address IN (${placeholders})`;
  for (const c of contacts) params.push(String(c).toLowerCase().trim());

  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }

  for (const t of tokens) {
    // EXACT mirror of autoLinkService.ts address clause.
    sql += "\n   AND LOWER(e.subject || ' ' || COALESCE(e.body_plain, '')) LIKE ?";
    params.push(`%${String(t).toLowerCase()}%`);
  }

  sql += '\n ORDER BY e.sent_at';
  return { sql, params };
}

module.exports = {
  shiftedDateOf,
  rowToMember,
  buildDerivedQuery,
};
