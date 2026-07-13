'use strict';
/**
 * QA Harness — READ id SETS from the encrypted DB for the delete-transactions cell (BACKLOG-1981).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads the SET of row ids for one of a small allow-list of tables — the ground truth of
 * what the app REALLY has after a delete (BACKLOG-1875 verify-by-OBSERVING). Emits a single, table-
 * specific sentinel-prefixed JSON line on stdout: `{ rows: [{ id }], count }`.
 *
 * WHY IDENTITY (id sets), not a scalar count (SR note): the delete-transactions cell asserts the EXACT
 * set of transactions remaining after a single/bulk delete, AND that the CASCADE removed exactly the
 * child transaction_contacts + communications link rows while the underlying emails/contacts ROWS
 * survived. A count could hide the WRONG row being deleted; ids pin the identity on both sides of the
 * cascade. So this reader returns ROW IDS, not a scalar.
 *
 * SCOPING:
 *   --table transactions|transaction_contacts|communications|emails|contacts   (required, allow-listed)
 *   --user-id <id>        scope transactions/emails/contacts to a user (their user_id column)
 *   --transaction-id <id> scope transaction_contacts/communications to a transaction
 * The table name is validated against a fixed allow-list (never interpolated from arbitrary input),
 * and every value is passed as a BOUND parameter — no SQL is built from caller data.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/read-transactions.js \
 *     --db <path/mad.db> --key <hex> --table transactions --user-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

/** Per-table sentinel so a caller can never confuse one table's output for another's. */
const SENTINELS = {
  transactions: '__QA_TX_IDS__ ',
  transaction_contacts: '__QA_TXC_IDS__ ',
  communications: '__QA_COMM_IDS__ ',
  emails: '__QA_EMAIL_IDS__ ',
  contacts: '__QA_CONTACT_IDS__ ',
};

/** Allow-listed tables + which optional scope column each supports (bound param — never interpolated). */
const TABLE_SCOPE = {
  transactions: { user: 'user_id' },
  transaction_contacts: { transaction: 'transaction_id' },
  communications: { transaction: 'transaction_id' },
  emails: { user: 'user_id' },
  contacts: { user: 'user_id' },
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--table') opts.table = argv[++i];
    else if (a === '--user-id') opts.userId = argv[++i];
    else if (a === '--transaction-id') opts.transactionId = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

/**
 * Build the WHERE clause + bound params for the id-set read. Pure — no DB — so it is unit-testable.
 * The table is validated by the caller against the allow-list; the scope column comes from the fixed
 * TABLE_SCOPE map (never from caller input), and the value is a bound param.
 */
function buildQuery(opts) {
  const scope = TABLE_SCOPE[opts.table];
  const clauses = [];
  const params = [];
  if (scope.user && opts.userId) {
    clauses.push(`${scope.user} = ?`);
    params.push(opts.userId);
  }
  if (scope.transaction && opts.transactionId) {
    clauses.push(`${scope.transaction} = ?`);
    params.push(opts.transactionId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

function readIds(opts) {
  if (!opts.db) throw new Error('read-transactions requires --db <path>.');
  if (!opts.key) throw new Error('read-transactions requires --key <hex>.');
  if (!opts.table) throw new Error('read-transactions requires --table <name>.');
  if (!Object.prototype.hasOwnProperty.call(TABLE_SCOPE, opts.table)) {
    throw new Error(`read-transactions: --table "${opts.table}" is not allow-listed (${Object.keys(TABLE_SCOPE).join(', ')}).`);
  }
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const { where, params } = buildQuery(opts);
    // `opts.table` is validated against the fixed allow-list above, so interpolating it here is safe.
    const rows = db.prepare(`SELECT id FROM ${opts.table}${where} ORDER BY id`).all(...params);
    return rows;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('read-transactions: read row-id sets from allow-listed tables. See file header.\n');
    process.exit(0);
    return;
  }
  const sentinel = SENTINELS[opts.table] || '__QA_TX_IDS__ ';
  try {
    const rows = readIds(opts);
    process.stdout.write(sentinel + JSON.stringify({ rows, count: rows.length }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(sentinel + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x read-transactions error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, buildQuery, readIds, SENTINELS, TABLE_SCOPE };
