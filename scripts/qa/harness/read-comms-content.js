'use strict';
/**
 * QA Harness — READ the linked-communication CONTENT rows for a transaction (BACKLOG-1983).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads every EMAIL communication's rendered content (subject + body) for a transaction —
 * the ground truth of WHAT the combined-PDF export renders (BACKLOG-1875 verify-by-OBSERVING). Emits a
 * single sentinel-prefixed JSON line on stdout:
 *   `{ rows: [{ email_id, subject, body_text, sent_at }], count }`
 *
 * WHY THIS QUERY (load-bearing): the export handler (transactions:export-pdf) builds the PDF from
 * `details.communications` = databaseService.getCommunicationsByTransaction =
 * communicationDbService.getCommunicationsWithMessages(txId), which LEFT JOINs the `communications`
 * junction to `emails` and projects `e.subject AS subject`, `e.body_plain AS body_text`. The junction
 * table itself holds NO content (BACKLOG-506 pure junction). We replicate that exact email JOIN here
 * (email links only: c.email_id IS NOT NULL) so the reader's set == what the PDF renders. DISTINCT on
 * email_id guards against a duplicate junction row (e.g. if auto-link re-links an already-seeded id).
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/read-comms-content.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_COMMS_CONTENT__ ';

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

function readCommsContent(opts) {
  if (!opts.db) throw new Error('read-comms-content requires --db <path>.');
  if (!opts.key) throw new Error('read-comms-content requires --key <hex>.');
  if (!opts.transactionId) throw new Error('read-comms-content requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    // Mirror communicationDbService.getCommunicationsWithMessages' EMAIL projection: the PDF renders
    // e.subject and e.body_plain (aliased body_text). DISTINCT collapses a duplicate junction row.
    const rows = db
      .prepare(
        `SELECT DISTINCT c.email_id AS email_id, e.subject AS subject,
                e.body_plain AS body_text, e.sent_at AS sent_at
           FROM communications c
           JOIN emails e ON c.email_id = e.id
          WHERE c.transaction_id = ? AND c.email_id IS NOT NULL
          ORDER BY e.sent_at, c.email_id`,
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
    process.stdout.write('read-comms-content: read linked email subject/body rows for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const rows = readCommsContent(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ rows, count: rows.length }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x read-comms-content error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
