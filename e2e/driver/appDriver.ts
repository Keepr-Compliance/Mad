import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { launch, type LaunchHandle } from './launch';
import { defaultUserDataDir, resolveExecutable } from './paths';
import {
  Exporter,
  Filter,
  Onboarding,
  StateMarkers,
  Testids,
  TourActions,
  TourMarkers,
  Transactions,
  TX_ROW_PREFIX,
} from './selectors';
import type {
  AppDriver,
  AppDriverOptions,
  AppState,
  ClickFirstTransactionResult,
  ExportOptions,
  ExportResult,
  LaunchStrategy,
  OnboardingOptions,
  TransactionsListState,
} from './types';

/** Default wait for a testid to appear before we treat it as missing (→ HARNESS_ERROR upstream). */
const TESTID_WAIT_MS = 15_000;

/**
 * Reusable Playwright-Electron driver for the packaged Keepr app (BACKLOG-1849).
 * Exposes the awaitable steps the H1 ceremony runner sequences:
 *   boot → onboarding → navigate transaction → toggle filter → trigger export.
 */
export class KeeprAppDriver implements AppDriver {
  private handle!: LaunchHandle;
  private readonly opts: AppDriverOptions;
  private readonly repoRoot: string;
  private sessionReused: boolean | undefined;

  private constructor(repoRoot: string, opts: AppDriverOptions) {
    this.repoRoot = repoRoot;
    this.opts = opts;
  }

  static async launch(repoRoot: string, opts: AppDriverOptions = {}): Promise<KeeprAppDriver> {
    const driver = new KeeprAppDriver(repoRoot, opts);
    // The 'unpackaged' strategy (BACKLOG-1940) runs the node_modules electron binary against the
    // built dist-electron entry — it does NOT need a packaged .app, so skip resolveExecutable
    // (which would throw when no packaged build exists). launchUnpackaged resolves its own binary.
    const optsWithRoot: AppDriverOptions = { ...opts, repoRoot: opts.repoRoot ?? repoRoot };
    const executablePath = opts.strategy === 'unpackaged' ? '' : resolveExecutable(repoRoot, opts.executablePath);
    driver.handle = await launch(executablePath, optsWithRoot);
    await driver.waitForFirstPaint();
    // BACKLOG-1940: bring the window to the FRONT on launch so a headful run is visibly on top
    // (the founder must be able to see it). Best-effort + non-fatal.
    await driver.bringToFront();
    // Capture the very first observable state so session-reuse can be asserted later.
    const initialState = await driver.detectState();
    driver.sessionReused = initialState === 'ready';
    return driver;
  }

  get page(): Page {
    return this.handle.page;
  }

  get app(): ElectronApplication | undefined {
    return this.handle.app;
  }

  get strategy(): LaunchStrategy {
    return this.handle.strategy;
  }

  userDataDir(): string {
    if (this.handle.userDataDir.startsWith('<')) return defaultUserDataDir();
    return this.handle.userDataDir;
  }

