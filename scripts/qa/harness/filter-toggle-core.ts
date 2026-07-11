/**
 * FILTER-TOGGLE exact-count cell — shared core (BACKLOG-1947 / BACKLOG-1950).
 *
 * Reusable, side-effecting helpers shared by BOTH the standalone CLI
 * (filter-toggle-cli.ts) and the Playwright spec (e2e/tests/filter-toggle-counts.spec.ts):
 *
 *   1. extractProfileKey  — decrypt the ISOLATED profile's DB key (Electron safeStorage).
 *   2. measureOracle      — run the H3 db-assert.js against the fixture manifest (node mode,
 *                           with --key) to MEASURE the filter-OFF / filter-ON / linked sets.
 *   3. expectedFromManifest — the committed exact counts (OFF=6 / ON=4) to diff against.
 *   4. countLinkedEmails  — OBSERVE the actual linked email set in the encrypted DB (the
 *                           communications table) to prove the app really linked what the
 *                           oracle says it should (verify-by-observing, BACKLOG-1875).
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

/** Sentinel emitted by emit-profile-key.js. */
const KEY_SENTINEL = '__QA_PROFILE_KEY_JSON__ ';

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
 * Decrypt the ISOLATED profile's DB key via the Electron safeStorage helper. Throws (→ the
 * caller classifies as HARNESS_ERROR) if the profile/key is missing or decrypt fails.
 */
export function extractProfileKey(repoRoot: string, electronBin: string, profileDir: string): string {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'emit-profile-key.js');
  const res = spawnSync(electronBin, [script, '--user-data-dir', profileDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const line = (res.stdout ?? '').split('\n').find((l) => l.includes(KEY_SENTINEL));
  if (!line) throw new Error(`emit-profile-key produced no result line. Output:\n${out}`);
  const parsed = JSON.parse(line.slice(line.indexOf(KEY_SENTINEL) + KEY_SENTINEL.length)) as {
    ok: boolean;
    key?: string;
    error?: string;
  };
  if (!parsed.ok || !parsed.key) throw new Error(`emit-profile-key failed: ${parsed.error ?? 'unknown error'}`);
  return parsed.key.trim();
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
