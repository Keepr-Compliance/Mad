'use strict';
/**
 * QA Harness — DISTINCT linked-email COUNT for a transaction (BACKLOG-1950).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and COUNTS the DISTINCT emails linked to a transaction via the communications table — the
 * ground truth of what the app REALLY linked after the address-filter toggle drove auto-link
 * (BACKLOG-1875 verify-by-observing). Emits a single sentinel-prefixed JSON line on stdout.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-linked.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = counted · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_LINKED_COUNT__ ';

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

function countLinked(opts) {
  if (!opts.db) throw new Error('count-linked requires --db <path>.');
  if (!opts.key) throw new Error('count-linked requires --key <hex>.');
  if (!opts.transactionId) throw new Error('count-linked requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT email_id) AS n
           FROM communications
          WHERE transaction_id = ? AND email_id IS NOT NULL`,
      )
      .get(opts.transactionId);
    return row.n;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('count-linked: count DISTINCT linked emails for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const n = countLinked(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ n }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-linked error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
