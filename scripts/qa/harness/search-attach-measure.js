'use strict';
/**
 * QA Harness — SEARCH + ATTACH determinism MEASUREMENT shell (BACKLOG-1853 / QA-H6).
 *
 * Standalone plain-node/Electron-MAIN script. Opens the app's OWN encrypted
 * SQLite DB read-only (app cipher module + key from the OS keychain or env),
 * replays the app's search / participant / thread / tombstone SQL to MEASURE:
 *   - the result set of each configured search query (normalized AND raw, so the
 *     whitespace-prefix regression is observable) — BACKLOG-1550/1841;
 *   - thread grouping by emails.thread_id (BACKLOG-1721 reply chains);
 *   - the whole-thread expansion + effective linked set for the resolved
 *     transaction (whole-thread attach guarantee);
 *   - the ghost/resurrection scan (emails ⋈ email_tombstones) — BACKLOG-1764.
 *
 * It does NOT diff or produce a verdict: the set-IDENTITY semantics (MULTISET
 * diff, exact-count eval) live in H1's diff.ts and are applied by
 * search-attach-asserter.ts, which spawns this shell.
 *
 * This shell mirrors db-assert.js (BACKLOG-1850): same cipher pragmas, same
 * source-timezone date handling, same corpus-user scoping, same robust
 * sentinel-prefixed `--out` JSON channel with an uncaught-error trap so a crash
 * can never masquerade as "no measurement". Reuses db-assert's exported helpers
 * (pickCorpusUser / SENTINEL / DEFAULT_TZ / findRepoRoot / expandHome).
 *
 * USAGE (plain node, key in env — sub-second, no GUI Electron):
 *   node scripts/qa/harness/search-attach-measure.js --scenario <path> --json
 * PROVISION the key once (foreground): eval "$(npm run --silent qa:db-key -- --print-export)"
 *
 * OPTIONS: --scenario <path> --db <path> --key <hex> --transaction-id <id>
 *          --user-id <id> --out <path> --json --help
 * EXIT CODES: 0 = measured · 2 = usage / IO / decrypt / uncaught error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./search-attach-core');
const dbAssert = require('./db-assert'); // pickCorpusUser, SENTINEL, DEFAULT_TZ, findRepoRoot, expandHome

const SENTINEL = '__QA_SEARCHATTACH_JSON__ ';
const DEFAULT_TZ = dbAssert.DEFAULT_TZ; // America/Los_Angeles

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

const expandHome = dbAssert.expandHome;
const findRepoRoot = dbAssert.findRepoRoot;

// ---------------------------------------------------------------------------
// Scenario (raw JSON — reads the searchQueries block consumed outside H1's zod,
// exactly as db-assert reads scenario.sourceTimezone raw)
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
// Key retrieval + DB open — replicate databaseEncryptionService + app pragmas
// (copied verbatim from db-assert.js; H3 keeps these private, so H6 mirrors them
// to stay independent of H3 internals. Any pragma change must track db-assert.)
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

function defaultUserDataPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Keepr');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Keepr');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Keepr');
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function runAll(db, builder) {
  const { sql, params } = builder;
  return db.prepare(sql).all(...params);
}

/** Members (subject, shiftedDate) for a rowset, in source-local dates. */
function toMembers(rows, tz) {
  return rows.map((r) => core.rowToMember(r, tz));
}

/**
 * Measure one configured search query. Emits the NORMALIZED result and, when a
 * whitespace variant is configured, the RAW result too (so the asserter can
 * check whitespace-prefix robustness — BACKLOG-1550/1841).
 */
