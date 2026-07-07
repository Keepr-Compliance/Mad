'use strict';
/**
 * QA Harness — encrypted-DB set-diff asserter (BACKLOG-1850 / QA-H3).
 *
 * Standalone Electron-MAIN script. It opens the app's OWN encrypted SQLite DB
 * using the app's OWN cipher module + the key from the OS keychain, replays the
 * app's email_participants junction SQL to derive the filter-OFF / filter-ON
 * sets, and asserts EXACT corpus-derived counts + set membership by
 * (subject, shifted-date), plus a mechanical ghost scan.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ELECTRON (not plain node):
 *   1. The key lives in the macOS Keychain and is only reachable through
 *      Electron's `safeStorage` (main process). This is the same path the app
 *      uses in databaseEncryptionService.getEncryptionKey().
 *   2. `better-sqlite3-multiple-ciphers` is rebuilt against Electron's ABI, so
 *      it only loads inside Electron — the "app's own cipher module".
 *   Homebrew `sqlcipher` CANNOT read this DB (wrong cipher params), which is
 *   why the old scripts/qa/email/inspect-local-cache.sh path is superseded.
 *
 * KEYCHAIN PROMPT: the first time a DIFFERENT binary (this script under the
 * generic Electron dev binary) reads Keepr's "Keepr Safe Storage" keychain
 * item, macOS shows a one-time authorization prompt. Click "Always Allow"
 * (enter your login password) once per machine. Subsequent runs are silent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * USAGE (run with the app's Electron binary so the native module + safeStorage
 * are available):
 *
 *   node_modules/.bin/electron scripts/qa/harness/db-assert.js [options]
 *
 * OPTIONS
 *   --scenario <path>   Scenario JSON (default: scenarios/tx1-birchwood.json).
 *   --manifest <path>   Canonical checklist markdown (default: from scenario).
 *   --db <path>         Encrypted DB path (default: <userData>/mad.db or
 *                       $KEEPR_QA_DB).
 *   --key <hex>         Provide the raw DB key directly, bypassing the keychain
 *                       (also $KEEPR_QA_DB_KEY). For CI / fixture DBs only.
 *   --transaction-id <id>  Force the transaction whose links are checked.
 *   --user-id <id>      Restrict derivation to one app user (default: single
 *                       user auto-detected from the emails table).
 *   --json              Emit a machine-readable SetDiffResult JSON to stdout.
 *   --help              Show this help.
 *
 * EXIT CODES: 0 = all exact counts hold · 1 = deviation(s) · 2 = usage/IO error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./db-set-diff-core');

// ---------------------------------------------------------------------------
// Arg parsing (tiny, dependency-free)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--scenario': opts.scenario = argv[++i]; break;
      case '--manifest': opts.manifest = argv[++i]; break;
      case '--db': opts.db = argv[++i]; break;
      case '--key': opts.key = argv[++i]; break;
      case '--transaction-id': opts.transactionId = argv[++i]; break;
      case '--user-id': opts.userId = argv[++i]; break;
      default:
        // Ignore Electron's own flags (e.g. the script path, --inspect, etc.)
        break;
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

/** Walk up from a start dir to find the repo root (nearest package.json). */
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
// Scenario + manifest loading
// ---------------------------------------------------------------------------

/** Built-in fallback scenario if no JSON file is present. Matches H1 shape. */
const DEFAULT_SCENARIO = {
  id: 'tx1-birchwood',
  version: 'v2.20.0',
  description: 'TX1 742 Birchwood Lane NE — deterministic email auto-link set',
  source: 'outlook',
  transaction: {
    label: '742 Birchwood Lane NE, Tumwater WA',
    address: '742 Birchwood Lane NE, Tumwater WA',
    normalizedTokens: ['742', 'birchwood', 'lane', 'ne'],
  },
  auditWindow: { start: '2026-02-05', end: '2026-04-14' },
  contacts: [
    'amanda@cascadetitle.com',
    'david.patterson@gmail.com',
    'emily.patt@gmail.com',
    'jennifer@nwpremierrealty.com',
    'kate.mcdonald@cascaderealty.com',
    'lisa.chen@pacificcoastmtg.com',
    'mark.sullivan@pacificcoastmtg.com',
    'rachel@cascadetitle.com',
    'tom@pugetsoundinspections.com',
  ],
  ownAddressExcluded: 'agent@izzyrescue.org',
  dateShiftMonths: 12,
  expectedCounts: { corpus: 190, filterOff: 69, filterOn: 37, missing: 0, extra: 0, ghosts: 0 },
  expectedManifestRef: 'docs/qa/tx1-canonical-list.md',
  setIdentity: 'subject+shifted-date',
};

