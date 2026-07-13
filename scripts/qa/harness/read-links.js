'use strict';
/**
 * QA Harness — READ the communications LINK ROWS for a transaction (BACKLOG-1982).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads every email `communications` ROW for a transaction — the ground truth of what the
 * app REALLY has linked (BACKLOG-1875 verify-by-OBSERVING). Emits a single sentinel-prefixed JSON line
 * on stdout: `{ rows: [{ id, email_id, thread_id }], count }`.
 *
 * WHY THIS EXISTS ALONGSIDE count-linked.js (SR note): count-linked.js returns COUNT(DISTINCT email_id)
 * — a distinct-EMAIL count, correct for the filter-toggle cell. The delete-emails cell must instead
 * assert the EXACT set of link ROWS removed by a thread-expanding unlink (a 2-email thread = 2 rows),
 * and must confirm each thread's link rows carry a non-NULL thread_id BEFORE deleting (else expansion
 * silently degrades to a 1-row unlink and a "2" assertion would be a false FAIL). So this reader
 * returns the ROWS (id + email_id + thread_id), not a scalar. Email links only (email_id IS NOT NULL);
 * text/thread-only links are excluded.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/read-links.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_EMAIL_LINKS__ ';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--transaction-id') opts.transactionId = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function readLinks(opts) {
  if (!opts.db) throw new Error('read-links requires --db <path>.');
  if (!opts.key) throw new Error('read-links requires --key <hex>.');
  if (!opts.transactionId) throw new Error('read-links requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const rows = db
      .prepare(
        `SELECT id, email_id, thread_id
           FROM communications
          WHERE transaction_id = ? AND email_id IS NOT NULL
          ORDER BY email_id, id`,
      )
      .all(opts.transactionId);
    return rows;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('read-links: read email communications link rows for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const rows = readLinks(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ rows, count: rows.length }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x read-links error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
