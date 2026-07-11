'use strict';
/**
 * QA Harness — EDGE-CASE MEASUREMENT shell (BACKLOG-1854 / QA-H7).
 *
 * Standalone plain-node/Electron-MAIN script. Opens the app's OWN encrypted
 * SQLite DB READ-ONLY (app cipher module + key from the OS keychain or env) and
 * replays the app's participant / ghost SQL to MEASURE the edge-case matrix:
 *   - IDEMPOTENCE (set-stability): replay the derived filter-OFF/ON sets twice
 *     against the same committed DB → identical multisets (a read cannot mutate;
 *     this proves the derivation is stable + counts equal the manifest). TRUE
 *     wipe→reseed→re-ingest idempotence is owned by H4 (BACKLOG-1851)'s seeder;
 *     this shell is READ-only and must never re-seed.
 *   - TIMEZONE +1-day boundary (BACKLOG-1887): the evening rows (Date ≥ 16:00
 *     -0800) land +1 day in UTC sent_at; measured via shiftedDateOf so the
 *     asserter can assert the boundary subjects carry the +1-day shifted date.
 *   - GHOST / resurrection (BACKLOG-1764): emails ⋈ email_tombstones → must be 0.
 *   - SIGNATURE false-positive: an address that appears ONLY in a signature block
 *     must NOT pull that person's unrelated emails into the participant set. We
 *     measure the participant-derived set for the probe address so the asserter
 *     can prove it is bounded to the transaction (never the person's whole mail).
 *
 * It does NOT diff or produce a verdict: the set-IDENTITY semantics (MULTISET
 * diff, exact-count eval) live in H1's diff.ts and are applied by
 * edge-case-asserter.ts, which spawns this shell.
 *
 * Mirrors db-assert.js (BACKLOG-1850) / search-attach-measure.js (BACKLOG-1853):
 * same cipher pragmas (copied LOCALLY — `openDbForRead` is NOT exported by
 * db-assert; any pragma change must track db-assert.js), same source-timezone
 * date handling, same corpus-user scoping, same robust sentinel `--out` JSON
 * channel with an uncaught-error trap. Reuses db-assert's exported helpers
 * (pickCorpusUser / SENTINEL / DEFAULT_TZ / findRepoRoot / expandHome) and
 * search-attach-core's query builders + row helpers (rowToMember / shiftedDateOf
 * reach us TRANSITIVELY via search-attach-core's re-export — we never reach into
 * db-set-diff-core directly).
 *
 * USAGE (plain node, key in env — sub-second, no GUI Electron):
 *   node scripts/qa/harness/edge-case-measure.js --scenario <path> --json
 * PROVISION the key once (foreground): eval "$(npm run --silent qa:db-key -- --print-export)"
 *
 * NODE-ABI NOTE (R3 lesson, BACKLOG-1887): in node mode this loads the node-ABI
 * `better-sqlite3-multiple-ciphers` from `npm install`. If you see a
 * NODE_MODULE_VERSION mismatch, rebuild it: `npm rebuild better-sqlite3-multiple-ciphers`.
 *
 * OPTIONS: --scenario <path> --db <path> --key <hex> --user-id <id>
 *          --out <path> --json --help
 * EXIT CODES: 0 = measured · 2 = usage / IO / decrypt / uncaught error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./search-attach-core'); // buildParticipantSearchQuery, buildGhostScanQuery, rowToMember, shiftedDateOf
const dbAssert = require('./db-assert'); // pickCorpusUser, SENTINEL, DEFAULT_TZ, findRepoRoot, expandHome

const SENTINEL = '__QA_EDGECASE_JSON__ ';
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
// Scenario (raw JSON — reads the edgeCases block outside H1's zod, exactly as
// db-assert reads sourceTimezone and search-attach reads searchQueries raw)
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
// Key retrieval + DB open — replicate databaseEncryptionService + app pragmas.
// Copied LOCALLY from db-assert.js / search-attach-measure.js (db-assert does
// NOT export openDbForRead). Any pragma change MUST track db-assert.js.
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
// Measurement helpers
// ---------------------------------------------------------------------------

function runAll(db, builder) {
  const { sql, params } = builder;
  return db.prepare(sql).all(...params);
}

function toMembers(rows, tz) {
  return rows.map((r) => core.rowToMember(r, tz));
}

/**
 * IDEMPOTENCE (set-stability): derive the participant OFF/ON sets TWICE and
 * return both runs so the asserter can prove they are identical multisets. A
 * read cannot mutate the DB, so this measures derivation determinism, not a
 * re-ingest — true re-ingest idempotence is H4/BACKLOG-1851's seeder.
 */
function measureIdempotence(db, contacts, tokens, corpusUser, tz) {
  const off1 = toMembers(runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, userId: corpusUser })), tz);
  const off2 = toMembers(runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, userId: corpusUser })), tz);
  const on1 = toMembers(runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, tokens, userId: corpusUser })), tz);
  const on2 = toMembers(runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, tokens, userId: corpusUser })), tz);
  return { filterOffRun1: off1, filterOffRun2: off2, filterOnRun1: on1, filterOnRun2: on2 };
}

