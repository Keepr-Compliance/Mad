'use strict';
/**
 * QA Harness — COUNT (and sample) transactions rows by property_address (BACKLOG-1948).
 *
 * Standalone cipher-open helper for the CREATE-AUDIT cell. Opens the app's encrypted SQLite DB
 * (read-only) with an explicit `--key` and COUNTS the transactions rows whose property_address
 * matches the one entered in the New Audit wizard — the ground truth that the wizard REALLY created
 * the transaction (BACKLOG-1875 verify-by-observing). Optionally further constrains by started_at
 * (prefix match on the ISO date the wizard entered) so the assertion is unambiguous even if an
 * identical address existed. Emits a single sentinel-prefixed JSON line on stdout.
 *
 * The DISTINCT-count + a small sample (id/property_address/started_at/status) let the Playwright
 * cell assert EXACTLY-ONE row with the expected address+date (a wrong/missing row is a FAIL; a
 * decrypt/launch failure is a HARNESS_ERROR upstream).
 *
 * ABI: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI, so run this under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT plain node. With `--key` it needs no keychain.
 *
 * USAGE:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/qa/harness/count-transactions.js \
 *     --db <path/mad.db> --key <hex> --address "<property address>" [--started-at <YYYY-MM-DD>]
 *
 * EXIT CODES: 0 = counted · 2 = usage / IO / decrypt / uncaught error.
 */

const SENTINEL = '__QA_TX_COUNT__ ';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--address') opts.address = argv[++i];
    else if (a === '--started-at') opts.startedAt = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

/**
 * Build the WHERE clause + bound params for the transactions lookup. Pure — no DB — so it is
 * unit-testable. Matches property_address exactly; when startedAt is provided, ALSO constrains
 * started_at with a prefix LIKE (the app may store started_at as 'YYYY-MM-DD' or a full ISO
 * timestamp, so we match the leading date, escaping LIKE metacharacters).
 */
function buildQuery(opts) {
  const clauses = ['property_address = ?'];
  const params = [opts.address];
  if (opts.startedAt) {
    clauses.push("started_at LIKE ? ESCAPE '\\'");
    params.push(escapeLike(opts.startedAt) + '%');
  }
  return { where: clauses.join(' AND '), params };
}

/** Escape LIKE metacharacters (%, _, \) so a date prefix can never act as a wildcard. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function countTransactions(opts) {
  if (!opts.db) throw new Error('count-transactions requires --db <path>.');
  if (!opts.key) throw new Error('count-transactions requires --key <hex>.');
  if (!opts.address) throw new Error('count-transactions requires --address <property address>.');
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`key = "x'${opts.key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    const { where, params } = buildQuery(opts);
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).get(...params);
    const sample = db
      .prepare(
        `SELECT id, property_address, started_at, closed_at, status
           FROM transactions WHERE ${where}
          ORDER BY created_at DESC LIMIT 5`,
      )
      .all(...params);
    return { n: countRow.n, sample };
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('count-transactions: count transactions rows by property_address. See file header.\n');
    process.exit(0);
    return;
  }
  try {
    const result = countTransactions(opts);
    process.stdout.write(SENTINEL + JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(SENTINEL + JSON.stringify({ error: msg }) + '\n');
    process.stderr.write(`\n  x count-transactions error: ${msg}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, buildQuery, escapeLike, SENTINEL };
