/**
 * FILTER-TOGGLE exact-count cell — shared core (BACKLOG-1947 / BACKLOG-1950).
 *
 * Reusable, side-effecting helpers shared by BOTH the standalone CLI
 * (filter-toggle-cli.ts) and the Playwright spec (e2e/tests/filter-toggle-counts.spec.ts):
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED DB key for the whole cell (no keychain).
 *   2. measureOracle      — run the H3 db-assert.js against the fixture manifest (node mode,
 *                           with --key) to MEASURE the filter-OFF / filter-ON / linked sets.
 *   3. countLinkedEmails / clearLinkedEmails — OBSERVE / RESET the actual linked email set in the
 *                           encrypted DB (verify-by-observing + clean-slate, BACKLOG-1875/1950).
 *
 * SINGLE-INSTANCE / NO-KEYCHAIN (BACKLOG-1950): the cell sets a FIXED KEEPR_QA_DB_KEY for ALL
 * seeding + DB reads, so (a) the seeder provisions the DB with it (no safeStorage), (b) every reader
 * passes `--key` (no keychain), and (c) there is NO second Electron process to decrypt a per-profile
 * key. The app is launched exactly ONCE per test. (The former emit-profile-key.js helper — a second
 * Electron instance that hit safeStorage per profile — has been removed.)
 *
 * WINDOWLESS-ORACLE INVARIANT: db-assert's buildDerivedQuery omits the sent_at window
 * (deferred to BACKLOG-1887/FU-1). The fixture keeps oracle == runtime by construction —
 * every COUNTED email is inside the window (asserted by the fidelity jest guard). Do NOT
 * reopen that shared-oracle scope here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMeasurement, type Measurement } from './db-set-diff-asserter';

/**
 * The FIXED, keychain-free DB key path (BACKLOG-1971) — PROMOTED into the cell-agnostic shared
 * helper `db-key-fixture.ts` so EVERY cell inherits it. Re-exported here so the existing importers
 * (filter-toggle-cli.ts, e2e/tests/filter-toggle-counts.spec.ts) keep working unchanged; new cells
 * should import FIXTURE_DB_KEY / applyFixtureDbKey from `./db-key-fixture` directly.
 */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

export interface FixtureManifest {
  id: string;
  transaction: { address: string; normalizedTokens: string[] };
  contacts: string[];
  ownAddressExcluded: string;
  sourceTimezone?: string;
  expectedCounts: {
    corpus: number;
    filterOff: number;
    filterOn: number;
    missing: number;
    extra: number;
    ghosts: number;
  };
}

export function loadFixtureManifest(repoRoot: string): { manifest: FixtureManifest; path: string } {
  const p = join(repoRoot, 'docs', 'qa', 'scenarios', 'fixture-filter-counts.json');
  if (!existsSync(p)) throw new Error(`Fixture manifest not found at ${p}`);
  return { manifest: JSON.parse(readFileSync(p, 'utf8')) as FixtureManifest, path: p };
}

/**
 * Run the H3 db-assert.js MEASUREMENT shell against the fixture manifest and return the raw
 * measurement (filterOff/filterOn/linked/corpus). Throws on a launch/decrypt/parse failure
 * (→ HARNESS_ERROR). This is the deterministic ORACLE for OFF/ON counts.
 *
 * ABI NOTE: `better-sqlite3-multiple-ciphers` is built against ELECTRON's ABI (the app rebuilds it),
 * so db-assert.js cannot open the DB under plain node. We run it under `ELECTRON_RUN_AS_NODE=1
 * electron` (Electron's V8 + ABI, but as a headless node process — no GUI). With --key it needs no
 * keychain/app, so it exits promptly with no GUI helpers to hang on.
 */
