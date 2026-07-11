'use strict';
/**
 * QA Harness — READ the assigned contact ROLES for a transaction (BACKLOG-1949).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads every `transaction_contacts` row for a transaction — the ground truth of which
 * contacts the app REALLY assigned and WITH WHICH ROLE after the "add users with roles" UI flow drove
 * batchUpdateContacts (BACKLOG-1875 verify-by-OBSERVING). Emits a single sentinel-prefixed JSON line
 * on stdout: `{ rows: [{ contact_id, role, role_category, specific_role, is_primary }] }`.
 *
 * The add path keeps `role` and `specific_role` in sync and derives `role_category` from
 * ROLE_TO_CATEGORY (see EditContactsModal / assignContactToTransaction), so the cell asserts the FULL
 * triple {role, role_category, specific_role} per contact — a category-mapping regression is a FAIL.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-contact-roles.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_CONTACT_ROLES__ ';

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

function readContactRoles(opts) {
  if (!opts.db) throw new Error('count-contact-roles requires --db <path>.');
  if (!opts.key) throw new Error('count-contact-roles requires --key <hex>.');
  if (!opts.transactionId) throw new Error('count-contact-roles requires --transaction-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const rows = db
      .prepare(
        `SELECT contact_id, role, role_category, specific_role, is_primary
           FROM transaction_contacts
          WHERE transaction_id = ?
          ORDER BY contact_id`,
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
    process.stdout.write('count-contact-roles: read assigned contact roles for a transaction. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const rows = readContactRoles(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ rows }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-contact-roles error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
