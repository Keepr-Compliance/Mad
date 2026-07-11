import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import {
  applyFixtureDbKey,
  FIXTURE_DB_KEY,
  readImportedContacts,
  SEED_CONTACT_FILTER_ENV,
  type ObservedContactRow,
} from '../../scripts/qa/harness/contacts-filter-core';
import { expectedVisibleCount, FILTER_SCENARIOS } from '../driver/contactsFilterOracle';
import {
  ALL_ROLE_LEAF_IDS,
  ALL_SOURCE_LEAF_IDS,
  ROLE_LEAF,
} from '../../src/utils/contactFilterModel';

/**
 * BACKLOG-1977 (P2-C1) — the FIXTURE-BASED Contacts-module CATEGORY-FILTER cell.
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network), that
 * the standalone Contacts module's grouped Source/Role filter (src/components/Contacts.tsx →
 * ContactSearchList with showCategoryFilter → GroupedMultiSelect, BACKLOG-1898 T3) renders EXACTLY the
 * contacts the app's OWN filter predicate (contactFilterModel.matchesContactFilters) selects from a
 * KNOWN seeded corpus.
 *
 * SETUP: a FRESH isolated profile is seeded per run with the FIXED DB key (no keychain / no safeStorage /
 * single Electron instance) AND KEEPR_QA_SEED_CONTACT_FILTER=1 — the env-gate that plants the BACKLOG-1977
 * deterministic contact corpus (8 contacts across source × default_role; see contacts-filter-core.ts).
 * The DEFAULT seed path (no env var) is byte-identical, so the BACKLOG-1950 fidelity guard stays 7/7.
 *
 * THE ORACLE (verify-by-OBSERVING — BACKLOG-1875): the DB is the category-count oracle. After each
 * filter selection we DERIVE the expected visible count by running the REAL matchesContactFilters over
 * the cipher-open `contacts` rows (count-contacts.js), then assert the RENDERED contact-row count equals
 * it. Filtering is client-side, so the DB rows + the production predicate are the ground truth and the UI
 * must match. We do NOT hard-code the numbers in the spec — the unit test
 * (scripts/qa/harness/__tests__/contacts-filter-core.test.ts) pins the per-leaf counts against the corpus.
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure is a
 * HARNESS_ERROR (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL); a WRONG rendered
 * count is a FAIL (a real app bug in the filter); correct counts are PASS. We NEVER fake counts to pass.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/
 * (the Node-jest CI run) — per the SR CI hard rule.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — so CI stays green with NO launch (headful/live run is founder-gated).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'contacts-filter');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

const electronBin = (() => {
  try {
    return resolveElectronBinary(REPO_ROOT);
  } catch {
    return '';
  }
})();

/** The always-disabled role leaves (Brokers has no backing role value — never selectable in the UI). */
const DISABLED_ROLE_LEAVES: readonly string[] = [ROLE_LEAF.BROKERS];

