'use strict';
/**
 * QA Harness — DISTINCT linked-email COUNT for a transaction, FILTERED BY link_source (BACKLOG-1979).
 *
 * Sibling of count-linked.js (which counts links regardless of source). This reader adds a
 * `--link-source <auto|manual|scan>` filter so the manual-attach cell can assert that the app wrote a
 * communications row with EXACTLY link_source='manual' — the ground truth that the MANUAL attach flow
 * (transactions:link-emails → createCommunication({ link_source: 'manual' })) really ran, not an
 * auto-link. It also OPTIONALLY scopes to a single --email-id so the cell can prove that ONE specific
 * seeded email became manually linked (BACKLOG-1875 verify-by-observing).
 *
 * count-linked.js is left byte-identical (the BACKLOG-1950 filter-toggle cell depends on it); this is a
 * NEW, additive reader.
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-linked-by-source.js \
 *     --db <path/mad.db> --key <hex> --transaction-id <id> [--link-source manual] [--email-id <id>]
 *
 * EMITS a single sentinel-prefixed JSON line on stdout: { n } (the DISTINCT matching linked-email
 * count) or { error }.
 *
 * EXIT CODES: 0 = counted · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_LINKED_BY_SOURCE__ ';

/** Only these link_source values exist in the schema CHECK constraint. */
const VALID_SOURCES = new Set(['auto', 'manual', 'scan']);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--transaction-id') opts.transactionId = argv[++i];
    else if (a === '--link-source') opts.linkSource = argv[++i];
    else if (a === '--email-id') opts.emailId = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

/**
 * Build the COUNT(DISTINCT email_id) query + params from the parsed opts. Pure (no DB) so it is
 * unit-testable under plain-node jest without the cipher module. Throws on invalid usage.
 */
function buildCountQuery(opts) {
  if (!opts.transactionId) throw new Error('count-linked-by-source requires --transaction-id <id>.');
  if (opts.linkSource !== undefined && !VALID_SOURCES.has(opts.linkSource)) {
    throw new Error(
      `count-linked-by-source: --link-source must be one of ${[...VALID_SOURCES].join('|')} (got "${opts.linkSource}").`,
    );
  }
  const clauses = ['transaction_id = ?', 'email_id IS NOT NULL'];
  const params = [opts.transactionId];
  if (opts.linkSource !== undefined) {
    clauses.push('link_source = ?');
    params.push(opts.linkSource);
  }
  if (opts.emailId !== undefined) {
    clauses.push('email_id = ?');
    params.push(opts.emailId);
  }
  const sql = `SELECT COUNT(DISTINCT email_id) AS n FROM communications WHERE ${clauses.join(' AND ')}`;
  return { sql, params };
}

function countLinkedBySource(opts) {
  if (!opts.db) throw new Error('count-linked-by-source requires --db <path>.');
  if (!opts.key) throw new Error('count-linked-by-source requires --key <hex>.');
  const { sql, params } = buildCountQuery(opts);
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const row = db.prepare(sql).get(...params);
    return row.n;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      'count-linked-by-source: count DISTINCT linked emails for a transaction, filtered by link_source. See header.\n',
    );
    process.exit(0);
    return;
  }
  try {
    const n = countLinkedBySource(opts);
    process.stdout.write(SENTINEL + JSON.stringify({ n }) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-linked-by-source error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, buildCountQuery, VALID_SOURCES, SENTINEL };
