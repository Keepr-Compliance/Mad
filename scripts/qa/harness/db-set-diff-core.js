'use strict';
/**
 * QA Harness — DB set-diff CORE logic (BACKLOG-1850 / QA-H3).
 *
 * Pure, dependency-free CommonJS. It is deliberately require-able from BOTH:
 *   - the Electron-main standalone asserter (scripts/qa/harness/db-assert.js),
 *     which supplies rows read from the app's own encrypted DB, and
 *   - Jest unit tests (no Electron, no native module, no keychain needed).
 *
 * This module NEVER requires `electron` or `better-sqlite3-multiple-ciphers`
 * at the top level, so it loads cleanly under plain Node / Jest.
 *
 * DETERMINISTIC STANDARD (founder, v2.20.0): every gate asserts an EXACT
 * corpus-derived count, never a threshold. Every deviation is a finding to
 * explain, not a tolerance to absorb.
 *
 * SET-IDENTITY RULE (load-bearing, mirrors BACKLOG-1848 types.ts): email set
 * membership is keyed by (subject, shiftedDate) — NEVER by Message-ID. Corpus
 * .eml files carry no Message-ID; Graph assigns internetMessageId server-side.
 *
 * DERIVATION RULE (from docs/qa/tx1-canonical-list.md, DB-verified 0/0):
 *   - filter-OFF: an email is expected iff ANY From/To/Cc/Bcc address is in the
 *     transaction's contact-address set. (Pure participant match — NO date
 *     window. The canonical set legitimately includes 2026-01 emails, so the
 *     epic's "window 2026-02-05→2026-04-14" is descriptive shorthand for the
 *     property timeline, NOT the auto-link bound. See PR notes.)
 *   - filter-ON: filter-OFF AND LOWER(subject || ' ' || body_plain) contains
 *     every address token (street number + each street-name word) as a
 *     substring. Mirrors autoLinkService.ts exactly.
 *   - The audit window is used ONLY by the mechanical ghost scan.
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
 * Stable membership key. `\u0000` cannot appear in a subject, so it is a safe
 * separator even for subjects containing pipes, colons, etc.
 * @param {string} subject
 * @param {string} shiftedDate
 * @returns {string}
 */
function memberKey(subject, shiftedDate) {
  return `${(subject == null ? '' : String(subject)).trim()}\u0000${shiftedDate == null ? '' : String(shiftedDate)}`;
}

/**
 * Normalise a raw DB row ({ subject, sent_at }) to an EmailSetMember.
 * @param {{subject?: string, sent_at?: string}} row
 * @returns {{subject: string, shiftedDate: string}}
 */
function rowToMember(row) {
  return {
    subject: (row.subject == null ? '' : String(row.subject)).trim(),
    shiftedDate: shiftedDateOf(row.sent_at),
  };
}

/**
 * De-duplicate members by (subject, shiftedDate).
 * @param {Array<{subject: string, shiftedDate: string}>} members
 */
function dedupeMembers(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const k = memberKey(m.subject, m.shiftedDate);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ subject: m.subject, shiftedDate: m.shiftedDate });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical manifest parsing
// ---------------------------------------------------------------------------

/**
 * Parse the canonical expected-linked checklist markdown into rows.
 *
 * Expected table columns (see docs/qa/tx1-canonical-list.md):
 *   | # | .eml file | Subject | Shifted date | Matched contact(s) & role | ON-subset | DB |
 *
 * Pipes inside a Subject are escaped as `\|` in the markdown and are unescaped
 * here so the parsed subject matches the raw DB value exactly.
 *
 * @param {string} markdown
 * @returns {{
 *   rows: Array<{index:number, emlFile:string, subject:string, shiftedDate:string, matchedContacts:string, onSubset:boolean}>,
 *   filterOff: Array<{index:number, subject:string, shiftedDate:string, onSubset:boolean}>,
 *   filterOn: Array<{index:number, subject:string, shiftedDate:string, onSubset:boolean}>,
 * }}
 */
