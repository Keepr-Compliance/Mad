'use strict';
/**
 * Unit tests for the QA-H6 SEARCH + ATTACH measurement helpers (BACKLOG-1853).
 *
 * Pure logic only — no Electron, no native module, no keychain, no DB. Covers
 * the query builders (replaying app SQL) + the pure derivations. Set-identity /
 * diff logic is H1's (diff.ts); this file covers only H6's DB-measure helpers.
 */
const core = require('../search-attach-core');

describe('normalizeQuery (whitespace-prefix regression, BACKLOG-1550/1841)', () => {
  test('trims leading/trailing and collapses internal whitespace', () => {
    expect(core.normalizeQuery('  amanda  ')).toBe('amanda');
    expect(core.normalizeQuery('\t amanda@x.com \n')).toBe('amanda@x.com');
    expect(core.normalizeQuery('final   walkthrough')).toBe('final walkthrough');
  });
  test('null/undefined → empty string', () => {
    expect(core.normalizeQuery(null)).toBe('');
    expect(core.normalizeQuery(undefined)).toBe('');
  });
});

describe('likeParam', () => {
  test('lowercases and wraps in %...%', () => {
    expect(core.likeParam('Birchwood')).toBe('%birchwood%');
    expect(core.likeParam('742')).toBe('%742%');
  });
});

describe('buildLocalSearchQuery (replays messageDbService.searchLocalEmailCache)', () => {
  test('LIKE over subject|sender|body_plain, 3 identical params, user scope, stable ORDER BY', () => {
    const { sql, params } = core.buildLocalSearchQuery({ query: 'Birchwood', userId: 'u1' });
    expect(sql).toContain('LOWER(e.subject) LIKE ?');
    expect(sql).toContain('LOWER(e.sender) LIKE ?');
    expect(sql).toContain("LOWER(COALESCE(e.body_plain, '')) LIKE ?");
    expect(sql).toContain('AND e.user_id = ?');
    expect(sql).toContain('ORDER BY e.sent_at, e.id');
    expect(params).toEqual(['u1', '%birchwood%', '%birchwood%', '%birchwood%']);
  });
  test('normalizes by default (whitespace-prefixed query behaves like trimmed)', () => {
    const a = core.buildLocalSearchQuery({ query: '  birchwood ' });
    const b = core.buildLocalSearchQuery({ query: 'birchwood' });
    expect(a.params).toEqual(b.params);
  });
  test('normalize:false preserves the raw (untrimmed) term — proves normalization matters', () => {
    const { params } = core.buildLocalSearchQuery({ query: '  birchwood', normalize: false });
    // 3 identical params (subject|sender|body_plain), no user scope here.
    expect(params).toEqual(['%  birchwood%', '%  birchwood%', '%  birchwood%']);
  });
  test('throws on an empty query', () => {
    expect(() => core.buildLocalSearchQuery({ query: '' })).toThrow(/non-empty query/);
  });
});

describe('buildSubjectSearchQuery', () => {
  test('subject-only LIKE, user scope', () => {
    const { sql, params } = core.buildSubjectSearchQuery({ term: 'Final Walkthrough', userId: 'u1' });
    expect(sql).toContain('LOWER(e.subject) LIKE ?');
    expect(sql).not.toContain('e.sender');
    expect(sql).not.toContain('body_plain');
    expect(params).toEqual(['u1', '%final walkthrough%']);
  });
});

describe('buildParticipantSearchQuery (email_participants junction)', () => {
  test('address IN clause, lowercased+trimmed, stable ORDER BY', () => {
    const { sql, params } = core.buildParticipantSearchQuery({ addresses: ['Amanda@X.com', ' b@y.com '] });
    expect(sql).toContain('FROM email_participants ep');
    expect(sql).toContain('ep.email_address IN (?, ?)');
    expect(sql).toContain('ORDER BY e.sent_at, e.id');
    expect(params).toEqual(['amanda@x.com', 'b@y.com']);
  });
  test('single role → role clause', () => {
    const { sql, params } = core.buildParticipantSearchQuery({ addresses: ['a@x.com'], role: 'bcc', userId: 'u1' });
    expect(sql).toContain('ep.role IN (?)');
    expect(params).toEqual(['a@x.com', 'bcc', 'u1']);
  });
  test('roles array → role IN clause', () => {
    const { sql, params } = core.buildParticipantSearchQuery({ addresses: ['a@x.com'], roles: ['from', 'to', 'cc'] });
    expect(sql).toContain('ep.role IN (?, ?, ?)');
    expect(params).toEqual(['a@x.com', 'from', 'to', 'cc']);
  });
  test('throws when no addresses', () => {
    expect(() => core.buildParticipantSearchQuery({ addresses: [] })).toThrow(/at least one address/);
  });
});

