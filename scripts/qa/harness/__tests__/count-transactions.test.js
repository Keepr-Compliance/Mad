'use strict';
/**
 * Unit proofs for the CREATE-AUDIT DB reader's PURE parts (BACKLOG-1948).
 *
 * The reader (count-transactions.js) opens the encrypted DB under Electron's ABI, so the DB path is
 * NOT exercised here. But its ARGUMENT parsing, its WHERE/param builder, and its LIKE escaping are
 * pure and load-bearing (a wrong query would silently mis-count the created transaction), so they are
 * proven here — pure Node, no Electron, no DB. Runs under jest.qa.config.js.
 */
const { parseArgs, buildQuery, escapeLike, SENTINEL } = require('../count-transactions.js');

describe('parseArgs', () => {
  it('parses the full argv (db/key/address/started-at)', () => {
    const opts = parseArgs([
      '--db', '/tmp/mad.db',
      '--key', 'a'.repeat(64),
      '--address', '1948 Harness Way, Auditville, QA 00019',
      '--started-at', '2024-03-15',
    ]);
    expect(opts).toEqual({
      db: '/tmp/mad.db',
      key: 'a'.repeat(64),
      address: '1948 Harness Way, Auditville, QA 00019',
      startedAt: '2024-03-15',
    });
  });

  it('parses without the optional --started-at', () => {
    const opts = parseArgs(['--db', '/tmp/mad.db', '--key', 'k', '--address', 'A St']);
    expect(opts).toEqual({ db: '/tmp/mad.db', key: 'k', address: 'A St' });
    expect(opts.startedAt).toBeUndefined();
  });

  it('recognises --help/-h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('buildQuery', () => {
  it('matches property_address exactly when no started-at is given', () => {
    const { where, params } = buildQuery({ address: 'A St' });
    expect(where).toBe('property_address = ?');
    expect(params).toEqual(['A St']);
  });

  it('adds a started_at prefix LIKE (with ESCAPE) when started-at is given', () => {
    const { where, params } = buildQuery({ address: 'A St', startedAt: '2024-03-15' });
    expect(where).toBe("property_address = ? AND started_at LIKE ? ESCAPE '\\'");
    expect(params).toEqual(['A St', '2024-03-15%']);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE metacharacters so a date prefix can never act as a wildcard', () => {
    expect(escapeLike('2024-03-15')).toBe('2024-03-15'); // dates carry no metachars
    expect(escapeLike('50%_x\\y')).toBe('50\\%\\_x\\\\y');
  });
});

describe('SENTINEL', () => {
  it('is the stable prefix the TS wrapper parses', () => {
    expect(SENTINEL).toBe('__QA_TX_COUNT__ ');
  });
});
