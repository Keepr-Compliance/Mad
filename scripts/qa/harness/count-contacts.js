'use strict';
/**
 * QA Harness — IMPORTED-CONTACT category rows for a user (BACKLOG-1977).
 *
 * Standalone cipher-open helper. Opens the app's encrypted SQLite DB (read-only) with an explicit
 * `--key` and reads the KNOWN category inputs (`source`, `default_role`) for every IMPORTED contact of
 * a user — the DB-side ground truth (verify-by-observing, BACKLOG-1875) for the standalone Contacts
 * module's grouped Source/Role filter. The cell applies the REAL app predicate
 * (src/utils/contactFilterModel.matchesContactFilters) over these rows to derive the per-filter
 * expected counts, and asserts the RENDERED list matches. Emits a single sentinel-prefixed JSON line.
 *
 * WHY IMPORTED-ONLY: the Contacts module lists imported contacts (getImportedContactsByUserId, which
 * scopes `is_imported = 1`) merged with any message-derived senders. The seeded QA corpus is all
 * `is_imported = 1`, so we read exactly that set (message-derived senders come from the messages table
 * and are `is_message_derived = 1`; the fixture seeds none, so the filter oracle is the contacts rows).
 * `is_message_derived` is emitted as 0 for these rows to mirror the imported read path's alias.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-contacts.js \
 *     --db <path/mad.db> --key <hex> --user-id <id>
 *
 * EXIT CODES: 0 = read · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_CONTACTS_ROWS__ ';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--user-id') opts.userId = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function readContacts(opts) {
  if (!opts.db) throw new Error('count-contacts requires --db <path>.');
  if (!opts.key) throw new Error('count-contacts requires --key <hex>.');
  if (!opts.userId) throw new Error('count-contacts requires --user-id <id>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    // Mirror getImportedContactsByUserId's row set: imported contacts for the user, with the same
    // `0 as is_message_derived` alias the imported read path applies. `source` + `default_role` are the
    // two category inputs the filter predicate consumes.
    const rows = db
      .prepare(
        `SELECT id, source, default_role, 0 AS is_message_derived
           FROM contacts
          WHERE user_id = ? AND is_imported = 1
          ORDER BY display_name ASC`,
      )
      .all(opts.userId);
    return rows;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('count-contacts: read imported-contact category rows for a user. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const rows = readContacts(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ rows }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-contacts error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
