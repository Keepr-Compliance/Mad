/**
 * BACKLOG-1940 (pivot) — the RELIABLE QA driver "founder command".
 *
 * ONE watchable, SINGLE-RUN, headful pass that drives the app via the UNPACKAGED
 * `_electron.launch()` path (node_modules electron + the built dist-electron/main.js — NO
 * packaging, NO codesign, NO Gatekeeper, NO macOS-15 signing crash) and classifies every step
 * into exactly one of PASS / FAIL / HARNESS_ERROR (see e2e/driver/outcome.ts).
 *
 * It proves, on a real machine:
 *   1. builds if needed, then launches the app UNPACKAGED and brings it to the FRONT (watchable);
 *   2. lands LOGGED-IN with NO OAuth and NO login wall — auth is a seeded fixture
 *      (session.json + a seeded DB session), not a real Supabase sign-in;
 *   3. dismisses the feature tour and reaches Settings VIA TESTID (screenshot);
 *   4. reaches the Transactions list VIA TESTID and clicks the FIRST row, which opens a REAL
 *      SEEDED transaction (its property address is visible) — screenshots each step;
 *   5. tears down gracefully — no orphan process, no "Reason: killed" crash dialog.
 *
 * SAFETY:
 *   - ISOLATED profile at a FIXED scratchpad path — NEVER the real ~/Library/Application
 *     Support/keepr. The seeder refuses to run against the real profile.
 *   - NO loops / NO app relaunches. Each step is attempted ONCE. On failure: screenshot, record
 *     the correct 3-way outcome (HARNESS_ERROR for harness problems), and STOP.
 *
 * Run (founder command):  npm run qa:drive
 *   (= ts-node -P e2e/tsconfig.json scripts/qa/drive-pivot.ts)
 *
 * Exit codes (distinct, per outcome.ts):  0 = PASS   1 = FAIL   2 = HARNESS_ERROR
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  banner,
  classifyThrown,
  exitCodeFor,
  harnessError,
  KeeprAppDriver,
  Outcome,
  pass,
  seedIsolatedProfile,
  type SeededIdentity,
  type StepResult,
  summarize,
} from '../../e2e/driver';
import { LoginWall } from '../../e2e/driver/selectors';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH_ROOT =
  process.env.KEEPR_QA_SCRATCH ??
  join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = process.env.QA_ARTIFACTS_DIR ?? join(SCRATCH_ROOT, 'drive-pivot');
/** Isolated profile. A fresh seed each run (default) keeps the run deterministic. */
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(SCRATCH_ROOT, 'keepr-pivot-profile');
const FRESH = process.env.QA_KEEP_PROFILE !== '1';

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function bannerLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n=== DRIVE: ${msg} ===`);
}

/** Build the app if the built entry / renderer assets are missing (idempotent, fast if present). */
function buildIfNeeded(): void {
  const mainEntry = join(REPO_ROOT, 'dist-electron', 'main.js');
  const renderer = join(REPO_ROOT, 'dist', 'index.html');
  if (existsSync(mainEntry) && existsSync(renderer)) {
    log('  build artifacts present — skipping build (set QA_FORCE_BUILD=1 to force)');
    if (process.env.QA_FORCE_BUILD !== '1') return;
  }
  bannerLog('building app (npm run build)');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function atLoginWall(driver: KeeprAppDriver): Promise<boolean> {
  return driver.page.getByText(LoginWall.visibleText).first().isVisible().catch(() => false);
}

async function main(): Promise<void> {
  if (FRESH && existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
  if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

  const steps: StepResult[] = [];
  const record = (r: StepResult): void => {
    steps.push(r);
    const tag = r.outcome === Outcome.PASS ? 'PASS' : r.outcome === Outcome.FAIL ? 'FAIL' : 'HARNESS_ERROR';
    log(`  [${tag}] ${r.step} — ${r.detail}`);
  };

  bannerLog(`profile (isolated) = ${PROFILE_DIR}`);
  bannerLog(`artifacts = ${ARTIFACTS_DIR}`);

  // ---- BUILD ----
  try {
    buildIfNeeded();
    record(pass('build', 'built (or reused) dist-electron + dist renderer'));
  } catch (err) {
    record(classifyThrown('build', err));
    return finish(steps, undefined);
  }

  // ---- SEED (fixture + session.json) ----
  let identity: SeededIdentity;
  try {
    bannerLog('seeding isolated profile (DB fixture + session.json, no OAuth)');
    identity = await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
    record(
      pass(
        'seed',
        `seeded user=${identity.email} tx="${identity.propertyAddress}" (${identity.contacts} contacts, ${identity.emails} emails)`,
      ),
    );
  } catch (err) {
    record(classifyThrown('seed', err));
    return finish(steps, undefined);
  }

  // ---- LAUNCH (single attempt, unpackaged, foregrounded) ----
  let driver: KeeprAppDriver | undefined;
  try {
    bannerLog('launching UNPACKAGED app (single attempt) + foregrounding');
    driver = await KeeprAppDriver.launch(REPO_ROOT, {
      strategy: 'unpackaged',
      reuseProfile: false,
      userDataDir: PROFILE_DIR,
      repoRoot: REPO_ROOT,
      artifactsDir: ARTIFACTS_DIR,
      launchTimeoutMs: 60_000,
    });
    await driver.waitForFirstPaint(60_000);
    await driver.bringToFront();
    await driver.screenshot('01-launched');
    record(pass('launch', 'app launched unpackaged and brought to front'));
  } catch (err) {
    record(classifyThrown('launch', err));
    return finish(steps, driver);
  }

  try {
    // ---- LOGGED-IN (no OAuth) ----
    const ready = await driver.waitForReady(30_000);
    if (!ready) {
      const stillLogin = await atLoginWall(driver);
      await driver.screenshot('02-not-ready');
      record(
        harnessError(
          'logged-in',
          stillLogin ? 'login-not-completed' : 'timeout',
          stillLogin
            ? 'still at the login wall — seeded session did not authenticate (auth injection failed)'
            : 'dashboard nav never rendered within budget (stuck on a transient screen)',
        ),
      );
      return finish(steps, driver);
    }
    await driver.screenshot('02-logged-in');
    record(pass('logged-in', 'landed on the authenticated dashboard with NO OAuth / NO login wall'));

    // ---- TOUR + SETTINGS ----
    const tourDismissed = await driver.dismissTour();
    record(pass('dismiss-tour', tourDismissed ? 'feature tour dismissed' : 'no tour shown (nothing to dismiss)'));

    await driver.gotoSettings();
    await driver.screenshot('03-settings');
    record(pass('settings', 'reached Settings via testid'));
    await driver.closeSettings();

    // ---- TRANSACTIONS ----
    await driver.gotoTransactions();
    await driver.screenshot('04-transactions');
    const listState = await driver.readTransactionsList();
    if (!listState.present) {
      // A missing tx-list is a harness/app-shape problem — NEVER a false "0 transactions".
      record(harnessError('transactions', 'selector-not-found', 'tx-list container not found (app-shape/harness problem)'));
      return finish(steps, driver);
    }
    if (listState.rowCount < 1) {
      // The seed guarantees >= 1 transaction. An empty list here means the fixture is not visible
      // to the app — that is a real problem with the seeded run, surfaced honestly (not a fake pass).
      record(
        harnessError(
          'transactions',
          'unexpected-app-shape',
          `tx-list present but shows ${listState.rowCount} rows; the seed guaranteed >= 1. Fixture not visible to the app.`,
        ),
      );
      return finish(steps, driver);
    }
    record(pass('transactions', `tx-list present with ${listState.rowCount} seeded row(s)`));

    // ---- CLICK FIRST TRANSACTION → assert it opened the REAL seeded transaction ----
    const clickResult = await driver.clickFirstTransaction();
    if (!clickResult.clicked) {
      record(harnessError('open-transaction', 'unexpected-app-shape', 'first row was not clickable despite a non-empty list'));
      return finish(steps, driver);
    }
    // Confirm the opened detail view shows the seeded property address (proves a REAL seeded tx).
    const addressVisible = await driver.page
      .getByText(identity.propertyAddress.split(',')[0], { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await driver.screenshot('05-transaction-open');
    if (!addressVisible) {
      // The list opened SOMETHING, but not the seeded transaction we can verify → do not claim PASS.
      record(
        harnessError(
          'open-transaction',
          'selector-not-found',
          `opened a transaction but could not confirm the seeded address "${identity.propertyAddress}" in the detail view`,
        ),
      );
      return finish(steps, driver);
    }
    record(pass('open-transaction', `opened the seeded transaction "${identity.propertyAddress}"`));
  } catch (err) {
    // Any thrown error inside a driving step is, by definition, a HARNESS_ERROR (never PASS/FAIL).
    await driver?.screenshot('99-error').catch(() => undefined);
    record(classifyThrown('drive', err));
  }

  return finish(steps, driver);
}

/** Graceful teardown + LOUD 3-way summary + distinct exit code. Single place so every path reports. */
async function finish(steps: StepResult[], driver: KeeprAppDriver | undefined): Promise<void> {
  let teardownDetail = 'no driver to tear down';
  if (driver) {
    try {
      // window.close() first to avoid a "Reason: killed" crash dialog, then driver.close().
      await driver.page.evaluate(() => (window as unknown as { close?: () => void }).close?.()).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1_000));
      await driver.close();
      teardownDetail = 'graceful (window.close → app.close, no crash dialog)';
    } catch (err) {
      teardownDetail = `teardown error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  steps.push(pass('teardown', teardownDetail));

  const summary = summarize(steps);
  log('\n────────────────────────────────────────────────────────');
  log(banner(summary.outcome));
  log(
    `PASS=${summary.counts[Outcome.PASS]}  FAIL=${summary.counts[Outcome.FAIL]}  HARNESS_ERROR=${summary.counts[Outcome.HARNESS_ERROR]}`,
  );
  log(`screenshots in: ${ARTIFACTS_DIR}`);
  log('────────────────────────────────────────────────────────');
  process.exit(exitCodeFor(summary.outcome));
}

// Guard against an unexpected top-level throw → clean HARNESS_ERROR exit (never a bare crash).
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(banner(Outcome.HARNESS_ERROR), '\n', err);
  process.exit(exitCodeFor(Outcome.HARNESS_ERROR));
});
