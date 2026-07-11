'use strict';
/**
 * QA Harness — SEARCH + ATTACH determinism MEASUREMENT helpers (BACKLOG-1853 / QA-H6).
 *
 * Pure, dependency-free CommonJS. Require-able from BOTH:
 *   - the plain-node/Electron measurement shell (search-attach-measure.js), and
 *   - Jest unit tests (no Electron, no native module, no keychain needed).
 *
 * This module NEVER requires `electron` or `better-sqlite3-multiple-ciphers`
 * at the top level, so it loads cleanly under plain Node / Jest. It mirrors the
 * H3 split (BACKLOG-1850): the DB-side MEASUREMENT (query builders + row→member)
 * lives here; the set-IDENTITY semantics (MULTISET diff, exact-count eval) live
 * in H1's shared modules (diff.ts / canonicalList.ts, BACKLOG-1848) and are
 * applied by the search-attach-asserter.ts adapter.
 *
 * ── WHAT IT REPLAYS (grounded in app source, verified) ─────────────────────
 *  1. LOCAL FREE-TEXT SEARCH — messageDbService.searchLocalEmailCache:
 *     case-insensitive LIKE over emails.(subject | sender | body_plain).
 *     `sender` is the From address ONLY; it does NOT scan email_participants,
 *     so To/Cc/BCC recipients are NOT reachable by free-text search.
 *  2. PARTICIPANT SEARCH — the email_participants junction (BACKLOG-1722):
 *     indexed exact match on email_address, optionally scoped to a role
 *     ('from'|'to'|'cc'|'bcc'). This is how BCC-only recipients ARE reachable.
 *  3. THREAD GROUPING — emails.thread_id (provider conversationId/threadId per
 *     BACKLOG-1721 MAPI seed). No in-reply-to/references reconstruction.
 *  4. WHOLE-THREAD ATTACH EXPANSION — communicationDbService inserts ONE
 *     communications row with thread_id set and email_id NULL; it expands at
 *     query time to EVERY email sharing that thread_id. A single-email attach
 *     sets email_id and links exactly that one email.
 *  5. GHOST / STALE-SEARCH (BACKLOG-1764) — a server-deleted message is
 *     hard-deleted + recorded in email_tombstones (keyed by message_id_header).
 *     A "resurrection" is a LIVE emails row whose message_id_header matches a
 *     tombstone: search must never surface one.
 *
 * SET-IDENTITY RULE (mirrors H1 types.ts): membership is keyed by
 * (subject, shiftedDate) — NEVER Message-ID. Membership is a MULTISET, so this
 * module does NOT de-duplicate. Date shifting reuses H3's source-timezone logic.
 *
 * INTENTIONAL DIVERGENCES from the app (documented, like H3):
 *   - Free-text terms are wrapped `%term%` with no LIKE ESCAPE clause (the fixed
 *     H6 query set contains no `%`/`_` wildcards). Terms with LIKE metacharacters
 *     are out of scope for the deterministic query set.
 *   - `limit` from searchLocalEmailCache is OMITTED: the determinism suite asserts
 *     the FULL result set, not a truncated page.
 */

const core = require('./db-set-diff-core'); // shiftedDateOf, rowToMember, buildDerivedQuery

// ---------------------------------------------------------------------------
// Query normalization (the whitespace-prefix regression, BACKLOG-1550/1841)
// ---------------------------------------------------------------------------

/**
 * Normalize a user search query the way a robust search box must: trim leading/
 * trailing whitespace and collapse internal runs to a single space. The
 * whitespace-prefixed regression (BACKLOG-1550/1841) is exactly a query like
 * "  amanda" that a naive `%query%` would turn into "%  amanda%" and miss real
 * hits. The deterministic expectation is that the normalized and raw queries
 * return the SAME set — i.e. leading/trailing whitespace is not significant.
 * @param {string|null|undefined} q
 * @returns {string}
 */
function normalizeQuery(q) {
  return String(q ?? '').trim().replace(/\s+/g, ' ');
}

/** Build a case-insensitive LIKE param `%term%` (term lowercased). */
function likeParam(term) {
  return `%${String(term).toLowerCase()}%`;
}

// ---------------------------------------------------------------------------
// 1. Local free-text search — replays messageDbService.searchLocalEmailCache
// ---------------------------------------------------------------------------

