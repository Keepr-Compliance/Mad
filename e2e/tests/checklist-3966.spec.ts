import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry } from '../driver/paths';
import { seedIsolatedProfile } from '../driver/seed/seedProfile';

/**
 * BACKLOG-3966 U1 — the private "My items" section on the Checklist tab, in the BUILT app.
 *
 * WRITTEN, NOT RUN: the lane runs the walkthrough once on the final content (BACKLOG-4054 /
 * BACKLOG-4093). The seeder runs under scripts/qa/harness/electron-sandboxed.sh (seedIsolatedProfile
 * does that; --use-mock-keychain and --user-data-dir=<dir> only, never a fake HOME).
 *
 * 20 s sign-out caveat: a seeded session is signed out about 20 s after launch unless it is
 * signed in against keepr-test. Either sign in through the keepr-test preview inside the cell
 * (QA_SIGN_IN_VIA_PREVIEW=1, done by the driver before beforeAll returns) or finish every
 * assertion within 20 s of waitForReady — each cell below is a few clicks.
 *
 * Fixture (to seed): one active deal `QA_DEAL_ADDRESS` with one template checklist (7 of 12
 * required done) and no My items; one deal locked with the broker (`QA_LOCKED_ADDRESS`).
 * Plan: gated cells need `QA_PLAN=allowed`; ungated cells need `QA_PLAN=blocked` (a keepr-test
 * plan with checklists off). Cells SKIP when their precondition is absent rather than passing
 * on an empty screen.
 *
 * Jest stand-ins (run on every PR):
 *   U1-H1  MyItemsSection-3966 "draws first, private…", "a plan without checklists" block
 *   U1-H2  MyItemsSection-3966 "every write goes through its own channel" + "keyboard" blocks
 *   U1-H3  MyItemsSection-3966 "a locked deal" block; TransactionChecklistTab.dealLock-3910d
 *   U1-H4  MyItemsSection-3966 "the tab total is main's sum"; TransactionDetails.checklist-3476
 *          "My items count on the Overview"; checklistTodo-3965 + transactionOpenDbService-3965
 *          (main's Todo and Recent ring count is_required = 1, which every My item carries)
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(REPO_ROOT, '.qa-scratch', 'keepr-checklist-3966-profile');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'checklist-3966');
const DEAL = process.env.QA_DEAL_ADDRESS ?? '';
const LOCKED = process.env.QA_LOCKED_ADDRESS ?? '';
const PLAN = process.env.QA_PLAN ?? '';

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

async function openChecklistTab(d: KeeprAppDriver, address: string): Promise<void> {
  const page = d.page;
  // From the Transactions list: Recent shows only five deals, and a page-wide match can hit the
  // Dashboard copy hidden behind the list. A Details view left open by the previous cell blocks
  // both, so it is closed first.
  await d.dismissTransactionDetailsIfOpen();
  await d.gotoTransactions();
  await page.getByTestId('tx-list').getByText(address, { exact: false }).first().click();
  await page.getByTestId('tab-checklist').click();
  await expect(page.getByTestId('my-items-section')).toBeVisible();
}

async function addMyItem(page: Page, title: string): Promise<void> {
  await page.getByTestId('my-items-add-input').fill(title);
  await page.getByTestId('my-items-add-input').press('Enter');
  await expect(page.getByTestId('my-items-section').getByText(title)).toBeVisible();
}

test.describe('Checklist tab: My items (BACKLOG-3966 U1)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.setTimeout(240_000);

  let driver: KeeprAppDriver | undefined;

  test.beforeAll(async () => {
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(PROFILE_DIR, { recursive: true });
    await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
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
    expect(await driver.waitForReady(30_000), 'seeded session should authenticate').toBe(true);
    await driver.dismissTour();
  });

  test.afterAll(async () => {
    await driver?.close().catch(() => undefined);
  });

  test('U1-H1a gated plan: My items first, Private, then the template checklist', async () => {
    test.skip(PLAN !== 'allowed' || !DEAL, 'Needs QA_PLAN=allowed and QA_DEAL_ADDRESS.');
    const page = driver!.page;
    await openChecklistTab(driver!, DEAL);
    await expect(page.getByTestId('my-items-private-pill')).toHaveText(/Private/);
    await expect(page.getByTestId('my-items-empty')).toBeVisible();
    const mine = await page.getByTestId('my-items-section').boundingBox();
    const first = await page.locator('[data-testid^="checklist-section-"][aria-label]').first().boundingBox();
    expect(mine && first && mine.y < first.y).toBe(true);
    await driver!.screenshot('u1-h1a-gated');
  });

  test('U1-H1b ungated plan: My items editable, template hint, no Add checklist', async () => {
    test.skip(PLAN !== 'blocked' || !DEAL, 'Needs QA_PLAN=blocked (keepr-test plan without checklists).');
    const page = driver!.page;
    await openChecklistTab(driver!, DEAL);
    await expect(page.getByTestId('checklist-template-hint')).toHaveText('Template checklists aren’t on your plan.');
    await expect(page.getByTestId('checklist-add')).toHaveCount(0);
    await addMyItem(page, 'QA ungated item');
    await driver!.screenshot('u1-h1b-ungated');
  });

  test('U1-H2 add, rename, reorder, tick, delete', async () => {
    test.skip(!PLAN || !DEAL, 'Needs QA_PLAN and QA_DEAL_ADDRESS.');
    const page = driver!.page;
    await openChecklistTab(driver!, DEAL);
    await addMyItem(page, 'QA first');
    await addMyItem(page, 'QA second');
    const section = page.getByTestId('my-items-section');

    await section.getByRole('button', { name: 'More actions for QA first' }).click();
    await section.getByRole('button', { name: 'Rename' }).click();
    await section.getByRole('textbox', { name: 'Rename QA first' }).fill('QA first renamed');
    await section.getByRole('textbox', { name: 'Rename QA first' }).press('Enter');
    await expect(section.getByText('QA first renamed')).toBeVisible();

    await section.getByRole('button', { name: 'More actions for QA first renamed' }).click();
    await section.getByRole('button', { name: 'Move down' }).click();
    await expect(section.locator('h5').first()).toHaveText('QA second');

    await section.getByRole('checkbox', { name: 'QA second' }).click();
    await expect(section.getByRole('checkbox', { name: 'QA second' })).toHaveAttribute('aria-checked', 'true');

    await section.getByRole('button', { name: 'More actions for QA first renamed' }).click();
    await section.getByRole('button', { name: 'Delete' }).click();
    await section.getByRole('button', { name: 'Delete' }).last().click();
    await expect(section.getByText('QA first renamed')).toHaveCount(0);
    await driver!.screenshot('u1-h2-writes');
  });

  test('U1-H3 locked deal: the tab lock notice, rows read-only, no add', async () => {
    test.skip(!LOCKED, 'Needs QA_LOCKED_ADDRESS (a deal with the broker).');
    const page = driver!.page;
    await openChecklistTab(driver!, LOCKED);
    // One lock line: the tab's notice. My items' own line is not shown on a locked deal
    // (MyItemsSection.tsx renders `my-items-locked` only for a refusal, not `locked`).
    await expect(page.getByTestId('checklist-locked-notice')).toBeVisible();
    const section = page.getByTestId('my-items-section');
    await expect(section.getByTestId('my-items-locked')).toHaveCount(0);
    // No Add, no ⋯ menu (Rename / Move / Delete), no drag handle, no Link… or note on a row.
    await expect(section.getByTestId('my-items-add-input')).toHaveCount(0);
    await expect(section.getByTestId('my-items-add')).toHaveCount(0);
    await expect(section.locator('[data-testid^="my-item-menu-toggle-"]')).toHaveCount(0);
    await expect(section.locator('[data-testid^="my-item-drag-"]')).toHaveCount(0);
    await expect(section.locator('[data-testid^="checklist-open-picker-"]')).toHaveCount(0);
    await expect(section.locator('[data-testid^="checklist-add-note-"]')).toHaveCount(0);
    // Every row's checkbox is disabled (ChecklistItemRow `disabled={readOnly || pending}`).
    for (const check of await section.locator('[data-testid^="checklist-check-"]').all()) {
      await expect(check).toBeDisabled();
    }
    await driver!.screenshot('u1-h3-locked');
  });

  test('U1-H4 a ticked My item counts on the tab, the Overview and the Dashboard', async () => {
    test.skip(PLAN !== 'allowed' || !DEAL, 'Needs QA_PLAN=allowed and QA_DEAL_ADDRESS (7 of 12 required).');
    const page = driver!.page;
    await openChecklistTab(driver!, DEAL);
    await addMyItem(page, 'QA counted');
    await page.getByTestId('my-items-section').getByRole('checkbox', { name: 'QA counted' }).click();
    const total = page.getByTestId('checklist-total-progress');
    await expect(total.getByTestId('checklist-progress-text')).toHaveText(/^8 of \d+ required done$/);
    await expect(total.getByTestId('checklist-total-my-items')).toHaveText(/includes \d+ of \d+ of your items/);
    const tabText = await total.getByTestId('checklist-progress-text').textContent();

    await page.getByRole('button', { name: /^Overview/ }).click();
    await expect(page.getByTestId('overview-checklist')).toContainText(tabText ?? '');

    await page.keyboard.press('Escape');
    const ring = page.getByTestId('dashboard-recent-row').filter({ hasText: DEAL }).getByRole('progressbar');
    await expect(ring).toHaveAttribute('aria-valuenow', '8');
    await driver!.screenshot('u1-h4-counts');
  });
});