/**
 * TIMEZONE boundary: for each declared boundary row (subject), find its DB
 * member (subject, shiftedDate) so the asserter can assert the +1-day UTC shift
 * resolves to the expected LOCAL date via shiftedDateOf. We derive from the
 * participant OFF set (the boundary rows are all TX1-linked) so we measure the
 * actual stored sent_at, not a fixture.
 */
function measureTimezoneBoundary(db, contacts, corpusUser, tz, boundarySubjects) {
  const offRows = runAll(db, core.buildParticipantSearchQuery({ addresses: contacts, userId: corpusUser }));
  const bySubject = new Map();
  for (const r of offRows) {
    const subj = (r.subject === null || r.subject === undefined ? '' : String(r.subject)).trim();
    const list = bySubject.get(subj) || [];
    list.push({ subject: subj, shiftedDate: core.shiftedDateOf(r.sent_at, tz), sentAtRaw: String(r.sent_at) });
    bySubject.set(subj, list);
  }
  return (boundarySubjects || []).map((subj) => ({
    subject: subj,
    matches: bySubject.get(String(subj).trim()) || [],
  }));
}

/** GHOST scan (BACKLOG-1764): emails ⋈ email_tombstones → resurrections. */
function measureGhosts(db, corpusUser, tz) {
  const rows = runAll(db, core.buildGhostScanQuery({ userId: corpusUser }));
  const tombCount = corpusUser
    ? db.prepare('SELECT COUNT(*) AS n FROM email_tombstones WHERE user_id = ?').get(corpusUser).n
    : db.prepare('SELECT COUNT(*) AS n FROM email_tombstones').get().n;
  return { tombstoneCount: tombCount, resurrections: rows.map((r) => core.rowToMember(r, tz)) };
}

/**
 * SIGNATURE false-positive: measure the participant-derived set for the probe
 * address. The invariant (checked by the asserter): the probe address, when it
 * is a real transaction contact, links ONLY its transaction emails — it does not
 * additionally surface unrelated mail. We also measure a free-text scan of the
 * probe's raw address string to observe whether a signature mention (body-only)
 * leaks into results. Returns null when no probe is configured.
 */
function measureSignatureProbe(db, probeAddress, corpusUser, tz) {
  if (!probeAddress) return null;
  const participant = toMembers(
    runAll(db, core.buildParticipantSearchQuery({ addresses: [probeAddress], userId: corpusUser })),
    tz,
  );
  // Body/subject/sender free-text hits for the raw address token (a signature
  // block is body text, so this observes body-mention reachability).
  const freetext = toMembers(
    runAll(db, core.buildLocalSearchQuery({ query: probeAddress, userId: corpusUser })),
    tz,
  );
  return { probeAddress, participant, freetext };
}

// ---------------------------------------------------------------------------
// Measurement driver
// ---------------------------------------------------------------------------

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
    const edge = scenario.edgeCases || {};

    // Scope to the corpus user (the user owning the most participant matches).
    const offRowsAll = runAll(db, core.buildParticipantSearchQuery({ addresses: contacts }));
    const { userId: corpusUser, note: userNote } = dbAssert.pickCorpusUser(offRowsAll, opts.userId);

    const corpus = corpusUser
      ? db.prepare('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?').get(corpusUser).n
      : db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;

    const idempotence = measureIdempotence(db, contacts, tokens, corpusUser, timeZone);
    const timezoneBoundary = measureTimezoneBoundary(
      db, contacts, corpusUser, timeZone, (edge.timezoneBoundary || []).map((b) => b.subject),
    );
    const ghosts = measureGhosts(db, corpusUser, timeZone);
    const signature = measureSignatureProbe(db, edge.signatureProbeAddress || null, corpusUser, timeZone);

    return {
      measurement: {
        stage: 'edge-case-measure',
        corpus,
        idempotence,
        timezoneBoundary,
        ghosts,
        signature,
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
      process.stderr.write(`edge-case-measure: failed to write --out ${opts.out}: ${e.message}\n`);
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
      emitResult(opts, { stage: 'edge-case-measure', error: msg });
    } catch (_) { /* last resort */ }
    process.stderr.write(`\n  ✗ edge-case-measure error: ${msg}\n`);
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
          '',
          'MEASUREMENT (no verdict — run qa:edge-cases for PASS/FAIL):',
          `  corpus              : ${measurement.corpus}`,
          `  idempotence OFF/ON  : ${measurement.idempotence.filterOffRun1.length}/${measurement.idempotence.filterOnRun1.length} (run1)`,
          `  tz-boundary rows    : ${measurement.timezoneBoundary.length} probed`,
          `  tombstones          : ${measurement.ghosts.tombstoneCount}  · resurrections: ${measurement.ghosts.resurrections.length}`,
          `  signature probe     : ${measurement.signature ? measurement.signature.participant.length + ' participant hit(s)' : '(none configured)'}`,
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
  measureIdempotence,
  measureTimezoneBoundary,
  measureGhosts,
  measureSignatureProbe,
  toMembers,
  SENTINEL,
  DEFAULT_TZ,
};