/**
 * Replay the app's local free-text email search: a case-insensitive LIKE over
 * subject / sender / body_plain, scoped to a user. Returns EXACT-shape rows
 * (id, user_id, subject, sent_at) so results diff by (subject, shiftedDate).
 *
 * @param {{query: string, userId?: string|null, normalize?: boolean}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildLocalSearchQuery(opts) {
  const rawQuery = opts.query;
  if (rawQuery === null || rawQuery === undefined || String(rawQuery).length === 0) {
    throw new Error('buildLocalSearchQuery: a non-empty query is required');
  }
  const normalize = opts.normalize !== false; // default true
  const term = normalize ? normalizeQuery(rawQuery) : String(rawQuery);
  const userId = opts.userId || null;
  const pattern = likeParam(term);

  /** @type {string[]} */
  const params = [];
  let sql =
    'SELECT DISTINCT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM emails e\n' +
    ' WHERE 1 = 1';
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql +=
    '\n   AND (LOWER(e.subject) LIKE ?' +
    "\n        OR LOWER(e.sender) LIKE ?" +
    "\n        OR LOWER(COALESCE(e.body_plain, '')) LIKE ?)";
  params.push(pattern, pattern, pattern);
  sql += '\n ORDER BY e.sent_at, e.id';
  return { sql, params };
}

/**
 * Subject-ONLY LIKE search. Free-text search over the full corpus also matches
 * `sender`/`body_plain`, which are NOT enumerable from the committed canonical
 * checklist (bodies of the 121 non-TX1 emails are not committed). For the
 * EXACT-count cells we therefore anchor on subject, whose expected set IS
 * derivable from the canonical list for TX1-confined phrases.
 *
 * @param {{term: string, userId?: string|null, normalize?: boolean}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildSubjectSearchQuery(opts) {
  const rawTerm = opts.term;
  if (rawTerm === null || rawTerm === undefined || String(rawTerm).length === 0) {
    throw new Error('buildSubjectSearchQuery: a non-empty term is required');
  }
  const normalize = opts.normalize !== false;
  const term = normalize ? normalizeQuery(rawTerm) : String(rawTerm);
  const userId = opts.userId || null;
  /** @type {string[]} */
  const params = [];
  let sql =
    'SELECT DISTINCT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM emails e\n' +
    ' WHERE 1 = 1';
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql += '\n   AND LOWER(e.subject) LIKE ?';
  params.push(likeParam(term));
  sql += '\n ORDER BY e.sent_at, e.id';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 2. Participant search — replays the email_participants junction lookup
// ---------------------------------------------------------------------------

/**
 * Replay a participant-junction search: emails where a given address appears as
 * a participant, optionally scoped to a role ('from'|'to'|'cc'|'bcc') or a set
 * of roles. This is how BCC-only recipients are reachable (free-text search
 * cannot reach them).
 *
 * @param {{addresses: string[], role?: string|null, roles?: string[]|null, userId?: string|null}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildParticipantSearchQuery(opts) {
  const addresses = opts.addresses || [];
  if (addresses.length === 0) {
    throw new Error('buildParticipantSearchQuery: at least one address is required');
  }
  const roles = Array.isArray(opts.roles) && opts.roles.length > 0
    ? opts.roles
    : (opts.role ? [opts.role] : []);
  const userId = opts.userId || null;
  const placeholders = addresses.map(() => '?').join(', ');
  /** @type {string[]} */
  const params = [];
  let sql =
    'SELECT DISTINCT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM email_participants ep\n' +
    '  JOIN emails e ON e.id = ep.email_id\n' +
    ` WHERE ep.email_address IN (${placeholders})`;
  for (const a of addresses) params.push(String(a).toLowerCase().trim());
  if (roles.length > 0) {
    const rolePlaceholders = roles.map(() => '?').join(', ');
    sql += `\n   AND ep.role IN (${rolePlaceholders})`;
    for (const r of roles) params.push(String(r).toLowerCase().trim());
  }
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql += '\n ORDER BY e.sent_at, e.id';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 3. Thread grouping — emails.thread_id
// ---------------------------------------------------------------------------

/**
 * All threadable emails for a user (thread_id present), ordered for stable
 * grouping. Returns rows (thread_id, id, subject, sent_at).
 * @param {{userId?: string|null}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildThreadGroupingQuery(opts) {
  const userId = (opts && opts.userId) || null;
  /** @type {string[]} */
  const params = [];
  let sql =
    'SELECT e.thread_id AS thread_id, e.id AS id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM emails e\n' +
    " WHERE e.thread_id IS NOT NULL AND e.thread_id <> ''";
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql += '\n ORDER BY e.thread_id, e.sent_at, e.id';
  return { sql, params };
}