export function measureOracle(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  scenarioPath: string,
): Measurement {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'db-assert.js');
  const outFile = join(tmpdir(), `qa-filter-toggle-${process.pid}-${Date.now()}.json`);
  const run = spawnSync(
    electronBin,
    [script, '--scenario', scenarioPath, '--db', dbPath, '--key', dbKey, '--json', '--out', outFile],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  );
  const m = readMeasurement(outFile, run.stdout || '');
  try {
    if (existsSync(outFile)) unlinkSync(outFile);
  } catch {
    /* best-effort */
  }
  if (run.error) throw new Error(`db-assert failed to launch: ${run.error.message}`);
  if (!m) throw new Error(`db-assert produced no measurement (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  if (m.error) throw new Error(`db-assert error: ${m.error}`);
  return m;
}

/** The exact deviations for the oracle counts vs. the manifest. Empty = every gate held. */
export interface CountCheck {
  cell: 'corpus' | 'filterOff' | 'filterOn';
  expected: number;
  got: number;
}

export function checkOracleCounts(manifest: FixtureManifest, m: Measurement): CountCheck[] {
  const devs: CountCheck[] = [];
  const off = m.filterOff?.length ?? 0;
  const on = m.filterOn?.length ?? 0;
  const corpus = m.corpus ?? 0;
  if (corpus !== manifest.expectedCounts.corpus) devs.push({ cell: 'corpus', expected: manifest.expectedCounts.corpus, got: corpus });
  if (off !== manifest.expectedCounts.filterOff) devs.push({ cell: 'filterOff', expected: manifest.expectedCounts.filterOff, got: off });
  if (on !== manifest.expectedCounts.filterOn) devs.push({ cell: 'filterOn', expected: manifest.expectedCounts.filterOn, got: on });
  return devs;
}

const LINKED_SENTINEL = '__QA_LINKED_COUNT__ ';

/**
 * OBSERVE the ACTUAL linked email set from the encrypted DB (the communications table) for a
 * transaction — the ground truth of what the app REALLY linked (BACKLOG-1875 verify-by-observing).
 * Returns the DISTINCT linked email count.
 *
 * ABI NOTE (see measureOracle): the cipher module is Electron-ABI, so the cipher-open runs in the
 * dedicated count-linked.js script under `ELECTRON_RUN_AS_NODE=1 electron` (headless), NOT under the
 * ts-node/plain-node parent. Args are passed via argv (no shell) so nothing is shell-interpolated.
 */
export function countLinkedEmails(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): number {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'count-linked.js');
  const run = spawnSync(
    electronBin,
    [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  );
  if (run.error) throw new Error(`count-linked failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(LINKED_SENTINEL));
  if (!line) {
    throw new Error(`count-linked produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(line.slice(line.indexOf(LINKED_SENTINEL) + LINKED_SENTINEL.length)) as {
    n?: number;
    error?: string;
  };
  if (parsed.error) throw new Error(`count-linked error: ${parsed.error}`);
  return parsed.n ?? 0;
}

const CLEAR_SENTINEL = '__QA_CLEAR_LINKED__ ';

/**
 * DELETE all email links for a transaction from the encrypted DB, returning it to a genuine
 * 0-linked clean slate. Used AFTER the transaction opens (once the on-open auto-link has settled)
 * so the address-filter toggle is the SOLE, OBSERVED cause of the subsequent links (BACKLOG-1950
 * re-runnability fix — the app auto-links on open per BACKLOG-1802, which would otherwise pre-seed
 * the "clean slate"). Returns { deleted, remaining }; `remaining` MUST be 0 after a successful clear.
 */
export function clearLinkedEmails(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): { deleted: number; remaining: number } {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'clear-linked.js');
  const run = spawnSync(
    electronBin,
    [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  );
  if (run.error) throw new Error(`clear-linked failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(CLEAR_SENTINEL));
  if (!line) {
    throw new Error(`clear-linked produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(line.slice(line.indexOf(CLEAR_SENTINEL) + CLEAR_SENTINEL.length)) as {
    deleted?: number;
    remaining?: number;
    error?: string;
  };
  if (parsed.error) throw new Error(`clear-linked error: ${parsed.error}`);
  return { deleted: parsed.deleted ?? 0, remaining: parsed.remaining ?? 0 };
}

/**
 * Poll the linked-email count until it is STABLE across two consecutive reads (the async on-open
 * auto-link has settled), or the deadline passes. Returns the last observed count. This lets the
 * caller clear AFTER the on-open auto-link finishes, avoiding a race where the clear runs first and
 * the background link then re-populates.
 */
export async function waitForStableLinkCount(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let prev = countLinkedEmails(repoRoot, electronBin, dbKey, dbPath, transactionId);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const cur = countLinkedEmails(repoRoot, electronBin, dbKey, dbPath, transactionId);
    if (cur === prev) return cur; // two identical consecutive reads → settled
    prev = cur;
  }
  return prev;
}
