/**
 * BACKLOG-1940 — Trustworthy QA driver verification run (the "founder command").
 *
 * ONE controlled, SINGLE-RUN headful pass that exercises the HARDENED driver end-to-end and
 * classifies every step into exactly one of PASS / FAIL / HARNESS_ERROR (see e2e/driver/outcome.ts).
 * It proves, on a real machine, that:
 *   1. the app window comes to the FRONT and is visible (founder can watch);
 *   2. the feature tour is dismissed and Settings is reached VIA TESTID (screenshot);
 *   3. the Transactions list is reached VIA TESTID and its state is reported HONESTLY —
 *      an EMPTY list is a PASS (not a HARNESS_ERROR, not a crash); a MISSING tx-list would be a
 *      HARNESS_ERROR (never a false "0 transactions"); clickFirstTransaction() on an empty list is
 *      a clean "no transactions" outcome;
 *   4. teardown is graceful — no orphan process, no "Reason: killed" crash dialog.
 *
 * SAFETY (identical contract to the tonight-demo scripts):
 *   - strategy 'cdp' → renderer-only attach; works on the ad-hoc-signed build with no fuse change.
 *   - PERSISTENT ISOLATED userDataDir at a FIXED scratchpad path — NEVER the real
 *     ~/Library/Application Support/keepr. Never touches the founder's data.
 *   - cdpPort OMITTED → a FREE ephemeral port (never 9222) → can't hijack a dev instance.
 *   - NO loops / NO app relaunches. Each nav step is attempted ONCE. A missing testid → screenshot,
 *     record a HARNESS_ERROR, and STOP (no retry, no relaunch).
 *   - Login: reuse the persisted session profile if it has one; else WAIT (with a loud banner) up to
 *     3 min for the founder to sign in, then STOP as a clean HARNESS_ERROR (never hang forever).
 *   - Teardown targets ONLY our spawned PID tree / the exact dist executable path.
 *
 * Run (founder command):
 *   npm run qa:drive:verify
 *   # (= ts-node -P e2e/tsconfig.json scripts/qa/drive-verify.ts)
 *
 * Exit codes (distinct, per outcome.ts):  0 = PASS   1 = FAIL   2 = HARNESS_ERROR
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  banner,
  classifyThrown,
  exitCodeFor,
  harnessError,
  KeeprAppDriver,
  Outcome,
  pass,
  summarize,
  type StepResult,
} from '../../e2e/driver';
import { resolveExecutable } from '../../e2e/driver/paths';
import { LoginWall } from '../../e2e/driver/selectors';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH_ROOT =
  process.env.KEEPR_QA_SCRATCH ??
  '/private/tmp/claude-501/-Users-daniel-Documents-Mad/1a55b90d-0a82-4a43-a8d0-5764ddee53bf/scratchpad';
const ARTIFACTS_DIR = process.env.QA_ARTIFACTS_DIR ?? join(SCRATCH_ROOT, 'driver-verify');

/**
 * Isolated profile. Default: reuse the tonight-demo profile (holds a session so we clear the login
 * wall). Override with QA_PROFILE_DIR=<path> for a FRESH empty profile (demonstrates the empty-list
 * PASS boundary, but will hit the login wall and wait for a manual sign-in).
 */
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(SCRATCH_ROOT, 'keepr-demo-profile');

/** Login-wait budget: up to 3 minutes, then STOP as a clean HARNESS_ERROR (never hang forever). */
const LOGIN_WAIT_MS = 3 * 60_000;
const LOGIN_POLL_MS = 2_000;