describe('thread + link + ghost query builders', () => {
  test('buildThreadGroupingQuery filters non-empty thread_id and orders deterministically', () => {
    const { sql } = core.buildThreadGroupingQuery({ userId: 'u1' });
    expect(sql).toContain("e.thread_id IS NOT NULL AND e.thread_id <> ''");
    expect(sql).toContain('ORDER BY e.thread_id, e.sent_at, e.id');
    expect(sql).toContain('AND e.user_id = ?');
  });
  test('buildThreadMembersQuery targets one thread', () => {
    const { sql, params } = core.buildThreadMembersQuery({ threadId: 'T-9', userId: 'u1' });
    expect(sql).toContain('e.thread_id = ?');
    expect(params).toEqual(['T-9', 'u1']);
  });
  test('buildTransactionLinksQuery selects email_id, thread_id, link_source', () => {
    const { sql, params } = core.buildTransactionLinksQuery({ transactionId: 'tx-1' });
    expect(sql).toContain('FROM communications c');
    expect(sql).toContain('c.transaction_id = ?');
    expect(params).toEqual(['tx-1']);
  });
  test('buildGhostScanQuery joins emails to email_tombstones on message_id_header', () => {
    const { sql } = core.buildGhostScanQuery({ userId: 'u1' });
    expect(sql).toContain('FROM emails e');
    expect(sql).toContain('JOIN email_tombstones t');
    expect(sql).toContain('t.message_id_header = e.message_id_header');
  });
});

describe('normalizeSubjectFamily', () => {
  test('strips repeated Re:/Fwd:/FW: prefixes', () => {
    expect(core.normalizeSubjectFamily('Re: 742 Birchwood')).toBe('742 Birchwood');
    expect(core.normalizeSubjectFamily('RE: Fwd: X')).toBe('X');
    expect(core.normalizeSubjectFamily('FW: Y')).toBe('Y');
    expect(core.normalizeSubjectFamily('Just A Subject')).toBe('Just A Subject');
  });
});

describe('groupByThread', () => {
  test('buckets by thread_id, drops empty/null thread_id', () => {
    const rows = [
      { id: '1', thread_id: 'T1' },
      { id: '2', thread_id: 'T1' },
      { id: '3', thread_id: 'T2' },
      { id: '4', thread_id: '' },
      { id: '5', thread_id: null },
    ];
    const g = core.groupByThread(rows);
    expect(g.size).toBe(2);
    expect(g.get('T1').map((r) => r.id)).toEqual(['1', '2']);
    expect(g.get('T2').map((r) => r.id)).toEqual(['3']);
  });
});

describe('expandLinkedEmailIds (whole-thread attach expansion)', () => {
  const emails = [
    { id: 'e1', thread_id: 'T1' },
    { id: 'e2', thread_id: 'T1' },
    { id: 'e3', thread_id: 'T1' },
    { id: 'e4', thread_id: 'T2' },
    { id: 'e5', thread_id: '' },
  ];
  test('a thread-link row expands to ALL thread members', () => {
    const comm = [{ email_id: null, thread_id: 'T1' }];
    expect([...core.expandLinkedEmailIds(comm, emails)].sort()).toEqual(['e1', 'e2', 'e3']);
  });
  test('a direct email-link row links exactly that email', () => {
    const comm = [{ email_id: 'e4', thread_id: null }];
    expect([...core.expandLinkedEmailIds(comm, emails)]).toEqual(['e4']);
  });
  test('mixed direct + thread links de-duplicate (an email reached twice counts once)', () => {
    const comm = [{ email_id: 'e1', thread_id: null }, { email_id: null, thread_id: 'T1' }];
    expect([...core.expandLinkedEmailIds(comm, emails)].sort()).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('threadAttachDelta / singleAttachDelta (EXACT link-count delta)', () => {
  const emails = [
    { id: 'e1', thread_id: 'T1' },
    { id: 'e2', thread_id: 'T1' },
    { id: 'e3', thread_id: 'T1' },
  ];
  test('whole-thread attach delta = members not already linked', () => {
    const r = core.threadAttachDelta('T1', emails, ['e1']);
    expect(r.members.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(r.delta).toBe(2);
    expect(r.newlyLinked.sort()).toEqual(['e2', 'e3']);
  });
  test('whole-thread attach into an empty transaction links all members', () => {
    expect(core.threadAttachDelta('T1', emails, []).delta).toBe(3);
  });
  test('single attach delta is 1 (new) or 0 (already linked)', () => {
    expect(core.singleAttachDelta('e9', []).delta).toBe(1);
    expect(core.singleAttachDelta('e9', ['e9']).delta).toBe(0);
  });
});

describe('findResurrections (ghost / stale-search, BACKLOG-1764)', () => {
  test('flags live emails whose message_id_header matches a tombstone', () => {
    const emails = [
      { id: 'e1', subject: 'A', message_id_header: '<a@x>' },
      { id: 'e2', subject: 'B', message_id_header: '<b@x>' },
      { id: 'e3', subject: 'C', message_id_header: '' },
    ];
    const tombstones = [{ message_id_header: '<b@x>' }, { message_id_header: '' }];
    const ghosts = core.findResurrections(emails, tombstones);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].id).toBe('e2');
  });
  test('a clean set has zero resurrections', () => {
    const emails = [{ id: 'e1', message_id_header: '<a@x>' }];
    expect(core.findResurrections(emails, [])).toHaveLength(0);
  });
});
