/**
 * Unit proofs for the manual-attach reader's pure query builder (BACKLOG-1979).
 *
 * count-linked-by-source.js opens the encrypted DB (Electron ABI) at runtime, but its SQL-building is
 * pure and DB-free — so we test buildCountQuery here under plain-node jest (npm run qa:test), with NO
 * app launch, DB, or keychain. This pins the exact WHERE shape the manual-attach cell relies on:
 *   - always scopes to the transaction and to non-null email_id (a real email link, not a text link);
 *   - adds link_source = ? only when --link-source is given, and only accepts auto|manual|scan;
 *   - adds email_id = ? only when --email-id is given;
 *   - counts DISTINCT email_id (a thread-expanded double-link is still one linked email).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reader = require('../count-linked-by-source.js') as {
  buildCountQuery: (opts: {
    transactionId?: string;
    linkSource?: string;
    emailId?: string;
  }) => { sql: string; params: string[] };
  VALID_SOURCES: Set<string>;
  parseArgs: (argv: string[]) => Record<string, string | boolean>;
  SENTINEL: string;
};

describe('count-linked-by-source buildCountQuery (BACKLOG-1979)', () => {
  it('requires a transactionId', () => {
    expect(() => reader.buildCountQuery({})).toThrow(/--transaction-id/i);
  });

  it('base query scopes to the transaction and non-null email_id, counting DISTINCT email_id', () => {
    const { sql, params } = reader.buildCountQuery({ transactionId: 'tx-1' });
    expect(sql).toContain('COUNT(DISTINCT email_id)');
    expect(sql).toContain('FROM communications');
    expect(sql).toContain('transaction_id = ?');
    expect(sql).toContain('email_id IS NOT NULL');
    expect(sql).not.toContain('link_source = ?');
    expect(params).toEqual(['tx-1']);
  });

  it('adds a link_source filter only when provided', () => {
    const { sql, params } = reader.buildCountQuery({ transactionId: 'tx-1', linkSource: 'manual' });
    expect(sql).toContain('link_source = ?');
    expect(params).toEqual(['tx-1', 'manual']);
  });

  it('adds an email_id filter only when provided (and keeps param order stable)', () => {
    const { sql, params } = reader.buildCountQuery({
      transactionId: 'tx-1',
      linkSource: 'manual',
      emailId: 'qa-seed-email-manual-attach-1',
    });
    expect(sql).toContain('email_id = ?');
    // transaction → link_source → email_id, matching the clause build order.
    expect(params).toEqual(['tx-1', 'manual', 'qa-seed-email-manual-attach-1']);
  });

  it('rejects an invalid link_source (only auto|manual|scan exist in the schema CHECK)', () => {
    expect(() => reader.buildCountQuery({ transactionId: 'tx-1', linkSource: 'bogus' })).toThrow(
      /link-source must be one of/i,
    );
    expect([...reader.VALID_SOURCES].sort()).toEqual(['auto', 'manual', 'scan']);
  });

  it('parseArgs reads --link-source and --email-id', () => {
    const opts = reader.parseArgs([
      '--db', '/x/mad.db',
      '--key', 'abc',
      '--transaction-id', 'tx-1',
      '--link-source', 'manual',
      '--email-id', 'e-1',
    ]);
    expect(opts).toMatchObject({
      db: '/x/mad.db',
      key: 'abc',
      transactionId: 'tx-1',
      linkSource: 'manual',
      emailId: 'e-1',
    });
  });
});
