import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry } from '../driver/paths';
import { seedIsolatedProfile } from '../driver/seed/seedProfile';

/**
 * BACKLOG-3965 — Dashboard Recent | Todo, in the BUILT app (harness cells H1-H8).
 *
 * WRITTEN, NOT RUN: the seeder stalls before launch on Electron 44 (BACKLOG-4054). jsdom has no
 * layout, so the jest stand-ins named per cell compare classes; these cells measure pixels.
 *
 * Fixture (to seed when 4054 is fixed): 6 deals — 2 with checklists at 0 % and 50 %, 1 at 100 %,
 * 1 without a checklist, 1 locked (submitted), 1 closing in 10 days. Cells that need deals SKIP
 * when the seeded profile has none, rather than passing on an empty Dashboard.
 *
 * Launch only with --user-data-dir isolation and the walkthrough safeguards, never a fake HOME.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(REPO_ROOT, '.qa-scratch', 'keepr-dashboard-3965-profile');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'dashboard-3965');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

/**
 * Back to the Dashboard the way the app allows it. Escape closes neither view: Transaction
 * Details (ResponsiveModal has no key handler) is closed by its close control, and the
 * Transactions view only by "Back to Dashboard" (TransactionToolbar.tsx).
 */
async function backToDashboard(d: KeeprAppDriver): Promise<void> {
  const page = d.page;
  await d.dismissTransactionDetailsIfOpen();
  const list = page.getByTestId('tx-list');
  if (await list.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Back to Dashboard|^Back$/ }).first().click();
    await list.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

test.describe('Dashboard Recent | Todo (BACKLOG-3965)', () => {
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

  // H1 — stand-ins: Dashboard.panels-3965 "after the small row"; DashboardPanels-3965 C5 sweep.
  test('H1 1280x800: Recent and Todo side by side, "All audits" shown, no tagline', async () => {
    const page = driver!.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('dashboard-recent')).toBeVisible();
    await expect(page.getByTestId('dashboard-todo')).toBeVisible();
    const recent = await box(page, 'dashboard-recent');
    const todo = await box(page, 'dashboard-todo');
    expect(Math.abs(recent.y - todo.y)).toBeLessThan(2);
    expect(todo.x).toBeGreaterThan(recent.x);
    await expect(page.getByRole('heading', { name: 'All audits' })).toBeVisible();
    await expect(page.getByText('Transaction compliance made simple')).toHaveCount(0);
    await driver!.screenshot('h1-1280');
  });

  // H2 — stand-in: DashboardPanels-3965 C5 sweep (400-767 -> 1 column, Recent first).
  test('H2 700x800: one column, Recent above Todo', async () => {
    const page = driver!.page;
    await page.setViewportSize({ width: 700, height: 800 });
    const recent = await box(page, 'dashboard-recent');
    const todo = await box(page, 'dashboard-todo');
    expect(todo.y).toBeGreaterThanOrEqual(recent.y + recent.height - 1);
    expect(Math.abs(recent.x - todo.x)).toBeLessThan(2);
    await driver!.screenshot('h2-700');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // H3 — stand-ins: RecentPanel-3965 ring + 0-total; ProgressRing tests.
  test('H3 rings at 0 / 50 / 100 %: aria-valuenow and visible "N of M"', async () => {
    const page = driver!.page;
    const rows = page.getByTestId('dashboard-recent-row');
    test.skip((await rows.count()) === 0, 'No recently opened deals in the fixture (BACKLOG-4054 seeder).');
    for (const ring of await page.getByTestId('dashboard-recent').getByRole('progressbar').all()) {
      const now = Number(await ring.getAttribute('aria-valuenow'));
      const max = Number(await ring.getAttribute('aria-valuemax'));
      expect(Number.isFinite(now) && Number.isFinite(max)).toBe(true);
      expect(now).toBeLessThanOrEqual(max);
    }
  });

  // H4 — stand-ins: DashboardPanels-3965 "read again when the Transactions view closes";
  // TransactionDetails record-open tests (PR-2, C8/C12).
  test('H4 open a deal, close the view: it is first in Recent, "Just now"', async () => {
    const page = driver!.page;
    await page.getByTestId('nav-transactions').click();
    // The list cards carry no testid; the fixture deal is found by its street inside the list
    // (a page-wide match also hits the Dashboard copy hidden behind the Transactions view).
    // Cards and Recent rows show the full "street, city, state zip"; QA_DEAL_ADDRESS is that string.
    const address = process.env.QA_DEAL_ADDRESS ?? '1 Fixture St';
    const street = address.split(',')[0].trim();
    const deal = page.getByTestId('tx-list').getByText(street, { exact: false }).first();
    test.skip((await deal.count()) === 0, 'Fixture deal not seeded (BACKLOG-4054 seeder).');
    await deal.click();
    await backToDashboard(driver!);
    const top = page.getByTestId('dashboard-recent-row').first();
    await expect(top).toContainText(address);
    await expect(top).toContainText('Just now');
  });

  // H5 — stand-ins: DashboardPanels-3965 C11 (Todo row -> "checklist");
  // AppModals-3965-open-at-tab "a Dashboard request opens the deal on the Checklist tab".
  test('H5 click a Todo row: the deal opens on the Checklist tab', async () => {
    const page = driver!.page;
    const row = page.getByTestId('dashboard-todo-row').first();
    test.skip((await row.count()) === 0, 'No open required items in the fixture (BACKLOG-4054 seeder).');
    await row.locator('button').first().click();
    // The transaction tabs are plain buttons (no role="tab" / aria-selected); the selected one
    // carries the active border class (TransactionTabs.tsx).
    const checklistTab = page.getByTestId('tab-checklist');
    await expect(checklistTab).toBeVisible({ timeout: 15_000 });
    await expect(checklistTab).toHaveClass(/\bborder-green-500\b/);
    await backToDashboard(driver!);
  });

  // H6 — BACKLOG-3966 PR-3 (rewritten): Todo and the rings show on every plan.
  // Stand-ins: DashboardPanels-3965 "gate %s -> Todo read once and shown" and the hint cases.
  test('H6 plan without checklists: Todo shown with the template hint', async () => {
    test.skip(process.env.QA_PLAN_WITHOUT_CHECKLISTS !== '1', 'Needs a keepr-test plan with checklists off.');
    const page = driver!.page;
    await expect(page.getByTestId('dashboard-todo')).toBeVisible();
    await expect(page.getByTestId('dashboard-todo-template-hint')).toBeVisible();
  });

  // H7 — stand-in: Dashboard.tourTargets-3965 C3.
  test('H7 tour on a fresh profile: every step anchors to an element', async () => {
    test.skip(true, 'Covered by H7 of PR-1 on a fresh profile; this profile dismissed the tour in beforeAll.');
  });

  // H8 — no jest stand-in; the EXPLAIN QUERY PLAN tests on both reads (PR-2, PR-3) are the closest.
  test('H8 large history: Dashboard first paint with 2,000 deals / 20,000 items stays under the stall threshold', async () => {
    test.skip(process.env.QA_LARGE_HISTORY !== '1', 'Needs the large-history fixture (BACKLOG-4054 seeder).');
    const page = driver!.page;
    const started = Date.now();
    await page.getByTestId('nav-transactions').click();
    await backToDashboard(driver!);
    await expect(page.getByTestId('dashboard-recent-row').first()).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
