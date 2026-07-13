'use strict';
/**
 * QA Harness — READ the ignored_communications TOMBSTONES for a transaction (BACKLOG-1982).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads every `ignored_communications` row for a transaction — the ground truth of what
 * the app REALLY suppressed when unlinkCommunication wrote a tombstone before hard-deleting each
 * communications LINK row (BACKLOG-1875 verify-by-OBSERVING). Emits a single sentinel-prefixed JSON
 * line on stdout: `{ rows: [{ id, email_id, thread_id, original_communication_id }], count }`.
 *
 * WHY ROWS, NOT A DISTINCT-EMAIL COUNT (SR note): the delete-emails cell asserts the EXACT set of
 * tombstones written by a thread-expanding unlink (e.g. a 2-email thread writes 2 tombstones). We
 * therefore return the ROWS (their email_ids/thread_ids), not COUNT(DISTINCT email_id) — a distinct
 * count could mask an under- or over-expansion. The cell asserts sets, and `count` is the raw row
 * count for convenience.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-ignored.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_IGNORED_COMMS__ ';

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

function readIgnored(opts) {
  if (!opts.db) throw new Error('count-ignored requires --db <path>.');
  if (!opts.key) throw new Error('count-ignored requires --key <hex>.');
  if (!opts.transactionId) throw new Error('count-ignored requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const rows = db
      .prepare(
        `SELECT id, email_id, thread_id, original_communication_id, email_subject
           FROM ignored_communications
          WHERE transaction_id = ?
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
    process.stdout.write('count-ignored: read ignored_communications tombstones for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const rows = readIgnored(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ rows, count: rows.length }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-ignored error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
