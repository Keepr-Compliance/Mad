#!/usr/bin/env ts-node
/**
 * `qa:filter-toggle` CLI — address-filter exact-count ORACLE proof (BACKLOG-1947 / BACKLOG-1950).
 *
 * A fast, headless, deterministic second oracle for the address-filter fixture. It:
 *   1. builds the app if needed (so the seeder can provision the encrypted DB),
 *   2. seeds a FRESH isolated profile with the enriched fixture (BACKLOG-1947),
 *   3. extracts the isolated profile's DB key (Electron safeStorage), then
 *   4. runs the H3 db-assert.js derived-query oracle (node mode, --key) and diffs the measured
 *      filter-OFF / filter-ON counts against the committed manifest (docs/qa/scenarios/fixture-filter-counts.json).
 *
 * It does NOT launch the UI (that is the Playwright cell, e2e/tests/filter-toggle-counts.spec.ts,
 * which additionally OBSERVES the real communications delta). This CLI is the deterministic count
 * regression signal, mirroring qa:search-attach.
 *
 * Classifies into exactly one of PASS / FAIL / HARNESS_ERROR (e2e/driver/outcome.ts): a launch/
 * seed/decrypt failure is a HARNESS_ERROR (the harness could not judge); a WRONG count is a FAIL
 * (the app's linking diverged from the fixture — the bug class this exists to catch); correct
 * counts are PASS. It NEVER fakes counts.
 *
 * Usage:  npm run qa:filter-toggle
 * Exit codes (per outcome.ts):  0 = PASS   1 = FAIL   2 = HARNESS_ERROR
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveElectronBinary } from '../../../e2e/driver/paths';
import { seedIsolatedProfile } from '../../../e2e/driver/seed/seedProfile';
import { banner, exitCodeFor, Outcome } from '../../../e2e/driver/outcome';
import {
  applyFixtureDbKey,
  checkOracleCounts,
  FIXTURE_DB_KEY,
  loadFixtureManifest,
  measureOracle,
} from './filter-toggle-core';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const PROFILE_DIR = join(SCRATCH, 'filter-toggle-cli-profile');

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function buildIfNeeded(): void {
  const mainEntry = join(REPO_ROOT, 'dist-electron', 'main.js');
  const renderer = join(REPO_ROOT, 'dist', 'index.html');
  if (existsSync(mainEntry) && existsSync(renderer) && process.env.QA_FORCE_BUILD !== '1') {
    log('  build artifacts present — skipping build (set QA_FORCE_BUILD=1 to force)');
    return;
  }
  log('  building app (npm run build)…');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function main(): Promise<Outcome> {
  const { manifest, path: scenarioPath } = loadFixtureManifest(REPO_ROOT);
  log(`\n=== qa:filter-toggle — fixture "${manifest.id}" (expect OFF=${manifest.expectedCounts.filterOff} / ON=${manifest.expectedCounts.filterOn}) ===`);

  let electronBin: string;
  try {
    electronBin = resolveElectronBinary(REPO_ROOT);
  } catch (err) {
    log(`  HARNESS_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return Outcome.HARNESS_ERROR;
  }

  // ---- BUILD + SEED (HARNESS_ERROR on failure) ----
  // NO-KEYCHAIN: pin the FIXED DB key before seeding so the seeder provisions with it and the oracle
  // reads via --key — no safeStorage, no second Electron process (this CLI never launches the app).
  const dbKey = FIXTURE_DB_KEY;
  applyFixtureDbKey();
  let dbPath: string;
  try {
    buildIfNeeded();
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(PROFILE_DIR, { recursive: true });
    const identity = await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
    dbPath = join(PROFILE_DIR, 'mad.db');
    log(`  seeded isolated profile: tx="${identity.propertyAddress}" (${identity.emails} emails, ${identity.contacts} contacts)`);
  } catch (err) {
    log(`  HARNESS_ERROR (seed/build): ${err instanceof Error ? err.message : String(err)}`);
    return Outcome.HARNESS_ERROR;
  }

  // ---- MEASURE (HARNESS_ERROR on failure) ----
  let off: number;
  let on: number;
  let corpus: number;
  let deviations: ReturnType<typeof checkOracleCounts>;
  try {
    const m = measureOracle(REPO_ROOT, electronBin, dbKey, dbPath, scenarioPath);
    off = m.filterOff?.length ?? 0;
    on = m.filterOn?.length ?? 0;
    corpus = m.corpus ?? 0;
    deviations = checkOracleCounts(manifest, m);
  } catch (err) {
    log(`  HARNESS_ERROR (measure): ${err instanceof Error ? err.message : String(err)}`);
    return Outcome.HARNESS_ERROR;
  }

  log(`  MEASURED: corpus=${corpus}  filter-OFF=${off}  filter-ON=${on}  delta=${off - on}`);

  // ---- VERDICT ----
  if (deviations.length > 0) {
    for (const d of deviations) log(`  FAIL: ${d.cell} expected ${d.expected}, got ${d.got}`);
    return Outcome.FAIL;
  }
  if (off - on !== manifest.expectedCounts.filterOff - manifest.expectedCounts.filterOn) {
    log(`  FAIL: delta ${off - on} != expected ${manifest.expectedCounts.filterOff - manifest.expectedCounts.filterOn}`);
    return Outcome.FAIL;
  }
  return Outcome.PASS;
}

main()
  .then((outcome) => {
    log('\n' + banner(outcome));
    process.exit(exitCodeFor(outcome));
  })
  .catch((err) => {
    // Any unexpected throw is a HARNESS_ERROR (never a bare crash / false verdict).
    // eslint-disable-next-line no-console
    console.error(banner(Outcome.HARNESS_ERROR), '\n', err);
    process.exit(exitCodeFor(Outcome.HARNESS_ERROR));
  });
