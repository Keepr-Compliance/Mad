'use strict';
/**
 * Unit tests for the QA-H3 DB-side MEASUREMENT helpers (BACKLOG-1850).
 *
 * Pure logic only — no Electron, no native module, no keychain. Runs under the
 * local (non-CI) jest glob (`**\/__tests__/**`). The set-identity/diff logic is
 * H1's (diff.ts / canonicalList.ts) and is tested there + in
 * db-set-diff-multiset.test.ts; this file covers only the DB query/measurement.
 */
const core = require('../db-set-diff-core');

describe('shiftedDateOf', () => {
  test('extracts YYYY-MM-DD from ISO-T and space forms', () => {
    expect(core.shiftedDateOf('2026-02-07T18:30:00.000Z')).toBe('2026-02-07');
    expect(core.shiftedDateOf('2026-02-07 18:30:00')).toBe('2026-02-07');
  });
  test('handles the +1-day UTC row by trusting the stored value', () => {
    // A corpus Date of 2026-02-07 16:xx -0800 lands 2026-02-08 in UTC.
    expect(core.shiftedDateOf('2026-02-08T00:30:00.000Z')).toBe('2026-02-08');
  });
  test('null/short inputs', () => {
    expect(core.shiftedDateOf(null)).toBe('');
    expect(core.shiftedDateOf(undefined)).toBe('');
    expect(core.shiftedDateOf('2026')).toBe('2026');
  });
});

describe('rowToMember', () => {
  test('trims subject and derives shiftedDate; does NOT de-duplicate', () => {
    expect(core.rowToMember({ subject: '  Hello  ', sent_at: '2026-02-08T10:00:00Z' })).toEqual({
      subject: 'Hello',
      shiftedDate: '2026-02-08',
    });
  });
  test('null-ish fields degrade to empty strings', () => {
    expect(core.rowToMember({})).toEqual({ subject: '', shiftedDate: '' });
    expect(core.rowToMember({ subject: null, sent_at: null })).toEqual({ subject: '', shiftedDate: '' });
  });
});

describe('buildDerivedQuery (replays autoLinkService junction SQL)', () => {
  const contacts = ['A@X.com', 'b@y.com'];

  test('filter-OFF: no LIKE clauses, lowercased contact params', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts });
    expect(sql).toContain('FROM email_participants ep');
    expect(sql).toContain('JOIN emails e ON e.id = ep.email_id');
    expect(sql).toContain('ep.email_address IN (?, ?)');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual(['a@x.com', 'b@y.com']);
  });

  test('filter-ON: one LIKE per token, exact app expression + %token% params', () => {
    const { sql, params } = core.buildDerivedQuery({
      contacts,
      tokens: ['742', 'birchwood', 'lane', 'ne'],
    });
    expect(sql).toContain("LOWER(e.subject || ' ' || COALESCE(e.body_plain, '')) LIKE ?");
    expect(sql.match(/LIKE \?/g) || []).toHaveLength(4);
    expect(params).toEqual(['a@x.com', 'b@y.com', '%742%', '%birchwood%', '%lane%', '%ne%']);
  });

  test('userId adds an e.user_id clause in the right param order', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts, userId: 'u-1', tokens: ['x'] });
    expect(sql).toContain('AND e.user_id = ?');
    expect(params).toEqual(['a@x.com', 'b@y.com', 'u-1', '%x%']);
  });

  test('throws when no contacts', () => {
    expect(() => core.buildDerivedQuery({ contacts: [] })).toThrow(/at least one contact/);
  });
});