const shots: string[] = [];
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function bannerLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n=== VERIFY: ${msg} ===`);
}

/**
 * Strict-verify the packaged app bundle's code signature (macOS). On macOS 15 the runtime signing
 * monitor SIGKILLs a bundle whose signature does not validate strictly (including nested Helper.app
 * / frameworks), before any app code runs — so we gate launch on this. Resolving the bundle from the
 * MacOS executable path keeps this aligned with what the driver will actually launch.
 */
function strictVerifySignature(): { ok: boolean; detail: string } {
  const exe = resolveExecutable(REPO_ROOT); // …/Keepr.app/Contents/MacOS/Keepr
  const appBundle = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'pipe' });
    return { ok: true, detail: 'valid' };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    return { ok: false, detail: stderr.split('\n')[0] || 'codesign --verify failed' };
  }
}

/** True if the verify build's own Keepr executable is still running (by exact dist path). */
function verifyProcessAlive(): boolean {
  try {
    execFileSync('pgrep', ['-f', resolveExecutable(REPO_ROOT)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
/** SIGTERM/SIGKILL ONLY the verify build's own Keepr (exact dist path) — never a bare name pattern. */
function sweepOrphans(signal: '-TERM' | '-KILL' = '-TERM'): void {
  try {
    execFileSync('pkill', [signal, '-f', resolveExecutable(REPO_ROOT)], { stdio: 'ignore' });
  } catch {
    /* nothing matched */
  }
}

async function atLoginWall(driver: KeeprAppDriver): Promise<boolean> {
  return driver.page
    .getByText(LoginWall.visibleText)
    .first()
    .isVisible()
    .catch(() => false);
}

/** Wait (≤ LOGIN_WAIT_MS) for the founder to clear the login wall. Returns true once logged in. */
async function waitForLogin(driver: KeeprAppDriver): Promise<boolean> {
  const deadline = Date.now() + LOGIN_WAIT_MS;
  let lastLog = 0;
  while (Date.now() < deadline) {
    if (!(await atLoginWall(driver))) return true;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (Date.now() - lastLog > 4_000) {
      log(`\n>>> WAITING FOR LOGIN <<<  click 'Sign in with Browser'  (${remaining}s left before clean stop)`);
      lastLog = Date.now();
    }
    await driver.page.waitForTimeout(LOGIN_POLL_MS);
  }
  return false;
}

/**
 * GRACEFUL TEARDOWN — avoid the "Reason: killed" crash dialog. window.close() first, then
 * driver.close() (SIGTERM→grace→SIGKILL of the spawned tree). Reports the method used.
 */
async function gracefulTeardown(driver: KeeprAppDriver): Promise<{ method: string; orphanAlive: boolean }> {
  try {
    await driver.page.evaluate(() => {
      (window as unknown as { close?: () => void }).close?.();
    });
  } catch {
    /* page may be detached */
  }
  await new Promise((r) => setTimeout(r, 1_200));

  let method = 'window.close() (no signal needed)';
  if (verifyProcessAlive()) {
    await driver.close().catch(() => undefined); // CDP detach + SIGTERM→grace→SIGKILL spawned tree
    const graceDeadline = Date.now() + 7_000;
    method = 'SIGTERM via driver.close() (clean quit — no crash dialog)';
    while (Date.now() < graceDeadline) {
      if (!verifyProcessAlive()) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (verifyProcessAlive()) {
      sweepOrphans('-TERM');
      await new Promise((r) => setTimeout(r, 1_500));
      method = 'SIGTERM sweep (dist-path)';
    }
  }
  const orphanAlive = verifyProcessAlive();
  if (orphanAlive) {
    sweepOrphans('-KILL');
    method = 'SIGKILL (last resort — crash dialog possible)';
  }
  return { method, orphanAlive: verifyProcessAlive() };
}

async function main(): Promise<void> {
  if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

  const steps: StepResult[] = [];
  const record = (r: StepResult): void => {
    steps.push(r);
    const tag = r.outcome === Outcome.PASS ? 'PASS' : r.outcome === Outcome.FAIL ? 'FAIL' : 'HARNESS_ERROR';
    log(`  [${tag}] ${r.step} — ${r.detail}`);
  };

  // SAFETY: refuse to start a SECOND verify-build instance (single-run contract).
  if (verifyProcessAlive()) {
    record(
      harnessError('preflight', 'launch-failed', 'a verify-build Keepr is already running — refusing to start a second'),
    );
    return finish(steps, undefined);
  }

  bannerLog(`profile (isolated) = ${PROFILE_DIR}`);
  bannerLog(`artifacts = ${ARTIFACTS_DIR}`);

  // ---- CODE-SIGNING PREFLIGHT (macOS 15 strict monitor) ----
  // On macOS 15 the runtime code-signing monitor KILLS an ad-hoc/unsigned QA build on launch
  // (SIGKILL in dyld, before app code runs). Strict-verify the bundle FIRST so an invalid signature
  // surfaces as a distinct ENVIRONMENT HARNESS_ERROR, not a confusing mid-run crash. Single check.
  if (process.platform === 'darwin') {
    const sig = strictVerifySignature();
    if (!sig.ok) {
      record(
        harnessError(
          'preflight-codesign',
          'environment-signing',
          `QA build failed strict code-signing verify — macOS 15 will SIGKILL it on launch. ` +
            `Re-sign with: codesign --force --deep --sign - <app>. Detail: ${sig.detail}`,
        ),
      );
      return finish(steps, undefined); // do NOT launch a build that will be killed
    }
    record(pass('preflight-codesign', 'QA build passes strict code-signing verify'));
  }

  // ---- LAUNCH (single attempt) ----
  let driver: KeeprAppDriver | undefined;
  try {
    bannerLog('launching ad-hoc-signed packaged app via CDP (single attempt) + foregrounding');
    driver = await KeeprAppDriver.launch(REPO_ROOT, {
      strategy: 'cdp',
      reuseProfile: false, // NOT the real profile...
      userDataDir: PROFILE_DIR, // ...our FIXED isolated one
      // cdpPort omitted → free ephemeral port
      launchTimeoutMs: 90_000,
      artifactsDir: ARTIFACTS_DIR,
    });
    record(pass('launch', 'app launched + brought to front via CDP'));
  } catch (err) {
    record(classifyThrown('launch', err));
    sweepOrphans('-TERM');
    return finish(steps, undefined);
  }

  const shot = async (name: string): Promise<void> => {
    await driver!.screenshot(name).catch(() => undefined);
    const file = join(ARTIFACTS_DIR, `${name.replace(/[^a-z0-9-_]/gi, '_')}.png`);
    shots.push(file);
    log(`  [screenshot] ${name} -> ${file}`);
  };

  try {
    await driver.waitForFirstPaint(60_000);

    // ---- LOGIN GATE ----
    if (await atLoginWall(driver)) {
      bannerLog('AT THE LOGIN WALL — holding up to 3 min for a manual sign-in, then a clean stop');
      await shot('verify-00-login-wall');
      const loggedIn = await waitForLogin(driver);
      if (!loggedIn) {
        record(
          harnessError('await-login', 'login-not-completed', 'login wall did not clear within 3 min — clean stop'),
        );
        await shot('verify-00b-login-timeout');
        return finish(steps, driver);
      }
      record(pass('await-login', 'login wall cleared'));
    } else {
      record(pass('session-reuse', 'persisted session reused — already past the login wall'));
    }

    // ---- COMPLETE ONBOARDING if the app landed there (skip email) ----
    // The ad-hoc-signed build cannot decrypt the notarized profile's DB key (different signing
    // identity — see e2e/README.md), so it re-onboards on a fresh/isolated profile. Drive through
    // it (skipping email) to reach the dashboard, so we can exercise the transactions-list path.
    if ((await driver.detectState()) === 'onboarding') {
      bannerLog('app landed on ONBOARDING — driving through it (skipping email) to reach the dashboard');
      try {
        await driver.completeOnboarding({ skip: true, timeoutMs: 120_000 });
        record(pass('complete-onboarding', 'onboarding completed (email skipped) — reached the ready app'));
      } catch (err) {
        record(classifyThrown('complete-onboarding', err));
        await shot('verify-01b-onboarding-stuck');
        return finish(steps, driver);
      }
    }

    // ---- WAIT FOR THE READY DASHBOARD (nav testid), bounded ----
    // The ad-hoc build can get stuck on a transient "Verifying your account…" screen. Treat a
    // never-ready app as a DISTINCT, HONEST HARNESS_ERROR — never pretend the dashboard is up.
    const ready = await driver.waitForReady(25_000);
    await shot('verify-01-dashboard');
    if (!ready) {
      record(
        harnessError(
          'wait-for-dashboard',
          'unexpected-app-shape',
          'dashboard nav never rendered (app appears stuck, e.g. "Verifying your account…") — ' +
            'cannot judge Settings/Transactions. This is an app/environment state, not a testid gap.',
        ),
      );
      return finish(steps, driver);
    }
    record(pass('wait-for-dashboard', 'dashboard nav rendered (ready main app)'));

    // ---- DISMISS TOUR (single attempt) ----
    try {
      const dismissed = await driver.dismissTour();
      record(pass('dismiss-tour', dismissed ? 'feature tour dismissed via data-action="skip"' : 'no tour present'));
    } catch (err) {
      record(classifyThrown('dismiss-tour', err));
    }

    // ---- SETTINGS via testid ----
    try {
      await driver.gotoSettings();
      record(pass('goto-settings', 'reached settings-page via testids (nav-profile → nav-settings)'));
      await shot('verify-02-settings');
    } catch (err) {
      record(classifyThrown('goto-settings', err));
      await shot('verify-02-settings-failed');
      return finish(steps, driver); // single-run: stop on a nav harness error
    }

    // Close Settings modal (via its testid) to return to the dashboard before going to transactions.
    await driver.closeSettings();
    await driver.page.waitForTimeout(400);

    // ---- TRANSACTIONS via testid + EMPTY-vs-HARNESS_ERROR boundary ----
    try {
      await driver.gotoTransactions();
      const state = await driver.readTransactionsList();
      await shot('verify-03-transactions');
      if (!state.present) {
        // Must NOT be reported as "0 transactions" — the list container itself was missing.
        record(
          harnessError('assert-transactions', 'selector-not-found', 'tx-list not found — cannot judge transactions', {
            state,
          }),
        );
      } else {
        // tx-list present. Empty OR populated are BOTH correct app states → PASS.
        record(
          pass(
            'assert-transactions',
            state.empty
              ? 'tx-list present and correctly EMPTY (empty state rendered) — not a harness error, not a crash'
              : `tx-list present with ${state.rowCount} row(s)`,
            { state },
          ),
        );

        // clickFirstTransaction on an empty list must be a CLEAN "no transactions" outcome (PASS).
        const click = await driver.clickFirstTransaction();
        record(
          pass(
            'click-first-transaction',
            click.empty
              ? 'empty list → clean "no transactions" (nothing clicked) — correct'
              : 'clicked first transaction row (tx-row-0)',
            { click },
          ),
        );
        if (!click.empty) await shot('verify-04-transaction-detail');
      }
    } catch (err) {
      record(classifyThrown('assert-transactions', err));
      await shot('verify-03-transactions-failed');
    }
  } catch (err) {
    record(classifyThrown('run', err));
  }

  return finish(steps, driver);
}

/** Teardown + summary + exit. Always reached exactly once. */
async function finish(steps: StepResult[], driver: KeeprAppDriver | undefined): Promise<void> {
  if (driver) {
    bannerLog('graceful teardown — clean quit to avoid the "Reason: killed" crash dialog');
    const { method, orphanAlive } = await gracefulTeardown(driver);
    steps.push(
      orphanAlive
        ? harnessError('teardown', 'internal', `orphan process survived teardown (method: ${method})`)
        : pass('teardown', `clean teardown, no orphan (method: ${method})`),
    );
    log(`  teardown: ${method}, orphanAlive=${orphanAlive}`);
  }

  const sum = summarize(steps);
  bannerLog('RESULT');
  log(banner(sum.outcome));
  log(
    `counts: PASS=${sum.counts[Outcome.PASS]} FAIL=${sum.counts[Outcome.FAIL]} HARNESS_ERROR=${
      sum.counts[Outcome.HARNESS_ERROR]
    }`,
  );
  // eslint-disable-next-line no-console
  console.log(
    'VERIFY_SUMMARY ' +
      JSON.stringify({
        outcome: sum.outcome,
        exitCode: sum.exitCode,
        counts: sum.counts,
        screenshots: shots,
        steps: sum.steps.map((s) => ({ step: s.step, outcome: s.outcome, detail: s.detail, cat: s.harnessCategory })),
      }),
  );
  process.exit(sum.exitCode);
}

main().catch((err) => {
  // Any escape here is, by definition, a harness problem → exit code 2, never a silent PASS.
  // eslint-disable-next-line no-console
  console.error('VERIFY_CRASHED ' + String(err));
  sweepOrphans('-TERM');
  process.exit(exitCodeFor(Outcome.HARNESS_ERROR));
});