function parseCanonicalManifest(markdown) {
  const SENTINEL = '\u0001'; // stand-in for escaped pipe during split
  const lines = String(markdown).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    // Data rows start with `| <number> |`. This skips the header and the
    // `|---|` separator row.
    if (!/^\s*\|\s*\d+\s*\|/.test(line)) continue;
    const cols = line
      .replace(/\\\|/g, SENTINEL)
      .split('|')
      .map((c) => c.split(SENTINEL).join('|').trim());
    // cols[0] === '' (leading pipe). Data starts at cols[1].
    const index = parseInt(cols[1], 10);
    if (!Number.isFinite(index)) continue;
    if (cols.length < 7) continue;
    rows.push({
      index,
      emlFile: cols[2] || '',
      subject: cols[3] || '',
      shiftedDate: cols[4] || '',
      matchedContacts: cols[5] || '',
      onSubset: /^yes$/i.test(cols[6] || ''),
    });
  }
  const filterOff = rows.map((r) => ({
    index: r.index,
    subject: r.subject,
    shiftedDate: r.shiftedDate,
    onSubset: r.onSubset,
  }));
  const filterOn = filterOff.filter((r) => r.onSubset);
  return { rows, filterOff, filterOn };
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
 * The `communications` LEFT JOIN / `c.id IS NULL` de-dup from the app is
 * intentionally OMITTED: we derive the FULL expected set (what SHOULD be
 * linked), independent of what is already linked.
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

// ---------------------------------------------------------------------------
// Set diff
// ---------------------------------------------------------------------------

/**
 * Diff actual vs expected member sets by (subject, shiftedDate).
 * @param {Array<{subject:string, shiftedDate:string}>} actual
 * @param {Array<{subject:string, shiftedDate:string}>} expected
 * @returns {{missing: Array, extra: Array}} missing = expected-not-actual; extra = actual-not-expected
 */
function diffMembers(actual, expected) {
  const key = (m) => memberKey(m.subject, m.shiftedDate);
  const actualKeys = new Set(actual.map(key));
  const expectedKeys = new Set(expected.map(key));
  const missing = dedupeMembers(expected.filter((m) => !actualKeys.has(key(m))));
  const extra = dedupeMembers(actual.filter((m) => !expectedKeys.has(key(m))));
  return { missing, extra };
}

/**
 * Mechanical ghost scan: linked members whose shiftedDate falls OUTSIDE the
 * inclusive [start, end] window. Dates are YYYY-MM-DD strings; lexical compare
 * is calendar-correct for that format.
 * @param {Array<{subject:string, shiftedDate:string}>} linkedMembers
 * @param {{start: string, end: string}} window
 */
function findGhosts(linkedMembers, window) {
  const start = window.start;
  const end = window.end;
  return dedupeMembers(
    linkedMembers.filter((m) => {
      const d = m.shiftedDate;
      if (!d) return true; // no date at all == ghost
      return d < start || d > end;
    }),
  );
}

/**
 * The inclusive [min, max] shifted-date span of a canonical set — the default,
 * mechanically-derived ghost window (avoids false positives from an over-narrow
 * scenario window while still catching truly out-of-corpus links).
 * @param {Array<{shiftedDate:string}>} canonicalRows
 * @returns {{start: string, end: string}|null}
 */
function canonicalDateSpan(canonicalRows) {
  const dates = canonicalRows.map((r) => r.shiftedDate).filter(Boolean).sort();
  if (dates.length === 0) return null;
  return { start: dates[0], end: dates[dates.length - 1] };
}

/**
 * Non-auto links: linked rows whose link_source is not 'auto'.
 * @param {Array<{subject:string, shiftedDate:string, link_source?:string}>} linkedRows
 */