function measureQuery(db, q, contacts, corpusUser, tz) {
  const kind = q.kind;
  const out = { id: q.id, kind, query: q.query, role: q.role || null };

  const build = (query, opts) => {
    if (kind === 'contact' || kind === 'participant') {
      return core.buildParticipantSearchQuery({ addresses: [query], role: q.role || null, userId: corpusUser });
    }
    if (kind === 'bcc') {
      return core.buildParticipantSearchQuery({ addresses: [query], role: 'bcc', userId: corpusUser });
    }
    if (kind === 'subject') {
      return core.buildSubjectSearchQuery({ term: query, userId: corpusUser, normalize: opts.normalize });
    }
    // 'freetext' (and default)
    return core.buildLocalSearchQuery({ query, userId: corpusUser, normalize: opts.normalize });
  };

  out.normalized = toMembers(runAll(db, build(q.query, { normalize: true })), tz);
  if (q.whitespaceVariant !== null && q.whitespaceVariant !== undefined) {
    // Raw (unnormalized) run of the whitespace-prefixed variant.
    out.rawWhitespace = toMembers(runAll(db, build(q.whitespaceVariant, { normalize: false })), tz);
    // Normalized run of the same variant — MUST equal `normalized`.
    out.normalizedWhitespace = toMembers(runAll(db, build(q.whitespaceVariant, { normalize: true })), tz);
  }
  // For a BCC query, also measure (a) the free-text (sender-only) result and
  // (b) the non-BCC-role reachability of the same address, so the asserter can
  // prove the non-leak invariant: an email reachable ONLY as BCC must NOT be
  // returned by free-text search (which scans From/subject/body, not participants).
  if (kind === 'bcc') {
    out.freetext = toMembers(runAll(db, core.buildLocalSearchQuery({ query: q.query, userId: corpusUser })), tz);
    out.nonBccRoles = toMembers(
      runAll(db, core.buildParticipantSearchQuery({ addresses: [q.query], roles: ['from', 'to', 'cc'], userId: corpusUser })),
      tz,
    );
  }
  return out;
}

/** Per-role participant counts for the contact set (drives the data-driven BCC cell). */
function measureRoleCounts(db, contacts, corpusUser, tz) {
  const roles = ['from', 'to', 'cc', 'bcc'];
  const byRole = {};
  for (const role of roles) {
    const rows = runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, role, userId: corpusUser }));
    byRole[role] = toMembers(rows, tz);
  }
  return byRole;
}

function measureThreads(db, corpusUser, tz) {
  const rows = runAll(db, core.buildThreadGroupingQuery({ userId: corpusUser }));
  const grouped = core.groupByThread(rows);
  const groups = {};
  for (const [tid, members] of grouped) {
    groups[tid] = members.map((r) => core.rowToMember(r, tz));
  }
  return { threadCount: grouped.size, groups };
}