function loadScenario(opts, repoRoot) {
  const explicit = opts.scenario ? expandHome(opts.scenario) : null;
  const defaultPath = path.join(__dirname, 'scenarios', 'tx1-birchwood.json');
  const scenarioPath = explicit || (fs.existsSync(defaultPath) ? defaultPath : null);
  if (!scenarioPath) {
    return { scenario: DEFAULT_SCENARIO, scenarioPath: '(built-in default)' };
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  return { scenario, scenarioPath };
}

function resolveManifestPath(opts, scenario, scenarioPath, repoRoot) {
  if (opts.manifest) return expandHome(opts.manifest);
  const ref = scenario.expectedManifestRef;
  if (!ref) return path.join(repoRoot, 'docs/qa/tx1-canonical-list.md');
  const expanded = expandHome(ref);
  if (path.isAbsolute(expanded)) return expanded;
  // Repo-relative refs (docs/…, scripts/…) resolve from repo root; otherwise
  // resolve relative to the scenario file's directory.
  if (/^(docs|scripts)\//.test(ref) || scenarioPath === '(built-in default)') {
    return path.join(repoRoot, expanded);
  }
  return path.join(path.dirname(scenarioPath), expanded);
}

// ---------------------------------------------------------------------------
// Key retrieval — replicates databaseEncryptionService.getEncryptionKey()
// ---------------------------------------------------------------------------

/**
 * Retrieve the DB key. Precedence:
 *   1. --key / $KEEPR_QA_DB_KEY  (explicit, keychain-free — CI / fixtures)
 *   2. safeStorage decrypt of <userData>/db-key-store.json  (the app's path)
 * @returns {{key: string, source: string}}
 */
function getEncryptionKey(opts, userDataPath) {
  const explicit = opts.key || process.env.KEEPR_QA_DB_KEY;
  if (explicit) return { key: explicit.trim(), source: 'explicit (--key/env)' };

  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS encryption (safeStorage) is not available. Pass --key <hex> for a fixture DB.',
    );
  }
  const keyStorePath = path.join(userDataPath, 'db-key-store.json');
  if (!fs.existsSync(keyStorePath)) {
    throw new Error(`Key store not found at ${keyStorePath}. Has the app run on this machine?`);
  }
  const store = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
  if (!store.encryptedKey) {
    throw new Error(`Key store at ${keyStorePath} has no encryptedKey.`);
  }
  const encrypted = Buffer.from(store.encryptedKey, 'base64');
  // Triggers the one-time macOS keychain authorization prompt for a foreign
  // binary reading "Keepr Safe Storage".
  const key = safeStorage.decryptString(encrypted);
  return { key, source: 'macOS Keychain (safeStorage)' };
}

// ---------------------------------------------------------------------------
// DB open (read-only) — replicates the app's cipher pragmas exactly
// ---------------------------------------------------------------------------