function findNonAutoLinks(linkedRows) {
  return linkedRows
    .filter((r) => r.link_source !== 'auto')
    .map((r) => ({ subject: r.subject, shiftedDate: r.shiftedDate, linkSource: r.link_source || null }));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Evaluate all gates and produce an exact-count verdict.
 *
 * @param {{
 *   expectedCounts: {corpus?:number, filterOff:number, filterOn:number, missing?:number, extra?:number, ghosts?:number},
 *   canonical: {filterOff: Array, filterOn: Array},
 *   actual: {
 *     corpus: number,
 *     filterOff: Array<{subject:string, shiftedDate:string}>,
 *     filterOn: Array<{subject:string, shiftedDate:string}>,
 *     linked?: Array<{subject:string, shiftedDate:string, link_source?:string}>,
 *     ghosts?: Array<{subject:string, shiftedDate:string}>,
 *   },
 * }} input
 * @returns {{passed: boolean, deviations: Array, summary: object}}
 */
function evaluate(input) {
  const { expectedCounts, canonical, actual } = input;
  const deviations = [];

  // 1. corpus
  if (typeof expectedCounts.corpus === 'number' && actual.corpus !== expectedCounts.corpus) {
    deviations.push({ cell: 'corpus', expected: expectedCounts.corpus, got: actual.corpus });
  }

  // 2. filter-OFF exact count
  if (actual.filterOff.length !== expectedCounts.filterOff) {
    deviations.push({ cell: 'filterOff', expected: expectedCounts.filterOff, got: actual.filterOff.length });
  }

  // 3. filter-ON exact count
  if (actual.filterOn.length !== expectedCounts.filterOn) {
    deviations.push({ cell: 'filterOn', expected: expectedCounts.filterOn, got: actual.filterOn.length });
  }

  // 4. membership: derived filter-OFF vs canonical
  const offDiff = diffMembers(actual.filterOff, canonical.filterOff);
  if (offDiff.missing.length > 0) {
    deviations.push({
      cell: 'missing',
      expected: 0,
      got: offDiff.missing.length,
      missingMembers: offDiff.missing,
    });
  }
  if (offDiff.extra.length > 0) {
    deviations.push({
      cell: 'extra',
      expected: 0,
      got: offDiff.extra.length,
      extraMembers: offDiff.extra,
    });
  }

  // 5. membership: derived filter-ON vs canonical (surface as its own cell so a
  //    correct 69 with a wrong ON subset is still caught).
  const onDiff = diffMembers(actual.filterOn, canonical.filterOn);
  if (onDiff.missing.length > 0 || onDiff.extra.length > 0) {
    deviations.push({
      cell: 'filterOn-membership',
      expected: canonical.filterOn.length,
      got: actual.filterOn.length,
      missingMembers: onDiff.missing,
      extraMembers: onDiff.extra,
    });
  }

  // 6. link_source integrity (only when the linked set was resolved).
  let nonAuto = [];
  if (Array.isArray(actual.linked)) {
    nonAuto = findNonAutoLinks(actual.linked);
    if (nonAuto.length > 0) {
      deviations.push({
        cell: 'link_source',
        expected: 0,
        got: nonAuto.length,
        extraMembers: nonAuto.map((m) => ({ subject: m.subject, shiftedDate: m.shiftedDate })),
      });
    }
  }

  // 7. ghosts
  const ghosts = actual.ghosts || [];
  if (ghosts.length > 0) {
    deviations.push({
      cell: 'ghosts',
      expected: 0,
      got: ghosts.length,
      extraMembers: ghosts,
    });
  }

  const summary = {
    corpus: actual.corpus,
    filterOff: actual.filterOff.length,
    filterOn: actual.filterOn.length,
    missing: offDiff.missing.length,
    extra: offDiff.extra.length,
    ghosts: ghosts.length,
    nonAutoLinks: nonAuto.length,
    linkedResolved: Array.isArray(actual.linked),
  };

  return { passed: deviations.length === 0, deviations, summary };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Render a human-readable report for the CLI.
 * @param {{scenarioId:string, passed:boolean, deviations:Array, summary:object}} result
 * @returns {string}
 */
function formatReport(result) {
  const s = result.summary;
  const ok = (cond) => (cond ? 'PASS' : 'FAIL');
  const lines = [];
  lines.push(`QA DB set-diff — ${result.scenarioId}`);
  lines.push('─'.repeat(60));
  lines.push(`  corpus         : ${s.corpus}`);
  lines.push(`  filter-OFF     : ${s.filterOff}`);
  lines.push(`  filter-ON      : ${s.filterOn}`);
  lines.push(`  missing        : ${s.missing}   [${ok(s.missing === 0)}]`);
  lines.push(`  extra          : ${s.extra}   [${ok(s.extra === 0)}]`);
  lines.push(`  ghosts         : ${s.ghosts}   [${ok(s.ghosts === 0)}]`);
  if (s.linkedResolved) {
    lines.push(`  link_source    : ${s.nonAutoLinks} non-auto   [${ok(s.nonAutoLinks === 0)}]`);
  } else {
    lines.push('  link_source    : (no transaction links resolved — skipped)');
  }
  lines.push('─'.repeat(60));
  if (result.deviations.length === 0) {
    lines.push('  VERDICT: PASS — all exact counts hold.');
    return lines.join('\n');
  }
  lines.push(`  VERDICT: FAIL — ${result.deviations.length} deviation(s):`);
  for (const d of result.deviations) {
    lines.push(`   • ${d.cell}: expected ${d.expected}, got ${d.got}`);
    for (const m of d.missingMembers || []) {
      lines.push(`       MISSING  ${m.shiftedDate}  ${m.subject}`);
    }
    for (const m of d.extraMembers || []) {
      lines.push(`       EXTRA    ${m.shiftedDate}  ${m.subject}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  shiftedDateOf,
  memberKey,
  rowToMember,
  dedupeMembers,
  parseCanonicalManifest,
  buildDerivedQuery,
  diffMembers,
  findGhosts,
  canonicalDateSpan,
  findNonAutoLinks,
  evaluate,
  formatReport,
};
