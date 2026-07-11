import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import {
  checkOracleCounts,
  countLinkedEmails,
  extractProfileKey,
  loadFixtureManifest,
  measureOracle,
} from '../../scripts/qa/harness/filter-toggle-core';

/**
 * BACKLOG-1950 — the FIXTURE-BASED email-attach + address-filter-toggle EXACT-COUNT cell.
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that the app's address-filter toggle (transactions.skip_address_filter, a LINKING-POLICY switch)
 * links EXACTLY the fixture-expected email counts each way — the fixture analog of the real 69/37.
 * The enriched seeder (BACKLOG-1947) plants a KNOWN corpus around the seeded transaction's address:
 *   filter-OFF (skip=1, "link all")     = 6 emails (participant-matched, in the date window)
 *   filter-ON  (skip=0, address filter) = 4 emails (subset of OFF; subject/body contain the tokens)
 *   delta (OFF - ON)                    = 2
 *
 * TWO independent oracles, both required (verify by OBSERVING — BACKLOG-1875):
 *   A) H3 db-assert.js derived-query oracle — MEASURES OFF/ON from email_participants+emails
 *      (communications-independent, deterministic). Windowless (BACKLOG-1887/FU-1), kept faithful by
 *      the fixture's window-bounded construction (asserted by the fidelity jest guard).
 *   B) RUNTIME communications observation — after driving the toggle we open the encrypted DB and
 *      COUNT what the app REALLY linked. Because auto-link is INSERT-only (monotonic), we assert:
 *        - clean-slate OFF run   -> 6 linked
 *        - clean-slate ON run    -> 4 linked
 *        - OFF-then-ON same seed -> stays 6 (ON adds 0, since ON is a subset of the already-linked OFF)
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver failure is a HARNESS_ERROR
 * (a thrown Playwright error -> the run is untrustworthy, NOT a false FAIL); a WRONG count is a FAIL
 * (a real app bug); correct counts are PASS. We NEVER fake counts to make it green.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/
 * (the Node-jest CI run) — per the SR CI hard rule.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — run `npm run build`, or `npm run qa:filter-toggle` (builds).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'filter-toggle');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

const { manifest, path: scenarioPath } = loadFixtureManifest(REPO_ROOT);
const electronBin = (() => {
  try {
    return resolveElectronBinary(REPO_ROOT);
  } catch {
    return '';
  }
})();

/** Seed a FRESH isolated profile at a unique path (optional extra env for the seed) and return paths. */
async function freshSeedWithEnv(
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `filter-toggle-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Launch unpackaged, land logged-in, open the seeded transaction, land on the Emails tab. */
async function driveToEmailsTab(profileDir: string, identity: SeededIdentity): Promise<KeeprAppDriver> {
  const driver = await KeeprAppDriver.launch(REPO_ROOT, {
    strategy: 'unpackaged',
    reuseProfile: false,
    userDataDir: profileDir,
    repoRoot: REPO_ROOT,
    artifactsDir: ARTIFACTS_DIR,
    launchTimeoutMs: 60_000,
  });
  await driver.waitForFirstPaint(60_000);
  await driver.bringToFront();
  const ready = await driver.waitForReady(30_000);
  expect(ready, 'seeded session should authenticate with no login wall (else HARNESS_ERROR)').toBe(true);

  await driver.dismissTour();
  await driver.gotoTransactions();
  const clickResult = await driver.clickFirstTransaction();
  expect(clickResult.clicked, 'first (seeded) transaction should be clickable').toBe(true);

  // Confirm the opened detail view is the seeded transaction.
  const streetOnly = identity.propertyAddress.split(',')[0];
  await expect(
    driver.page.getByText(streetOnly, { exact: false }).first(),
    `opened transaction should show the seeded address "${identity.propertyAddress}"`,
  ).toBeVisible({ timeout: 15_000 });

  // Open the Emails tab (a <button>Emails</button> — no testid on the tab itself).
  await driver.page.getByRole('button', { name: 'Emails' }).first().click();
  await driver.page.waitForTimeout(1500); // let the tab mount + loadDetails/loadCommunications settle
  await driver.screenshot('00-emails-tab-opened');

  // The address-filter toggle must appear on the emails tab. Its absence is a HARNESS_ERROR
  // (app-shape changed), NOT a false count — surface it by asserting the testid is visible.
  await expect(
    driver.page.getByTestId('address-filter-toggle').locator('visible=true').first(),
    'address-filter-toggle must be present on the emails tab (else HARNESS_ERROR: app shape changed)',
  ).toBeVisible({ timeout: 15_000 });
  // Exactly one visible toggle (guards the two-render-site ambiguity).
  expect(await driver.visibleAddressToggleCount(), 'exactly one visible address-filter toggle').toBe(1);

  return driver;
}

test.describe('address-filter toggle exact-count cell (BACKLOG-1947/1950)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build`, or use `npm run qa:filter-toggle` (builds automatically).');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + DB measure; give it room (single worker, no retries — see the config).
  test.setTimeout(240_000);

  test('H3 oracle: fixture links EXACTLY OFF=6 / ON=4 / delta=2 (deterministic)', async () => {
    const { identity, profileDir, dbPath } = await freshSeedWithEnv('oracle');
    // Extract the isolated profile's DB key so the node-mode oracle needs no keychain prompt.
    const dbKey = extractProfileKey(REPO_ROOT, electronBin, profileDir);
    const m = measureOracle(REPO_ROOT, electronBin, dbKey, dbPath, scenarioPath);

    const off = m.filterOff?.length ?? 0;
    const on = m.filterOn?.length ?? 0;
    // eslint-disable-next-line no-console
    console.log(`[filter-toggle] ORACLE observed: corpus=${m.corpus} OFF=${off} ON=${on} delta=${off - on}`);

    const deviations = checkOracleCounts(manifest, m);
    // A deviation here is a FAIL (a real divergence between the app's linking logic and the fixture) —
    // exactly the bug class this cell exists to catch. We do NOT fake counts to pass.
    expect(deviations, `oracle count deviations: ${JSON.stringify(deviations)}`).toEqual([]);
    expect(off).toBe(6);
    expect(on).toBe(4);
    expect(off - on).toBe(2);
    // filter-ON is a subset of filter-OFF (by construction).
    expect(on).toBeLessThanOrEqual(off);
    void identity;
  });

  test('RUNTIME (clean-slate OFF): driving the toggle OFF links EXACTLY 6; re-toggling ON is monotonic (stays 6)', async () => {
    const { identity, profileDir, dbPath } = await freshSeedWithEnv('off');
    const dbKey = extractProfileKey(REPO_ROOT, electronBin, profileDir);
    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      await driver.screenshot('off-01-emails-tab');

      // The seed starts with the address filter APPLIED (skip=0, aria-checked=true) and no links.
      expect(await driver.getAddressFilterState(), 'seed starts with the address filter APPLIED').toBe(true);
      expect(
        countLinkedEmails(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId),
        'no emails linked before toggling (corpus seeded unlinked)',
      ).toBe(0);

      // Toggle the address filter OFF (skip=1, "link all") -> re-link runs -> observe the DB.
      await driver.setAddressFilter(false);
      expect(await driver.getAddressFilterState()).toBe(false);
      await driver.page.waitForTimeout(1500); // let the async re-link + loadCommunications settle
      await driver.screenshot('off-02-filter-off');

      const afterOff = countLinkedEmails(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
      // eslint-disable-next-line no-console
      console.log(`[filter-toggle] RUNTIME after OFF: linked=${afterOff} (expected 6)`);
      // A wrong count here is a FAIL (a real app bug). Correct is PASS.
      expect(afterOff, 'filter OFF should link exactly the 6 participant-matched in-window emails').toBe(6);

      // Toggle back ON (skip=0). Auto-link is INSERT-only -> monotonic: ON adds 0 (subset already linked).
      await driver.setAddressFilter(true);
      expect(await driver.getAddressFilterState()).toBe(true);
      await driver.page.waitForTimeout(1500);
      await driver.screenshot('off-03-filter-on-again');

      const afterOnAgain = countLinkedEmails(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
      // eslint-disable-next-line no-console
      console.log(`[filter-toggle] RUNTIME after OFF->ON: linked=${afterOnAgain} (expected 6, monotonic)`);
      expect(afterOnAgain, 'toggling ON after OFF is monotonic — auto-link never unlinks (stays 6)').toBe(6);
    } finally {
      await driver.close().catch(() => undefined);
    }
  });

  test('RUNTIME (clean-slate ON): first toggle to ON links EXACTLY 4 (the address-matching subset)', async () => {
    // Seed with the address filter starting OFF (skip=1) so the FIRST UI toggle to ON is a genuine
    // clean-slate ON re-link (the change-triggered handler re-links only on a state change). This
    // links ONLY the 4 address-matching emails — the faithful clean-slate ON ground truth, distinct
    // from the monotonic OFF-then-ON path (which stays 6).
    const { identity, profileDir, dbPath } = await freshSeedWithEnv('on', { KEEPR_QA_START_SKIP_FILTER: '1' });
    const dbKey = extractProfileKey(REPO_ROOT, electronBin, profileDir);
    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      await driver.screenshot('on-01-emails-tab');

      // Seed starts with the address filter OFF (skip=1, aria-checked=false) and nothing linked.
      expect(await driver.getAddressFilterState(), 'seed starts with the address filter OFF (skip=1)').toBe(false);
      expect(
        countLinkedEmails(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId),
        'no emails linked before toggling (corpus seeded unlinked)',
      ).toBe(0);

      // First toggle to ON (skip=0, address filter APPLIED) fires the ON-only re-link.
      await driver.setAddressFilter(true);
      expect(await driver.getAddressFilterState()).toBe(true);
      await driver.page.waitForTimeout(1500); // let the async re-link + loadCommunications settle
      await driver.screenshot('on-02-filter-on');

      const afterOn = countLinkedEmails(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
      // eslint-disable-next-line no-console
      console.log(`[filter-toggle] RUNTIME clean-slate ON: linked=${afterOn} (expected 4)`);
      // A wrong count here is a FAIL (a real app bug). Correct is PASS.
      expect(afterOn, 'clean-slate ON should link exactly the 4 address-matching emails').toBe(4);

      // Cross-check against the H3 oracle ON set on the same DB.
      const m = measureOracle(REPO_ROOT, electronBin, dbKey, dbPath, scenarioPath);
      expect(m.filterOn?.length ?? 0, 'oracle ON subset agrees with the runtime clean-slate ON').toBe(4);
    } finally {
      await driver.close().catch(() => undefined);
    }
  });
});
