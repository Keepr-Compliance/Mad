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
 * ── SCOPE (post SR review of PR #1866) ────────────────────────────────────
 * H3 owns ONLY the DB-side measurement: replaying the app's email_participants
 * junction query and turning DB rows into `(subject, shiftedDate)` members. The
 * set-IDENTITY semantics (parsing the canonical checklist, MULTISET diff,
 * exact-count evaluation, deviation formatting) live in H1's shared modules —
 * `canonicalList.ts` + `diff.ts` (BACKLOG-1848) — and are consumed by the
 * `db-set-diff-asserter.ts` adapter. Keeping a SECOND implementation of the
 * identity rule here is what let the rows-20/21 MULTISET collision slip through
 * (SR finding C1); it has been removed so there is one source of truth.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SET-IDENTITY RULE (load-bearing, mirrors H1 types.ts): email set membership
 * is keyed by (subject, shiftedDate) — NEVER by Message-ID. Membership is a
 * MULTISET: distinct emails may legitimately share a key (canonical rows 20/21
 * are two distinct emails on 2026-02-14), so this module does NOT de-duplicate.
 */

// ---------------------------------------------------------------------------
// Set identity
// ---------------------------------------------------------------------------

/**
 * The calendar date of an email, as YYYY-MM-DD.
 * `sent_at` is an ISO-ish string ("YYYY-MM-DDTHH:mm:ssZ" or "YYYY-MM-DD HH:..").
 * The date is the first 10 characters in both forms. The 4 rows that land +1
 * day in UTC already carry the +1 date in the stored value, so there is NO
 * timezone math here — that is the whole point of matching on the stored value.
 * @param {string|null|undefined} sentAt
 * @returns {string}
 */
function shiftedDateOf(sentAt) {
  if (sentAt == null) return '';
  const s = String(sentAt);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * Normalise a raw DB row ({ subject, sent_at }) to an EmailSetMember
 * ({ subject, shiftedDate }). Does NOT de-duplicate — multiplicity is
 * load-bearing and preserved for the multiset diff in H1's diff.ts.
 * @param {{subject?: string, sent_at?: string}} row
 * @returns {{subject: string, shiftedDate: string}}
 */
function rowToMember(row) {
  return {
    subject: (row.subject == null ? '' : String(row.subject)).trim(),
    shiftedDate: shiftedDateOf(row.sent_at),
  };
}

// ---------------------------------------------------------------------------
// Query builder — replays the app's own junction SQL (autoLinkService.ts)
// ---------------------------------------------------------------------------

/**
 * Build the participant-derived query that replays the app's email_participants
 * junction logic. Returns EXACT-match rows (id, subject, sent_at).
 *
 * Mirrors autoLinkService.ts (BACKLOG-1722): indexed exact match on the
 * lowercase junction, plus the optional address-token AND-clause for filter-ON.
 *
 * Two intentional divergences from the app query (both documented):
 *   1. The app's `LEFT JOIN communications … c.id IS NULL` de-dup is OMITTED:
 *      we derive the FULL expected set (what SHOULD be linked), independent of
 *      what is already linked.
 *   2. The app's `AND e.sent_at >= ? AND e.sent_at <= ?` date window (from
 *      computeTransactionDateRange) is OMITTED. The canonical filter-OFF rule
 *      (docs/qa/tx1-canonical-list-v2.20.0.md) is pure participant membership,
 *      and the pinned tx1 window is non-binding (the verified 69 includes
 *      2026-01 rows). The audit window feeds ONLY the ghost sent_at scan (in
 *      the adapter). Full reconciliation of window semantics is deferred to
 *      BACKLOG-1887 / FU-1 (per SR review A2).
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
    'SELECT DISTINCT e.id AS id, e.subject AS subject, e.sent_at AS sent_at\n' +
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
