'use strict';
/**
 * Unit tests for the QA-H3 DB-side MEASUREMENT helpers (BACKLOG-1850).
 *
 * Pure logic only — no Electron, no native module, no keychain. Runs under the
 * local (non-CI) jest glob. Set-identity/diff logic is H1's (diff.ts /
 * canonicalList.ts); this file covers only the DB query/measurement helpers.
 */
const core = require('../db-set-diff-core');

const TZ = 'America/Los_Angeles';

describe('shiftedDateOf', () => {
  test('no timezone → raw UTC slice(0,10)', () => {
    expect(core.shiftedDateOf('2026-02-07T18:30:00.000Z')).toBe('2026-02-07');
    expect(core.shiftedDateOf('2026-02-07 18:30:00')).toBe('2026-02-07');
  });

  test('source timezone → local calendar date (fixes evening +1-day rows)', () => {
    // Daytime Pacific: UTC date == local date.
    expect(core.shiftedDateOf('2026-02-09T22:30:00.000Z', TZ)).toBe('2026-02-09');
    // Evening Pacific (PST, UTC-8): 00:30Z is the PREVIOUS Pacific day.
    expect(core.shiftedDateOf('2026-02-08T00:30:00.000Z', TZ)).toBe('2026-02-07');
    // April is PDT (UTC-7): 01:30Z is the previous Pacific day.
    expect(core.shiftedDateOf('2026-04-15T01:30:00.000Z', TZ)).toBe('2026-04-14');
  });

  test('null/short/unparseable inputs', () => {
    expect(core.shiftedDateOf(null)).toBe('');
    expect(core.shiftedDateOf(undefined, TZ)).toBe('');
    expect(core.shiftedDateOf('2026')).toBe('2026');
    expect(core.shiftedDateOf('not a valid date string', TZ)).toBe('not a vali'); // unparseable → slice(0,10) fallback
  });
});

describe('rowToMember', () => {
  test('trims subject and derives shiftedDate in the given timezone', () => {
    expect(core.rowToMember({ subject: '  Hi  ', sent_at: '2026-02-08T00:30:00.000Z' }, TZ)).toEqual({
      subject: 'Hi',
      shiftedDate: '2026-02-07',
    });
  });
  test('null-ish fields degrade to empty strings', () => {
    expect(core.rowToMember({})).toEqual({ subject: '', shiftedDate: '' });
    expect(core.rowToMember({ subject: null, sent_at: null }, TZ)).toEqual({ subject: '', shiftedDate: '' });
  });
});

describe('buildDerivedQuery (replays autoLinkService junction SQL)', () => {
  const contacts = ['A@X.com', 'b@y.com'];

  test('selects user_id (for corpus-user scoping) + no LIKE for filter-OFF', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts });
    expect(sql).toContain('e.user_id AS user_id');
    expect(sql).toContain('FROM email_participants ep');
    expect(sql).toContain('ep.email_address IN (?, ?)');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual(['a@x.com', 'b@y.com']);
  });

  test('filter-ON: one LIKE per token, exact app expression + %token% params', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts, tokens: ['742', 'birchwood', 'lane', 'ne'] });
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
