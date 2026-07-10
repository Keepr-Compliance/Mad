import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { launch, type LaunchHandle } from './launch';
import { defaultUserDataDir, resolveExecutable } from './paths';
import { Exporter, Filter, Onboarding, StateMarkers, Transactions } from './selectors';
import type {
  AppDriver,
  AppDriverOptions,
  AppState,
  ExportOptions,
  ExportResult,
  LaunchStrategy,
  OnboardingOptions,
} from './types';

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
    const executablePath = resolveExecutable(repoRoot, opts.executablePath);
    driver.handle = await launch(executablePath, opts);
    await driver.waitForFirstPaint();
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
    // Onboarding markers take priority: if a "Connect"/"Get Started" screen is up, we are not ready.
    for (const re of StateMarkers.onboardingText) {
      if (await this.hasVisibleText(re)) return 'onboarding';
    }
    for (const re of StateMarkers.readyText) {
      if (await this.hasVisibleText(re)) return 'ready';
    }
    return 'unknown';
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

      // Phone-type gate.
      if (await this.clickIfPresent(this.byRole(Onboarding.phoneTypeIphone.role, Onboarding.phoneTypeIphone.name))) {
        continue;
      }
      // Email connect: only click a provider when NOT skipping (OAuth needs a human / stubbing).
      if (!skip && opts.provider) {
        const provider = opts.provider === 'gmail' ? Onboarding.connectGmail : Onboarding.connectOutlook;
        if (await this.clickIfPresent(this.byRole(provider.role, provider.name))) continue;
      }
      // Prefer Skip when skipping; otherwise Continue.
      if (skip && (await this.clickIfPresent(this.byRole(Onboarding.skip.role, Onboarding.skip.name)))) continue;
      if (await this.clickIfPresent(this.byRole(Onboarding.continue.role, Onboarding.continue.name))) continue;

      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `[keepr-e2e] completeOnboarding did not reach the ready state within ${timeoutMs}ms (last state: ${await this.detectState()}).`,
    );
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

  private filterToggle(): Locator {
    const byTestId = this.page.getByTestId(Filter.addressToggleTestId);
    return byTestId;
  }

  async getAddressFilterState(): Promise<boolean> {
    const toggle = this.filterToggle();
    await toggle.waitFor({ state: 'visible', timeout: 15_000 });
    const checked = await toggle.getAttribute('aria-checked');
    return checked === 'true';
  }

  async setAddressFilter(on: boolean): Promise<void> {
    const current = await this.getAddressFilterState();
    if (current === on) return; // idempotent
    await this.filterToggle().click();
    // Confirm the state actually flipped.
    await this.page
      .waitForFunction(
        ({ testid, want }) => {
          const el = document.querySelector(`[data-testid="${testid}"]`);
          return el?.getAttribute('aria-checked') === (want ? 'true' : 'false');
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

  // ---- internals ----------------------------------------------------------

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