/**
 * Members of ONE thread (the whole-thread attach expansion): every email
 * sharing a thread_id. This is what a single communications row with
 * thread_id set (email_id NULL) links.
 * @param {{threadId: string, userId?: string|null}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildThreadMembersQuery(opts) {
  const threadId = opts.threadId;
  if (threadId === null || threadId === undefined || String(threadId).length === 0) {
    throw new Error('buildThreadMembersQuery: a threadId is required');
  }
  const userId = opts.userId || null;
  /** @type {string[]} */
  const params = [String(threadId)];
  let sql =
    'SELECT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at\n' +
    '  FROM emails e\n' +
    ' WHERE e.thread_id = ?';
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql += '\n ORDER BY e.sent_at, e.id';
  return { sql, params };
}

/**
 * Raw communications rows for a transaction (used to reconstruct the effective
 * linked set, including thread-link expansion). Returns
 * (email_id, thread_id, link_source).
 * @param {{transactionId: string}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildTransactionLinksQuery(opts) {
  const transactionId = opts.transactionId;
  if (transactionId === null || transactionId === undefined || String(transactionId).length === 0) {
    throw new Error('buildTransactionLinksQuery: a transactionId is required');
  }
  return {
    sql:
      'SELECT c.email_id AS email_id, c.thread_id AS thread_id, c.link_source AS link_source\n' +
      '  FROM communications c\n' +
      ' WHERE c.transaction_id = ?',
    params: [String(transactionId)],
  };
}

// ---------------------------------------------------------------------------
// 5. Ghost / stale-search scan — emails ⋈ email_tombstones on message_id_header
// ---------------------------------------------------------------------------

/**
 * Resurrection scan: LIVE emails rows whose message_id_header matches a
 * tombstoned (server-deleted) message. A non-empty result is the BACKLOG-1764
 * ghost regression. Scoped to a user.
 * @param {{userId?: string|null}} opts
 * @returns {{sql: string, params: Array<string>}}
 */
