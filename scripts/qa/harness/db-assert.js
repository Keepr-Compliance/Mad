'use strict';
/**
 * QA Harness — encrypted-DB MEASUREMENT shell (BACKLOG-1850 / QA-H3).
 *
 * Standalone Electron-MAIN script. Opens the app's OWN encrypted SQLite DB using
 * the app's OWN cipher module + the key from the OS keychain, replays the app's
 * email_participants junction SQL to MEASURE the filter-OFF / filter-ON / linked
 * sets, and emits them as raw `(subject, shiftedDate)` members.
 *
 * It does NOT parse the canonical checklist, diff, or produce a pass/fail
 * verdict: the set-IDENTITY semantics (MULTISET diff, exact-count eval) live in
 * H1's `diff.ts` / `canonicalList.ts` (BACKLOG-1848) and are applied by the
 * `db-set-diff-asserter.ts` adapter, which spawns this shell.
 *
 * ── LIVE-VALIDATION FIXES (PR #1866, second review) ───────────────────────
 * 1. TIMEZONE (defect 1): dates are derived in the scenario's source timezone
 *    (`sourceTimezone`, default America/Los_Angeles) so the DB's UTC `sent_at`
 *    matches the canonical checklist's local dates. Fixes 4 evening rows that
 *    otherwise land +1 day.
 * 2. CORPUS USER SCOPING (defect 1): the real app DB accumulates multiple
 *    accounts (found a stale 519-email user beside the 190-email tx1 corpus).
 *    We scope corpus + sets to the user that owns the participant-matched
 *    emails, so `corpus` reads 190 not the whole table.
 * 3. ROBUST JSON CHANNEL (defect 2): the measurement is written to `--out`
 *    (a temp file) AND printed as a single sentinel-prefixed stdout line, and
 *    uncaught errors are trapped and reported as `{error}` on the same channel,
 *    so a crash can never masquerade as "no parseable measurement".
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHY ELECTRON: the key is only reachable via Electron `safeStorage` (macOS
 * Keychain) and `better-sqlite3-multiple-ciphers` is built against Electron's
 * ABI. Homebrew `sqlcipher` CANNOT read this DB (confirmed), which is why
 * scripts/qa/email/inspect-local-cache.sh is superseded.
 *
 * KEYCHAIN PROMPT: the first time a foreign binary reads "keepr Safe Storage",
 * macOS shows a one-time authorization prompt — click "Always Allow" once.
 *
 * USAGE:
 *   node_modules/.bin/electron scripts/qa/harness/db-assert.js [--json]
 * For a PASS/FAIL VERDICT run the harness (applies H1's diff):
 *   npm run qa:ceremony -- --scenario tx1-birchwood --live --skip-seed --skip-driver --skip-export
 *
 * OPTIONS: --scenario <path> --db <path> --key <hex> --transaction-id <id>
 *          --user-id <id> --out <path> --json --help
 * EXIT CODES: 0 = measured · 2 = usage / IO / decrypt / uncaught error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./db-set-diff-core');

const SENTINEL = '__QA_DBASSERT_JSON__ ';
const DEFAULT_TZ = 'America/Los_Angeles';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--scenario': opts.scenario = argv[++i]; break;
      case '--db': opts.db = argv[++i]; break;
      case '--key': opts.key = argv[++i]; break;
      case '--transaction-id': opts.transactionId = argv[++i]; break;
      case '--user-id': opts.userId = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      default: break; // ignore Electron flags
    }
  }
  return opts;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

function loadScenario(opts, repoRoot) {
  const explicit = opts.scenario ? expandHome(opts.scenario) : null;
  const defaultPath = path.join(repoRoot, 'docs', 'qa', 'scenarios', 'tx1-birchwood.json');
  const scenarioPath = explicit || defaultPath;
  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`Scenario JSON not found at ${scenarioPath}`);
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  if (!Array.isArray(scenario.contacts) || scenario.contacts.length === 0) {
    throw new Error(`Scenario ${scenarioPath} has no contacts[]`);
  }
  return { scenario, scenarioPath };
}

// ---------------------------------------------------------------------------
// Key retrieval — replicates databaseEncryptionService.getEncryptionKey()
// ---------------------------------------------------------------------------

function getEncryptionKey(opts, userDataPath) {
  const explicit = opts.key || process.env.KEEPR_QA_DB_KEY;
  if (explicit) return { key: explicit.trim(), source: 'explicit (--key/env)' };

  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption (safeStorage) is not available. Pass --key <hex> for a fixture DB.');
  }
  const keyStorePath = path.join(userDataPath, 'db-key-store.json');
  if (!fs.existsSync(keyStorePath)) {
    throw new Error(`Key store not found at ${keyStorePath}. Has the app run on this machine?`);
  }
  const store = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
  if (!store.encryptedKey) throw new Error(`Key store at ${keyStorePath} has no encryptedKey.`);
  const key = safeStorage.decryptString(Buffer.from(store.encryptedKey, 'base64'));
  return { key, source: 'macOS Keychain (safeStorage)' };
}

// ---------------------------------------------------------------------------
// DB open (read-only) — replicates the app's cipher pragmas exactly
// ---------------------------------------------------------------------------

function openDbForRead(dbPath, hexKey) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');
  const configure = (db) => {
    db.pragma(`key = "x'${hexKey}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      configure(db);
      return { db, mode: 'readonly' };
    } catch (inner) {
      db.close();
      throw inner;
    }
  } catch (e) {
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      configure(db);
      return { db, mode: 'query_only (readonly fallback)' };
    } catch (e2) {
      db.close();
      throw new Error('Failed to decrypt database — encryption key may be invalid.');
    }
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function queryDerived(db, contacts, tokens, userId) {
  const { sql, params } = core.buildDerivedQuery({ contacts, tokens, userId });
  return db.prepare(sql).all(...params); // [{id, user_id, subject, sent_at}]
}

/** The corpus user = the user owning the most participant-matched emails. */
function pickCorpusUser(offRowsAll, override) {
  if (override) return { userId: override, note: `explicit ${override}` };
  const counts = {};
  for (const r of offRowsAll) counts[r.user_id] = (counts[r.user_id] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { userId: null, note: 'no participant matches' };
  const [userId, n] = entries[0];
  const note = entries.length > 1
    ? `auto ${userId} (owns ${n}/${offRowsAll.length}; ${entries.length} users in match set)`
    : `auto ${userId} (single user)`;
  return { userId, note };
}

function resolveLinks(db, offRows, corpusUser, explicitTxnId) {
  let txnId = explicitTxnId || null;
  const ids = offRows.map((r) => r.id);
  if (!txnId && ids.length > 0) {
    const inClause = ids.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT c.transaction_id AS tid, COUNT(*) AS n
           FROM communications c
          WHERE c.email_id IN (${inClause}) AND c.transaction_id IS NOT NULL
          GROUP BY c.transaction_id ORDER BY n DESC LIMIT 1`,
      )
      .get(...ids);
    txnId = row ? row.tid : null;
  }
  if (!txnId) return { txnId: null, linked: null };
  const linked = db
    .prepare(
      `SELECT e.subject AS subject, e.sent_at AS sent_at, c.link_source AS link_source
         FROM communications c JOIN emails e ON e.id = c.email_id
        WHERE c.transaction_id = ? AND c.email_id IS NOT NULL`,
    )
    .all(txnId);
  return { txnId, linked };
}

/** Replicate Electron `app.getPath('userData')` for app name "Keepr" (node mode). */
function defaultUserDataPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Keepr');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Keepr');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Keepr');
}

function runMeasurement(opts, userDataPath) {
  const repoRoot = findRepoRoot(__dirname);
  const { scenario, scenarioPath } = loadScenario(opts, repoRoot);
  const timeZone = scenario.sourceTimezone || DEFAULT_TZ;

  const dbPath = expandHome(opts.db) || process.env.KEEPR_QA_DB || (userDataPath ? path.join(userDataPath, 'mad.db') : null);
  if (!dbPath) throw new Error('No DB path — pass --db or $KEEPR_QA_DB in node mode.');
  if (!fs.existsSync(dbPath)) throw new Error(`Encrypted DB not found at ${dbPath}`);

  const { key, source: keySource } = getEncryptionKey(opts, userDataPath);
  const { db, mode: openMode } = openDbForRead(dbPath, key);

  try {
    const contacts = scenario.contacts;
    const tokens = (scenario.transaction && scenario.transaction.normalizedTokens) || [];

    // Participant match across ALL users, then scope to the corpus user.
    const offRowsAll = queryDerived(db, contacts, [], null);
    const { userId: corpusUser, note: userNote } = pickCorpusUser(offRowsAll, opts.userId);

    const offRows = corpusUser ? offRowsAll.filter((r) => r.user_id === corpusUser) : offRowsAll;
    const onRows = queryDerived(db, contacts, tokens, corpusUser);

    const corpus = corpusUser
      ? db.prepare('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?').get(corpusUser).n
      : db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;

    // Raw member lists (NO dedupe) with source-local dates.
    const filterOff = offRows.map((r) => core.rowToMember(r, timeZone));
    const filterOn = onRows.map((r) => core.rowToMember(r, timeZone));

    const { txnId, linked } = resolveLinks(db, offRows, corpusUser, opts.transactionId);
    const linkedMembers = Array.isArray(linked)
      ? linked.map((r) => ({
          subject: (r.subject == null ? '' : String(r.subject)).trim(),
          shiftedDate: core.shiftedDateOf(r.sent_at, timeZone),
          linkSource: r.link_source == null ? null : String(r.link_source),
        }))
      : null;

    return {
      measurement: {
        stage: 'assert-db-measure',
        corpus,
        filterOff,
        filterOn,
        linked: linkedMembers,
        transactionId: txnId,
      },
      meta: {
        scenarioId: scenario.id || '(unknown)',
        scenarioPath, dbPath, openMode, keySource, timeZone,
        corpusUser, userNote,
      },
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Output channel
// ---------------------------------------------------------------------------

/** Write the result to --out (if any) and print one sentinel-prefixed line. */
function emitResult(opts, obj) {
  const line = SENTINEL + JSON.stringify(obj);
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, JSON.stringify(obj));
    } catch (e) {
      process.stderr.write(`db-assert: failed to write --out ${opts.out}: ${e.message}\n`);
    }
  }
  process.stdout.write(line + '\n');
}

function printHelp() {
  const banner = [];
  for (const line of fs.readFileSync(__filename, 'utf8').split('\n')) {
    if (line.startsWith("'use strict'")) continue;
    if (line.startsWith('/**') || line.startsWith(' *') || line.startsWith(' */')) {
      banner.push(line.replace(/^\s?\*\/?/, '').replace(/^\/\*\*/, '').trimEnd());
    } else if (banner.length) break;
  }
  process.stdout.write(banner.join('\n').trim() + '\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
    return;
  }

  // DEFECT 2: trap ANY uncaught error and report it on the same channel so the
  // adapter surfaces a real error instead of "no parseable measurement".
  const fail = (err) => {
    const msg = err && err.message ? err.message : String(err);
    try {
      emitResult(opts, { stage: 'assert-db-measure', error: msg });
    } catch (_) { /* last resort */ }
    process.stderr.write(`\n  ✗ db-assert error: ${msg}\n`);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  const report = (measurement, meta) => {
    if (opts.json || opts.out) {
      emitResult(opts, { ...measurement, meta });
    } else {
      process.stdout.write(
        [
          `scenario : ${meta.scenarioId}  (${meta.scenarioPath})`,
          `db       : ${meta.dbPath}  [${meta.openMode}]`,
          `key      : ${meta.keySource}`,
          `tz       : ${meta.timeZone}`,
          `user     : ${meta.userNote}`,
          `txn      : ${measurement.transactionId || '(none resolved — link/ghost checks skipped)'}`,
          '',
          'MEASUREMENT (no verdict — run qa:ceremony --live --skip-seed --skip-driver --skip-export for PASS/FAIL):',
          `  corpus     : ${measurement.corpus}`,
          `  filter-OFF : ${measurement.filterOff.length}`,
          `  filter-ON  : ${measurement.filterOn.length}`,
          `  linked     : ${measurement.linked ? measurement.linked.length : '(none)'}`,
          '',
        ].join('\n'),
      );
    }
  };

  // NODE MODE: with an explicit key we need no keychain, so no Electron `app`.
  // Runs cleanly under ELECTRON_RUN_AS_NODE (or plain node w/ a node-ABI module)
  // and exits promptly — no GUI-electron helper processes to hang on.
  if (opts.key || process.env.KEEPR_QA_DB_KEY) {
    try {
      const { measurement, meta } = runMeasurement(opts, defaultUserDataPath());
      report(measurement, meta);
      process.exit(0);
    } catch (err) {
      fail(err);
    }
    return;
  }

  // ELECTRON MODE: the key lives in the OS keychain → need safeStorage + app.
  // NOTE: the FIRST keychain read for this binary needs interactive approval,
  // which is unreliable for a spawned (non-foreground) child. Provision once via
  // `npm run qa:db-key` (foreground); thereafter this read is silent. The adapter
  // bounds this call with a short timeout so an unprovisioned run fails fast with
  // an actionable {error} rather than hanging.
  const { app } = require('electron');
  app.setName('keepr'); // MUST match the app's lowercase name so safeStorage
  // resolves the real "keepr Safe Storage" keychain item (not a bogus "Keepr" one).
  app.whenReady().then(() => {
    try {
      try { app.focus({ steal: true }); } catch (_) { /* best-effort foreground */ }
      const { measurement, meta } = runMeasurement(opts, app.getPath('userData'));
      report(measurement, meta);
      app.quit();
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  expandHome,
  findRepoRoot,
  loadScenario,
  pickCorpusUser,
  SENTINEL,
  DEFAULT_TZ,
};
