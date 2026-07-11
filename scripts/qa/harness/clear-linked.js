'use strict';
/**
 * QA Harness — CLEAR all linked emails for a transaction (BACKLOG-1950).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB with an explicit `--key` and
 * DELETEs every communications row that links an email to a transaction — returning the DB to a
 * genuine 0-linked "clean slate" so the address-filter toggle can be OBSERVED as the SOLE cause of
 * the subsequent links.
 *
 * WHY THIS EXISTS (BACKLOG-1950 re-runnability fix): the app AUTO-LINKS ON OPEN (BACKLOG-1802 founder
 * policy) — opening the transaction fires a background sync/auto-link that links emails based on the
 * seeded skip_address_filter state BEFORE any toggle runs. The runtime cell must therefore reset to
 * 0 AFTER open (once that async on-open auto-link has settled) so the toggle-driven counts are
 * measured from a true clean slate, not confounded by the on-open link.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is Electron-ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/clear-linked.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = cleared · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_CLEAR_LINKED__ ';

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

function clearLinked(opts) {
  if (!opts.db) throw new Error('clear-linked requires --db <path>.');
  if (!opts.key) throw new Error('clear-linked requires --key <hex>.');
  if (!opts.transactionId) throw new Error('clear-linked requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    // Delete only email links for THIS transaction (leave text/message links + other tx untouched).
    const info = db
      .prepare('DELETE FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL')
      .run(opts.transactionId);
    const remaining = db
      .prepare(
        'SELECT COUNT(DISTINCT email_id) AS n FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL',
      )
      .get(opts.transactionId).n;
    return { deleted: info.changes, remaining };
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('clear-linked: delete all email links for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const res = clearLinked(opts);
    process.stdout.write(SENTINEL + JSON.stringify(res) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x clear-linked error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