  async waitForFirstPaint(timeoutMs = 30_000): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    await this.page.locator('#root').waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => undefined);
  }

  async detectState(): Promise<AppState> {
    // Strongest READY signal (BACKLOG-1940): a dashboard nav testid is present. Check this FIRST —
    // it is a stable, unambiguous marker of the ready main app (the old text markers could miss the
    // dashboard, whose copy is "New Audit"/"All Audits", not "Transactions").
    if (await this.isTestidVisible(Testids.navTransactions)) return 'ready';
    if (await this.isTestidVisible(Testids.navNewAudit)) return 'ready';
    // Onboarding markers take priority over text-based ready markers: a "Connect"/"Get Started"
    // screen up means we are not ready.
    for (const re of StateMarkers.onboardingText) {
      if (await this.hasVisibleText(re)) return 'onboarding';
    }
    for (const re of StateMarkers.readyText) {
      if (await this.hasVisibleText(re)) return 'ready';
    }
    return 'unknown';
  }

  /** True if a testid is currently visible (non-throwing). */
  private async isTestidVisible(testid: string): Promise<boolean> {
    return this.page
      .getByTestId(testid)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * Wait until the READY dashboard is actually rendered (a nav testid is visible), polling up to
   * timeoutMs. Distinguishes a slow-but-ready app (resolves true) from one STUCK on a transient
   * screen like "Verifying your account…" (resolves false). Non-throwing; the caller decides how to
   * classify a false (→ HARNESS_ERROR). SINGLE bounded wait — no relaunch.
   */
  async waitForReady(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isTestidVisible(Testids.navTransactions)) return true;
      if (await this.isTestidVisible(Testids.navNewAudit)) return true;
      await this.page.waitForTimeout(500);
    }
    return false;
  }

  async isSessionReused(): Promise<boolean> {
    return this.sessionReused ?? (await this.detectState()) === 'ready';
  }

  async completeOnboarding(opts: OnboardingOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const skip = opts.skip ?? true;
    const deadline = Date.now() + timeoutMs;

    // Fast path: session reuse already landed us on the ready app.
    if ((await this.detectState()) === 'ready') return;

    while (Date.now() < deadline) {
      if ((await this.detectState()) === 'ready') return;

      // Phone-type gate — PREFER the BACKLOG-1940 testid (this is the exact card that stalled the
      // demo on a role/text guess); fall back to role only if the testid is somehow absent.
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingPhoneIphone))) continue;
      if (await this.clickIfPresent(this.byRole(Onboarding.phoneTypeIphone.role, Onboarding.phoneTypeIphone.name))) {
        continue;
      }
      // Email connect: only click a provider when NOT skipping (OAuth needs a human / stubbing).
      if (!skip && opts.provider) {
        const providerTestid =
          opts.provider === 'gmail' || opts.provider === 'outlook' ? Testids.onboardingEmailConnectPrimary : undefined;
        if (providerTestid && (await this.clickIfPresent(this.page.getByTestId(providerTestid)))) continue;
        const provider = opts.provider === 'gmail' ? Onboarding.connectGmail : Onboarding.connectOutlook;
        if (await this.clickIfPresent(this.byRole(provider.role, provider.name))) continue;
      }
      // Prefer Skip when skipping (testid first), otherwise Continue (testid first).
      if (skip && (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingSkip)))) continue;
      if (skip && (await this.clickIfPresent(this.byRole(Onboarding.skip.role, Onboarding.skip.name)))) continue;
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingContinue))) continue;
      // Some steps render their OWN continue (secure-storage / contacts) — try those testids too.
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingSecureStorageContinue))) continue;
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingContactsContinue))) continue;
      if (await this.clickIfPresent(this.byRole(Onboarding.continue.role, Onboarding.continue.name))) continue;

      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `[keepr-e2e] completeOnboarding did not reach the ready state within ${timeoutMs}ms (last state: ${await this.detectState()}).`,
    );
  }

  /**
   * BACKLOG-1940: bring the app window to the front + focus it. Best-effort and NON-FATAL —
   * every call is wrapped so a foreground failure can never fail a test step. Uses
   * page.bringToFront() (works for both strategies) and, on macOS, an `osascript activate`
   * so a headful run is genuinely on top of other windows.
   */
  async bringToFront(): Promise<void> {
    await this.page.bringToFront().catch(() => undefined);
    if (process.platform === 'darwin') {
      await activateMacApp('Keepr').catch(() => undefined);
    }
  }

  async dismissTour(): Promise<boolean> {
    // The react-joyride feature tour renders ASYNCHRONOUSLY after the dashboard mounts, and its
    // full-screen overlay (.react-joyride__overlay) intercepts pointer events on the nav until it
    // is dismissed. So wait a BOUNDED time for the tour to appear (intro copy OR the joyride
    // portal), rather than a single immediate check that can race ahead of the tour. Still a single
    // bounded wait — no relaunch.
    const tourWaitMs = 8_000;
    const deadline = Date.now() + tourWaitMs;
    let tourVisible = false;
    while (Date.now() < deadline) {
      const introVisible = await this.page.getByText(TourMarkers.visibleText).first().isVisible().catch(() => false);
      const portalPresent = await this.page.locator('#react-joyride-portal').first().isVisible().catch(() => false);
      if (introVisible || portalPresent) {
        tourVisible = true;
        break;
      }
      await this.page.waitForTimeout(400);
    }
    if (!tourVisible) return false;

    // react-joyride renders its Skip control with data-action="skip" (its stable contract).
    const skip = this.page.locator(TourActions.skip).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click().catch(() => undefined);
      // Wait for the joyride overlay to actually tear down before returning (so the next nav click
      // is not intercepted). Bounded + non-fatal.
      await this.page
        .locator('.react-joyride__overlay')
        .first()
        .waitFor({ state: 'hidden', timeout: 5_000 })
        .catch(() => undefined);
      await this.page.waitForTimeout(400);
      return true;
    }
    return false;
  }

  async gotoSettings(): Promise<void> {
    // profile avatar (nav-profile) → Profile modal → Settings button (nav-settings) → settings-page.
    await this.clickTestidOrThrow(Testids.navProfile, 'gotoSettings: open profile menu');
    await this.clickTestidOrThrow(Testids.navSettings, 'gotoSettings: click Settings');
    await this.waitTestidOrThrow(Testids.settingsPage, 'gotoSettings: settings page did not render');
  }

  async closeSettings(): Promise<void> {
    // The Settings surface auto-opens an "AI Features - Data Processing Consent" modal on first
    // load (LLMSettings shows it when consent has not been given). It is a z-[60] overlay that
    // intercepts pointer events on the dashboard nav, and it does NOT respond to Escape — so
    // dismiss it explicitly via its Cancel button first. Best-effort + non-fatal.
    const cancel = this.page.getByRole('button', { name: /^Cancel$/ }).first();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(200);

    // NOTE: there are TWO settings-close buttons (mobile `sm:hidden` + desktop `hidden sm:flex`);
    // `.first()` would pick the HIDDEN mobile one at a desktop viewport, so click the VISIBLE one.
    const close = this.page.getByTestId(Testids.settingsClose).locator('visible=true').first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => undefined);
    }
    // Wait for the settings-page marker to detach so the dashboard nav is interactable again.
    await this.page
      .getByTestId(Testids.settingsPage)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
    // Belt-and-suspenders: wait for any remaining full-screen modal backdrop to clear so the
    // dashboard nav is actually clickable (a leftover overlay would intercept pointer events).
    await this.page
      .locator('.fixed.inset-0.bg-black')
      .first()
      .waitFor({ state: 'hidden', timeout: 5_000 })
      .catch(() => undefined);
  }

  async gotoTransactions(): Promise<void> {
    await this.clickTestidOrThrow(Testids.navTransactions, 'gotoTransactions: open transactions');
    // tx-list is ALWAYS rendered on the transactions view (empty or not). Its absence is a
    // harness/app-shape problem — surfaced by throwing here, classified as HARNESS_ERROR upstream.
    await this.waitTestidOrThrow(Testids.txList, 'gotoTransactions: tx-list container did not render');
  }

  async readTransactionsList(): Promise<TransactionsListState> {
    const list = this.page.getByTestId(Testids.txList).first();
    const present = await list.isVisible().catch(() => false);
    if (!present) {
      // DO NOT infer "0 transactions" here — that would be a false FAIL. Report absence honestly.
      return { present: false, empty: false, rowCount: 0 };
    }
    const empty = await this.page
      .getByTestId(Testids.txEmpty)
      .first()
      .isVisible()
      .catch(() => false);
    // Count tx-row-{index} rows by their shared prefix. On a correctly-empty list this is 0.
    const rowCount = await this.page.locator(`[data-testid^="${TX_ROW_PREFIX}"]`).count();
    return { present: true, empty, rowCount };
  }

  async clickFirstTransaction(): Promise<ClickFirstTransactionResult> {
    const state = await this.readTransactionsList();
    if (!state.present) {
      // Absence of the list is NOT "empty" — let the caller classify it as HARNESS_ERROR.
      throw new Error('[keepr-e2e] clickFirstTransaction: tx-list not found (app-shape/harness problem, not empty)');
    }
    if (state.empty || state.rowCount === 0) {
      // A correctly-empty list: nothing to click. This is a CLEAN, correct outcome (PASS), not an error.
      return { clicked: false, empty: true };
    }
    const first = this.page.getByTestId(Testids.txRow(0)).first();
    await first.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    await first.click();
    return { clicked: true, empty: false };
  }

  async gotoTransaction(query: string): Promise<void> {
    const sel = Transactions.cardByAddress(query);
    const heading = this.byRole(sel.role, sel.name);
    await heading.first().waitFor({ state: 'visible', timeout: 30_000 });
    await heading.first().click();
    // The email tab (with the filter toggle) is the anchor for downstream steps.
    await this.filterToggle()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
  }

  /**
   * The address-filter toggle. BACKLOG-1950: `address-filter-toggle` is rendered TWICE in
   * TransactionEmailsTab (the empty-state row AND the populated-list row), plus mobile/desktop
   * copies can exist — so `getByTestId(...).first()` could resolve a HIDDEN instance. Select the
   * VISIBLE one (matching the clickTestidOrThrow pattern), so a missing toggle surfaces as a
   * HARNESS_ERROR upstream rather than a click on an off-screen node.
   */
  private filterToggle(): Locator {
    return this.page.getByTestId(Filter.addressToggleTestId).locator('visible=true').first();
  }

  /** Count of currently-VISIBLE address-filter toggles (should be exactly 1 on the emails tab). */
  async visibleAddressToggleCount(): Promise<number> {
    return this.page.getByTestId(Filter.addressToggleTestId).locator('visible=true').count();
  }

  async getAddressFilterState(): Promise<boolean> {
    const toggle = this.filterToggle();
    await toggle.waitFor({ state: 'visible', timeout: 15_000 });
    // Read a STABLE aria-checked: two identical consecutive reads (the emails tab can briefly
    // re-render between its empty-state and populated-list toggle instances). Avoids reading a
    // transient value mid-transition, which caused a rare "Received false" flake in serial runs.
    let prev = await toggle.getAttribute('aria-checked');
    for (let i = 0; i < 5; i++) {
      await this.page.waitForTimeout(150);
      const cur = await this.filterToggle().getAttribute('aria-checked');
      if (cur !== null && cur === prev) return cur === 'true';
      prev = cur;
    }
    return prev === 'true';
  }

  async setAddressFilter(on: boolean): Promise<void> {
    const current = await this.getAddressFilterState();
    if (current === on) return; // idempotent
    await this.filterToggle().click();
    // Confirm the state actually flipped on the VISIBLE toggle (there may be a hidden twin).
    await this.page
      .waitForFunction(
        ({ testid, want }) => {
          const els = Array.from(document.querySelectorAll(`[data-testid="${testid}"]`));
          const visible = els.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return visible?.getAttribute('aria-checked') === (want ? 'true' : 'false');
        },
        { testid: Filter.addressToggleTestId, want: on },
        { timeout: 10_000 },
      )
      .catch(() => undefined);
  }

  async triggerExport(opts: ExportOptions = {}): Promise<ExportResult> {
    const format = opts.format ?? 'folder';
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let nativeDialogStubbed = false;

    // For folder export under the electron strategy, stub the native picker so the export
    // completes headlessly to a known destination. The 'cdp' strategy cannot reach main.
    if (format === 'folder' && opts.destDir) {
      if (this.app) {
        await this.stubFolderDialog(this.app, opts.destDir);
        nativeDialogStubbed = true;
      }
    }

    await this.byRole(Exporter.exportButton.role, Exporter.exportButton.name).first().click();

    // Fill date fields if provided (ExportModal step 1).
    const dateInputs = this.page.locator(Exporter.modalDateInputs);
    if (opts.startDate && (await dateInputs.count()) > 0) {
      await dateInputs.nth(0).fill(opts.startDate).catch(() => undefined);
      if (opts.endDate) await dateInputs.nth(1).fill(opts.endDate).catch(() => undefined);
    }

    // Confirm export (second "Export" — inside the modal).
    const confirm = this.byRole(Exporter.modalExportConfirm.role, Exporter.modalExportConfirm.name);
    const confirmCount = await confirm.count();
    if (confirmCount > 1) await confirm.nth(1).click().catch(() => undefined);
    else await confirm.first().click().catch(() => undefined);

    const completed = await this.hasVisibleText(Exporter.completionText, timeoutMs).catch(() => false);

    return { triggered: true, format, destDir: opts.destDir, nativeDialogStubbed, completed };
  }

  async screenshot(name: string): Promise<Buffer> {
    const dir = this.opts.artifactsDir ?? join(this.repoRoot, 'e2e', '.artifacts');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const buf = await this.page.screenshot();
    const file = join(dir, `${name.replace(/[^a-z0-9-_]/gi, '_')}.png`);
    writeFileSync(file, buf);
    return buf;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  /**
   * Deterministic teardown for SERIAL specs (BACKLOG-1950): graceful window.close → app.close →
   * WAIT for the Electron main process (and its helpers) to actually EXIT before returning, so the
   * NEXT test never launches a second overlapping instance (single-instance discipline). Playwright's
   * app.close() resolves before the OS process is fully gone; we additionally await the process exit.
   * Best-effort + non-fatal: teardown must never throw and fail an otherwise-passing test.
   */
  async closeAndWait(timeoutMs = 15_000): Promise<void> {
    // 1. Ask the renderer to close its window first (avoids a "Reason: killed" crash dialog).
    await this.page
      .evaluate(() => (window as unknown as { close?: () => void }).close?.())
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    // 2. Grab the underlying process (unpackaged strategy exposes ElectronApplication.process()).
    const proc = this.app?.process?.();

    // 3. Close via Playwright, then WAIT for the OS process to actually exit.
    await this.handle.close().catch(() => undefined);

    if (proc && proc.exitCode === null && proc.pid) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        proc.once('exit', done);
        proc.once('close', done);
        // Fallback: poll + hard-kill if it lingers past the budget.
        const deadline = Date.now() + timeoutMs;
        const tick = setInterval(() => {
          if (proc.exitCode !== null || Date.now() > deadline) {
            clearInterval(tick);
            if (proc.exitCode === null && proc.pid) {
              try {
                process.kill(proc.pid, 'SIGKILL');
              } catch {
                /* already gone */
              }
            }
            resolve();
          }
        }, 250);
      });
    }
    // 4. Small settle so helper processes fully release the profile + focus before the next launch.
    await new Promise((r) => setTimeout(r, 500));
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Wait for a testid to be visible, then click it. If the testid never appears, THROW with an
   * actionable message. Callers let this propagate so the runner classifies it as a HARNESS_ERROR
   * (a missing testid = the harness could not proceed) — never a silent no-op or a false FAIL.
   */
  private async clickTestidOrThrow(testid: string, context: string): Promise<void> {
    // Prefer the VISIBLE match — several testids are duplicated for mobile (`sm:hidden`) and desktop
    // (`hidden sm:flex`) layouts, so `.first()` could resolve to the hidden variant.
    const loc = this.page.getByTestId(testid).locator('visible=true').first();
    try {
      await loc.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(`[keepr-e2e] ${context}: testid "${testid}" not found (selector-not-found / app-shape changed).`);
    }
    await loc.click();
  }

  /** Wait for a testid to be visible; THROW (→ HARNESS_ERROR upstream) if it never appears. */
  private async waitTestidOrThrow(testid: string, context: string): Promise<void> {
    try {
      await this.page.getByTestId(testid).locator('visible=true').first().waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(`[keepr-e2e] ${context}: testid "${testid}" not found (selector-not-found / app-shape changed).`);
    }
  }

  private byRole(role: string, name: RegExp): Locator {
    // Playwright's getByRole accepts a limited AriaRole union; cast is safe for our known roles.
    return this.page.getByRole(role as Parameters<Page['getByRole']>[0], { name });
  }

  private async hasVisibleText(re: RegExp, timeoutMs = 0): Promise<boolean> {
    const loc = this.page.getByText(re).first();
    if (timeoutMs > 0) {
      return loc
        .waitFor({ state: 'visible', timeout: timeoutMs })
        .then(() => true)
        .catch(() => false);
    }
    return loc.isVisible().catch(() => false);
  }

  private async clickIfPresent(loc: Locator): Promise<boolean> {
    const target = loc.first();
    if (await target.isVisible().catch(() => false)) {
      await target.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
      return true;
    }
    return false;
  }

  /** Override main-process dialog.showOpenDialog to auto-return destDir (electron strategy only). */
  private async stubFolderDialog(app: ElectronApplication, destDir: string): Promise<void> {
    await app.evaluate(async ({ dialog }, dir) => {
      const fake = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: false, filePaths: [dir] });
      // Runtime override of Electron dialog in the main process so folder export completes headlessly.
      (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
    }, destDir);
  }
}

/**
 * macOS-only: bring the named app to the foreground via AppleScript. Best-effort — the promise
 * resolves whether or not activation succeeds; callers wrap it in .catch() so it is never fatal.
 * Uses execFile (no shell) with a fixed arg list, so the app name can never be shell-interpreted.
 */
function activateMacApp(appName: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "${appName}" to activate`], { timeout: 4000 }, () => resolve());
  });
}