function openDbForRead(dbPath, hexKey) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3-multiple-ciphers');

  // EXACT mirror of the app's cipher pragmas
  // (electron/services/db/core/dbConnection.ts openDatabase()), plus query_only
  // so we can never mutate the DB even on the read-write fallback path.
  const configure = (db) => {
    db.pragma(`key = "x'${hexKey}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    // Verify the key actually decrypts (throws if wrong or if this is a
    // WAL-mode DB a pure-readonly handle cannot open).
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
    // A WAL-mode DB can reject a pure-readonly open (it needs the -shm file).
    // Retry with a read-write handle guarded by query_only=ON: we still issue
    // only SELECTs, so the file is never written.
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
// Data extraction
// ---------------------------------------------------------------------------

function autoDetectUserId(db) {
  const rows = db
    .prepare('SELECT user_id AS uid, COUNT(*) AS n FROM emails GROUP BY user_id ORDER BY n DESC')
    .all();
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    return { userId: rows[0].uid, ambiguous: true, users: rows.length };
  }
  return { userId: rows[0].uid, ambiguous: false, users: 1 };
}

function queryDerived(db, contacts, tokens, userId) {
  const { sql, params } = core.buildDerivedQuery({ contacts, tokens, userId });
  return db.prepare(sql).all(...params); // [{id, subject, sent_at}]
}

function resolveLinks(db, derivedOffRows, explicitTxnId) {
  let txnId = explicitTxnId || null;
  const ids = derivedOffRows.map((r) => r.id);
  if (!txnId && ids.length > 0) {
    const inClause = ids.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT c.transaction_id AS tid, COUNT(*) AS n
           FROM communications c
          WHERE c.email_id IN (${inClause}) AND c.transaction_id IS NOT NULL
          GROUP BY c.transaction_id
          ORDER BY n DESC
          LIMIT 1`,
      )
      .get(...ids);
    txnId = row ? row.tid : null;
  }
  if (!txnId) return { txnId: null, linked: null };
  const linked = db
    .prepare(
      `SELECT e.subject AS subject, e.sent_at AS sent_at, c.link_source AS link_source
         FROM communications c
         JOIN emails e ON e.id = c.email_id
        WHERE c.transaction_id = ? AND c.email_id IS NOT NULL`,
    )
    .all(txnId);
  return { txnId, linked };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function runAssertion(opts) {
  const startedAt = Date.now();
  const { app } = require('electron');
  const repoRoot = findRepoRoot(__dirname);

  const { scenario, scenarioPath } = loadScenario(opts, repoRoot);
  const manifestPath = resolveManifestPath(opts, scenario, scenarioPath, repoRoot);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Canonical manifest not found at ${manifestPath}`);
  }
  const canonical = core.parseCanonicalManifest(fs.readFileSync(manifestPath, 'utf8'));

  const userDataPath = app.getPath('userData');
  const dbPath = expandHome(opts.db) || process.env.KEEPR_QA_DB || path.join(userDataPath, 'mad.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Encrypted DB not found at ${dbPath}`);
  }

  const { key, source: keySource } = getEncryptionKey(opts, userDataPath);
  const { db, mode: openMode } = openDbForRead(dbPath, key);

  try {
    const corpus = db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;

    let userId = opts.userId || null;
    let userNote = userId ? `explicit ${userId}` : null;
    if (!userId) {
      const detected = autoDetectUserId(db);
      if (detected && !detected.ambiguous) {
        userId = detected.userId;
        userNote = `auto ${userId} (single user)`;
      } else if (detected && detected.ambiguous) {
        userId = null; // don't guess across users; derive across all
        userNote = `AMBIGUOUS (${detected.users} users) — no user filter applied`;
      }
    }

    const tokens = scenario.transaction.normalizedTokens || [];
    const offRows = queryDerived(db, scenario.contacts, [], userId);
    const onRows = queryDerived(db, scenario.contacts, tokens, userId);

    const actualOff = core.dedupeMembers(offRows.map(core.rowToMember));
    const actualOn = core.dedupeMembers(onRows.map(core.rowToMember));

    // Ghost window: the canonical set's own [min,max] span is the mechanically
    // derived expected range (avoids false ghosts from an over-narrow scenario
    // window while still catching truly out-of-corpus links).
    const ghostWindow =
      core.canonicalDateSpan(canonical.filterOff) || scenario.auditWindow || { start: '', end: '' };

    const { txnId, linked } = resolveLinks(db, offRows, opts.transactionId);
    let linkedMembers = null;
    let ghosts = [];
    if (Array.isArray(linked)) {
      linkedMembers = linked.map((r) => ({
        subject: (r.subject == null ? '' : String(r.subject)).trim(),
        shiftedDate: core.shiftedDateOf(r.sent_at),
        link_source: r.link_source,
      }));
      ghosts = core.findGhosts(linkedMembers, ghostWindow);
    }

    const verdict = core.evaluate({
      expectedCounts: scenario.expectedCounts,
      canonical,
      actual: {
        corpus,
        filterOff: actualOff,
        filterOn: actualOn,
        linked: linkedMembers, // null when no txn resolved → link check skipped
        ghosts,
      },
    });

    const durationMs = Date.now() - startedAt;
    const detail = `${verdict.summary.filterOff}/${scenario.expectedCounts.filterOff} OFF · ` +
      `${verdict.summary.filterOn}/${scenario.expectedCounts.filterOn} ON · ` +
      `${verdict.summary.missing} missing · ${verdict.summary.extra} extra · ` +
      `${verdict.summary.ghosts} ghosts`;

    // SetDiffResult (BACKLOG-1848 types.ts)
    const setDiffResult = {
      stage: 'assert-db',
      status: verdict.passed ? 'pass' : 'fail',
      durationMs,
      detail,
      deviations: verdict.deviations,
      actual: {
        corpus,
        filterOff: actualOff,
        filterOn: actualOn,
        ghosts,
      },
    };

    return {
      setDiffResult,
      verdict,
      meta: {
        scenarioId: scenario.id,
        scenarioPath,
        manifestPath,
        dbPath,
        openMode,
        keySource,
        userNote,
        transactionId: txnId,
        linkResolved: Array.isArray(linked),
      },
    };
  } finally {
    db.close();
  }
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('\n');
  // Print the leading banner comment (up to the first non-comment line).
  const banner = [];
  for (const line of header) {
    if (line.startsWith("'use strict'")) continue;
    if (line.startsWith('/**') || line.startsWith(' *') || line.startsWith(' */')) {
      banner.push(line.replace(/^\s?\*\/?/, '').replace(/^\/\*\*/, '').trimEnd());
    } else if (banner.length) {
      break;
    }
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
  const { app } = require('electron');
  // CRITICAL: name MUST be "Keepr" so app.getPath('userData') and the
  // safeStorage keychain service both resolve to the packaged app's identity.
  app.setName('Keepr');

  app.whenReady().then(() => {
    let exitCode = 0;
    try {
      const { setDiffResult, verdict, meta } = runAssertion(opts);
      if (opts.json) {
        process.stdout.write(JSON.stringify(setDiffResult) + '\n');
      } else {
        process.stdout.write(
          [
            `scenario : ${meta.scenarioId}  (${meta.scenarioPath})`,
            `manifest : ${meta.manifestPath}`,
            `db       : ${meta.dbPath}  [${meta.openMode}]`,
            `key      : ${meta.keySource}`,
            `user     : ${meta.userNote || '(n/a)'}`,
            `txn      : ${meta.transactionId || '(none resolved — link/ghost checks skipped)'}`,
            '',
            core.formatReport({ scenarioId: meta.scenarioId, ...verdict }),
            '',
          ].join('\n'),
        );
      }
      exitCode = verdict.passed ? 0 : 1;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ stage: 'assert-db', status: 'fail', durationMs: 0, detail: msg, error: msg }) + '\n',
        );
      } else {
        process.stderr.write(`\n  ✗ db-assert error: ${msg}\n`);
      }
      exitCode = 2;
    } finally {
      app.quit();
      // app.quit() is async w.r.t. the event loop; force the exit code.
      process.exit(exitCode);
    }
  });
}

// Only auto-run under Electron. Requiring this file from Jest (to unit-test the
// pure helpers) will NOT boot Electron.
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  expandHome,
  findRepoRoot,
  resolveManifestPath,
  loadScenario,
  DEFAULT_SCENARIO,
};