function buildGhostScanQuery(opts) {
  const userId = (opts && opts.userId) || null;
  /** @type {string[]} */
  const params = [];
  let sql =
    'SELECT e.id AS id, e.user_id AS user_id, e.subject AS subject, e.sent_at AS sent_at,\n' +
    '       e.message_id_header AS message_id_header, t.reason AS reason\n' +
    '  FROM emails e\n' +
    '  JOIN email_tombstones t\n' +
    '    ON t.user_id = e.user_id\n' +
    '   AND t.message_id_header IS NOT NULL\n' +
    "   AND t.message_id_header <> ''\n" +
    '   AND t.message_id_header = e.message_id_header\n' +
    " WHERE e.message_id_header IS NOT NULL AND e.message_id_header <> ''";
  if (userId) {
    sql += '\n   AND e.user_id = ?';
    params.push(userId);
  }
  sql += '\n ORDER BY e.sent_at, e.id';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Pure derivations (JS-testable; no DB)
// ---------------------------------------------------------------------------

/**
 * Strip repeated reply/forward prefixes so an email's "subject family" is the
 * thread's root subject. Handles "Re:", "RE:", "Fwd:", "FW:", "Fw:" with
 * optional whitespace, applied repeatedly (e.g. "Re: Fwd: X" → "X").
 * @param {string} subject
 * @returns {string}
 */
function normalizeSubjectFamily(subject) {
  let s = String(subject ?? '').trim();
  // Repeatedly strip a leading Re:/Fwd:/FW: token.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const stripped = s.replace(/^(re|fwd|fw)\s*:\s*/i, '');
    if (stripped === s) break;
    s = stripped;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Group emails by thread_id. Rows with a null/empty thread_id are dropped
 * (they are not threadable). Preserves row order within a bucket.
 * @param {Array<{thread_id?: string, subject?: string, sent_at?: string, id?: string}>} rows
 * @returns {Map<string, Array<object>>}
 */
function groupByThread(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const tid = String(r.thread_id ?? '');
    if (tid === '') continue;
    const bucket = map.get(tid);
    if (bucket) bucket.push(r);
    else map.set(tid, [r]);
  }
  return map;
}

/**
 * Reconstruct the EFFECTIVE linked email-id set for a transaction from its raw
 * communications rows + the corpus emails, replaying the app's link semantics:
 *   - a row with email_id links exactly that email;
 *   - a row with thread_id (email_id NULL) links EVERY email sharing that
 *     thread_id (whole-thread attach expansion).
 * Returns a de-duplicated Set of email ids (a given email may be reached by
 * both a direct link and a thread link — it is still one linked email).
 * @param {Array<{email_id?: string|null, thread_id?: string|null}>} commRows
 * @param {Array<{id: string, thread_id?: string|null}>} emailRows
 * @returns {Set<string>}
 */
function expandLinkedEmailIds(commRows, emailRows) {
  const byThread = new Map();
  for (const e of emailRows || []) {
    const tid = String(e.thread_id ?? '');
    if (tid === '') continue;
    const bucket = byThread.get(tid);
    if (bucket) bucket.push(String(e.id));
    else byThread.set(tid, [String(e.id)]);
  }
  const linked = new Set();
  for (const c of commRows || []) {
    if (c.email_id !== null && c.email_id !== undefined && String(c.email_id) !== '') {
      linked.add(String(c.email_id));
      continue;
    }
    const tid = String(c.thread_id ?? '');
    if (tid === '') continue;
    for (const id of byThread.get(tid) || []) linked.add(id);
  }
  return linked;
}

/**
 * The EXACT link-count delta of attaching a whole thread: the number of thread
 * members not already linked. Whole-thread attach must add exactly the thread's
 * previously-unlinked members — no more, no fewer.
 * @param {string} threadId
 * @param {Array<{id: string, thread_id?: string|null}>} emailRows
 * @param {Iterable<string>} alreadyLinkedIds
 * @returns {{members: string[], delta: number, newlyLinked: string[]}}
 */
function threadAttachDelta(threadId, emailRows, alreadyLinkedIds) {
  const tid = String(threadId);
  const already = new Set([...(alreadyLinkedIds || [])].map(String));
  const members = [];
  const newlyLinked = [];
  for (const e of emailRows || []) {
    if (String(e.thread_id ?? '') !== tid) continue;
    const id = String(e.id);
    members.push(id);
    if (!already.has(id)) newlyLinked.push(id);
  }
  return { members, delta: newlyLinked.length, newlyLinked };
}

/**
 * The EXACT link-count delta of attaching a single email: 1 if not already
 * linked, else 0.
 * @param {string} emailId
 * @param {Iterable<string>} alreadyLinkedIds
 * @returns {{delta: number}}
 */
function singleAttachDelta(emailId, alreadyLinkedIds) {
  const already = new Set([...(alreadyLinkedIds || [])].map(String));
  return { delta: already.has(String(emailId)) ? 0 : 1 };
}

/**
 * Find resurrected (ghost) emails: live rows whose message_id_header matches a
 * tombstone. Pure mirror of buildGhostScanQuery for JS-level testing.
 * @param {Array<{id?: string, subject?: string, sent_at?: string, message_id_header?: string|null}>} emailRows
 * @param {Array<{message_id_header?: string|null}>} tombstoneRows
 * @returns {Array<object>}
 */
function findResurrections(emailRows, tombstoneRows) {
  const tomb = new Set();
  for (const t of tombstoneRows || []) {
    const h = String(t.message_id_header ?? '');
    if (h !== '') tomb.add(h);
  }
  const out = [];
  for (const e of emailRows || []) {
    const h = String(e.message_id_header ?? '');
    if (h !== '' && tomb.has(h)) out.push(e);
  }
  return out;
}

module.exports = {
  // shared identity (re-exported from H3 core so the shell has one import)
  shiftedDateOf: core.shiftedDateOf,
  rowToMember: core.rowToMember,
  // normalization
  normalizeQuery,
  likeParam,
  normalizeSubjectFamily,
  // query builders (replay app SQL)
  buildLocalSearchQuery,
  buildSubjectSearchQuery,
  buildParticipantSearchQuery,
  buildThreadGroupingQuery,
  buildThreadMembersQuery,
  buildTransactionLinksQuery,
  buildGhostScanQuery,
  // pure derivations
  groupByThread,
  expandLinkedEmailIds,
  threadAttachDelta,
  singleAttachDelta,
  findResurrections,
};
