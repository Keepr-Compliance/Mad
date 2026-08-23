/**
 * Unit proofs for the CREATE-AUDIT DB reader's PURE parts (BACKLOG-1948).
 *
 * The reader (count-transactions.js) opens the encrypted DB under Electron's ABI, so the DB path is
 * NOT exercised here. But its ARGUMENT parsing, its WHERE/param builder, and its LIKE escaping are
 * pure and load-bearing (a wrong query would silently mis-count the created transaction), so they are
 * proven here — pure Node, no Electron, no DB. Runs under jest.qa.config.js.
 *
 * BACKLOG-2782: was `.test.js`. tsconfig.json is allowJs:true / checkJs:false, so tsc LOADED this
 * file and reported NOTHING about it — `npm run type-check:tests` (local AND CI) was blind to a
 * literal `const n: number = 'str'` here. The rename is the whole fix; assertions are untouched.
 *
 * The subject module is still CommonJS `.js`, so it is pulled in with `require(...) as {...}` —
 * the pattern already used by count-linked-by-source.test.ts in this directory. The shapes below
 * are transcribed from ../count-transactions.js (parseArgs/buildQuery/escapeLike, exports at :111),
 * not invented.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseArgs, buildQuery, escapeLike, SENTINEL } = require('../count-transactions.js') as {
  parseArgs: (argv: string[]) => {
    db?: string;
    key?: string;
    address?: string;
    startedAt?: string;
    help?: boolean;
  };
  buildQuery: (opts: { address?: string; startedAt?: string }) => {
    where: string;
    params: string[];
  };
  escapeLike: (s: string) => string;
  SENTINEL: string;
};

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

export {};