/** Resolve the transaction owning the most participant-matched emails (like H3). */
function resolveTransactionId(db, contacts, corpusUser, explicit) {
  if (explicit) return explicit;
  const offRows = runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, userId: corpusUser }));
  const ids = offRows.map((r) => r.id);
  if (ids.length === 0) return null;
  const inClause = ids.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT c.transaction_id AS tid, COUNT(*) AS n
         FROM communications c
        WHERE c.email_id IN (${inClause}) AND c.transaction_id IS NOT NULL
        GROUP BY c.transaction_id ORDER BY n DESC LIMIT 1`,
    )
    .get(...ids);
  return row ? row.tid : null;
}

/**
 * Measure the effective linked set for the transaction (whole-thread attach
 * guarantee + single-link exactness). Reads the raw communications rows and
 * replays the app's expansion (direct email_id links + thread_id expansion).
 */
function measureLinked(db, transactionId, corpusUser, tz) {
  if (!transactionId) return { transactionId: null };
  const commRows = runAll(db, core.buildTransactionLinksQuery({ transactionId }));
  const directIds = commRows
    .filter((c) => c.email_id !== null && c.email_id !== undefined && String(c.email_id) !== '')
    .map((c) => String(c.email_id));
  const threadRows = commRows.filter((c) => (c.email_id === null || c.email_id === undefined || String(c.email_id) === '') && c.thread_id);
  const threadIds = threadRows.map((c) => String(c.thread_id));

  // All corpus emails for this user (id + thread_id + subject + sent_at) to expand thread links.
  const allEmailRows = db.prepare(
    corpusUser
      ? 'SELECT id, thread_id, subject, sent_at FROM emails WHERE user_id = ?'
      : 'SELECT id, thread_id, subject, sent_at FROM emails',
  ).all(...(corpusUser ? [corpusUser] : []));

  const effective = core.expandLinkedEmailIds(commRows, allEmailRows);
  const byId = new Map(allEmailRows.map((e) => [String(e.id), e]));
  const effectiveMembers = [...effective]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((e) => core.rowToMember(e, tz));

  return {
    transactionId,
    directCount: directIds.length,
    threadRowCount: threadIds.length,
    effectiveCount: effective.size,
    effectiveMembers,
    // For each thread link, the measured member set (whole-thread expansion).
    threadExpansions: threadIds.map((tid) => ({
      threadId: tid,
      members: allEmailRows.filter((e) => String(e.thread_id) === tid).map((e) => core.rowToMember(e, tz)),
    })),
  };
}

function measureGhosts(db, corpusUser, tz) {
  const rows = runAll(db, core.buildGhostScanQuery({ userId: corpusUser }));
  const tombCount = corpusUser
    ? db.prepare('SELECT COUNT(*) AS n FROM email_tombstones WHERE user_id = ?').get(corpusUser).n
    : db.prepare('SELECT COUNT(*) AS n FROM email_tombstones').get().n;
  return { tombstoneCount: tombCount, resurrections: rows.map((r) => core.rowToMember(r, tz)) };
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

    // Scope to the corpus user (the user owning the most participant matches).
    const offRowsAll = runAll(db, core.buildParticipantSearchQuery({ addresses: contacts }));
    const { userId: corpusUser, note: userNote } = dbAssert.pickCorpusUser(offRowsAll, opts.userId);

    const corpus = corpusUser
      ? db.prepare('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?').get(corpusUser).n
      : db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;

    const cfg = scenario.searchQueries || {};
    const queries = Array.isArray(cfg.queries) ? cfg.queries : [];
    const measuredQueries = queries.map((q) => measureQuery(db, q, contacts, corpusUser, timeZone));

    const roleCounts = measureRoleCounts(db, contacts, corpusUser, timeZone);
    const threads = measureThreads(db, corpusUser, timeZone);
    const transactionId = resolveTransactionId(db, contacts, corpusUser, opts.transactionId || cfg.transactionId);
    const linked = measureLinked(db, transactionId, corpusUser, timeZone);
    const ghosts = measureGhosts(db, corpusUser, timeZone);

    return {
      measurement: {
        stage: 'search-attach-measure',
        corpus,
        queries: measuredQueries,
        roleCounts,
        threads,
        linked,
        ghosts,
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
// Output channel (robust: --out file + sentinel stdout line + error trap)
// ---------------------------------------------------------------------------

function emitResult(opts, obj) {
  const line = SENTINEL + JSON.stringify(obj);
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, JSON.stringify(obj));
    } catch (e) {
      process.stderr.write(`search-attach-measure: failed to write --out ${opts.out}: ${e.message}\n`);
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

  const fail = (err) => {
    const msg = err && err.message ? err.message : String(err);
    try {
      emitResult(opts, { stage: 'search-attach-measure', error: msg });
    } catch (_) { /* last resort */ }
    process.stderr.write(`\n  ✗ search-attach-measure error: ${msg}\n`);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  const report = (measurement, meta) => {
    if (opts.json || opts.out) {
      emitResult(opts, { ...measurement, meta });
    } else {
      const q = measurement.queries || [];
      process.stdout.write(
        [
          `scenario : ${meta.scenarioId}  (${meta.scenarioPath})`,
          `db       : ${meta.dbPath}  [${meta.openMode}]`,
          `key      : ${meta.keySource}`,
          `tz       : ${meta.timeZone}`,
          `user     : ${meta.userNote}`,
          '',
          'MEASUREMENT (no verdict — run qa:search-attach for PASS/FAIL):',
          `  corpus      : ${measurement.corpus}`,
          `  queries     : ${q.length} measured`,
          ...q.map((x) => `    - ${x.id} (${x.kind}): ${x.normalized.length} result(s)`),
          `  threads     : ${measurement.threads.threadCount} group(s)`,
          `  linked      : ${measurement.linked.transactionId ? measurement.linked.effectiveCount + ' effective (txn ' + measurement.linked.transactionId + ')' : '(no transaction resolved)'}`,
          `  tombstones  : ${measurement.ghosts.tombstoneCount}  · resurrections: ${measurement.ghosts.resurrections.length}`,
          '',
        ].join('\n'),
      );
    }
  };

  // NODE MODE (key in env/flag) — no keychain, no Electron app.
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

  // ELECTRON MODE — key from the OS keychain (foreground safeStorage).
  const { app } = require('electron');
  app.setName('keepr');
  app.whenReady().then(() => {
    try {
      try { app.focus({ steal: true }); } catch (_) { /* best-effort */ }
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
  loadScenario,
  measureQuery,
  measureRoleCounts,
  measureThreads,
  measureLinked,
  measureGhosts,
  toMembers,
  SENTINEL,
  DEFAULT_TZ,
};