/** Seed a FRESH isolated profile with the BACKLOG-1977 contact corpus and return paths. */
async function freshSeedWithFilterCorpus(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `contacts-filter-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  // FIXED DB key BEFORE seeding (no safeStorage; the app launch inherits it → single instance, no
  // keychain). KEEPR_QA_SEED_CONTACT_FILTER=1 → the deterministic source×role corpus is planted.
  applyFixtureDbKey();
  const savedSeedFlag = process.env[SEED_CONTACT_FILTER_ENV];
  process.env[SEED_CONTACT_FILTER_ENV] = '1';
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    if (savedSeedFlag === undefined) delete process.env[SEED_CONTACT_FILTER_ENV];
    else process.env[SEED_CONTACT_FILTER_ENV] = savedSeedFlag;
  }
}

/** Launch unpackaged, land logged-in, open the standalone Contacts module. */
async function driveToContactsModule(profileDir: string, identity: SeededIdentity): Promise<KeeprAppDriver> {
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
  await driver.openContactsModule();
  void identity;
  return driver;
}

test.describe('contacts module category-filter cell (BACKLOG-1977)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` (headful/live run is founder-gated).');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + UI drive + DB read; give it room (single worker, no retries — see config).
  test.setTimeout(240_000);

  test('the grouped Source/Role filter renders EXACTLY the predicate-selected contacts for each scenario', async () => {
    const { identity, profileDir, dbPath } = await freshSeedWithFilterCorpus('main');
    const dbKey = FIXTURE_DB_KEY;

    // ---- HARNESS_ERROR precheck: the seeded corpus MUST be present in the DB (else the env-gate did
    // not take effect / the DB is wrong). Read it ONCE — it is the oracle input for every scenario. ----
    const rows: ObservedContactRow[] = readImportedContacts(REPO_ROOT, electronBin, dbKey, dbPath, identity.userId);
    if (rows.length === 0) {
      throw new Error(
        `[contacts-filter] setup failed: 0 imported contacts read for user ${identity.userId} (KEEPR_QA_SEED_CONTACT_FILTER did not take effect / wrong DB).`,
      );
    }
    // The 8-contact corpus + the 3 always-seeded defaults (Alice/Bob/Carol, source='email') = 11.
    if (rows.length < 8) {
      throw new Error(
        `[contacts-filter] setup failed: expected >=8 imported contacts (the seeded corpus), read ${rows.length}.`,
      );
    }

    const driver = await driveToContactsModule(profileDir, identity);
    try {
      await driver.screenshot('01-contacts-module');

      for (const scenario of FILTER_SCENARIOS) {
        // The ORACLE: derive the expected visible count from the REAL predicate over the DB rows.
        const expected = expectedVisibleCount(rows, scenario.sources, scenario.roles);

        // Drive the grouped filter to this EXACT selection (every leaf ON/OFF as the scenario dictates).
        await driver.setCategoryFilter({
          sourceLeaves: [...scenario.sources],
          roleLeaves: [...scenario.roles],
          allSourceLeaves: ALL_SOURCE_LEAF_IDS,
          allRoleLeaves: ALL_ROLE_LEAF_IDS,
          disabledRoleLeaves: DISABLED_ROLE_LEAVES,
        });
        await driver.screenshot(`02-scenario-${scenario.name.replace(/[^a-z0-9]+/gi, '-')}`);

        const rendered = await driver.visibleContactRowCount();
        // eslint-disable-next-line no-console
        console.log(`[contacts-filter] scenario "${scenario.name}": rendered=${rendered} expected(oracle)=${expected}`);
        // A wrong count here is a FAIL (a real filter bug). Correct is PASS.
        expect(
          rendered,
          `filter "${scenario.name}" should render exactly the ${expected} predicate-selected contacts`,
        ).toBe(expected);
      }
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });

  test('text search narrows the list to the matching contact (deterministic single hit)', async () => {
    const { identity, profileDir, dbPath } = await freshSeedWithFilterCorpus('search');
    const dbKey = FIXTURE_DB_KEY;
    const rows = readImportedContacts(REPO_ROOT, electronBin, dbKey, dbPath, identity.userId);
    if (rows.length < 8) {
      throw new Error(`[contacts-filter] setup failed: expected the seeded corpus, read ${rows.length}.`);
    }

    const driver = await driveToContactsModule(profileDir, identity);
    try {
      // First widen the filter so search is the ONLY narrowing dimension (default role hides non-clients).
      await driver.setCategoryFilter({
        sourceLeaves: ALL_SOURCE_LEAF_IDS,
        roleLeaves: ALL_ROLE_LEAF_IDS.filter((id) => id !== ROLE_LEAF.BROKERS),
        allSourceLeaves: ALL_SOURCE_LEAF_IDS,
        allRoleLeaves: ALL_ROLE_LEAF_IDS,
        disabledRoleLeaves: DISABLED_ROLE_LEAVES,
      });

      // "iPhoneAgent" is a unique display-name substring for exactly one seeded contact (Leo).
      await driver.setContactSearch('iPhoneAgent');
      await driver.page.waitForTimeout(300);
      await driver.screenshot('03-search-iphoneagent');
      const rendered = await driver.visibleContactRowCount();
      // eslint-disable-next-line no-console
      console.log(`[contacts-filter] search "iPhoneAgent": rendered=${rendered} (expected 1)`);
      expect(rendered, 'search should narrow to the single matching contact').toBe(1);

      // Clearing search restores the full (all-filters-open) set: the 8 corpus contacts (source='email'
      // defaults never match a source leaf, so they stay filtered out even with all sources selected).
      await driver.setContactSearch('');
      await driver.page.waitForTimeout(300);
      const cleared = await driver.visibleContactRowCount();
      const expectedAll = expectedVisibleCount(
        rows,
        new Set(ALL_SOURCE_LEAF_IDS),
        new Set(ALL_ROLE_LEAF_IDS.filter((id) => id !== ROLE_LEAF.BROKERS)),
      );
      // eslint-disable-next-line no-console
      console.log(`[contacts-filter] search cleared: rendered=${cleared} expected(oracle)=${expectedAll}`);
      expect(cleared, 'clearing search restores the full predicate-selected set').toBe(expectedAll);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
