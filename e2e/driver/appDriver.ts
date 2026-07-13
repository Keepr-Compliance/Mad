import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { ActionLogger, DOM_CAPTURE_INIT_SCRIPT, type ActionVerb } from './actionLog';
import { launch, type LaunchHandle } from './launch';
import { defaultUserDataDir, resolveExecutable } from './paths';
import {
  AttachEmails,
  Contacts,
  ContactsModule,
  CreateAudit,
  DeleteEmails,
  DeleteTransactions,
  Exporter,
  Filter,
  Nav,
  Onboarding,
  StateMarkers,
  Testids,
  TourActions,
  TourMarkers,
  TransactionDetailsView,
  Transactions,
  TxList,
  TX_ROW_PREFIX,
} from './selectors';
import type {
  AppDriver,
  AppDriverOptions,
  AppState,
  ClickFirstTransactionResult,
  CreateAuditInput,
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
  /** BACKLOG-1969: logs driver INTENT (before each action) + re-emits DOM-event REALITY lines. */
  private readonly actionLog: ActionLogger;

  private constructor(repoRoot: string, opts: AppDriverOptions) {
    this.repoRoot = repoRoot;
    this.opts = opts;
    this.actionLog = new ActionLogger();
  }

  static async launch(repoRoot: string, opts: AppDriverOptions = {}): Promise<KeeprAppDriver> {
    const driver = new KeeprAppDriver(repoRoot, opts);
    // The 'unpackaged' strategy (BACKLOG-1940) runs the node_modules electron binary against the
    // built dist-electron entry — it does NOT need a packaged .app, so skip resolveExecutable
    // (which would throw when no packaged build exists). launchUnpackaged resolves its own binary.
    const optsWithRoot: AppDriverOptions = { ...opts, repoRoot: opts.repoRoot ?? repoRoot };
    const executablePath = opts.strategy === 'unpackaged' ? '' : resolveExecutable(repoRoot, opts.executablePath);
    driver.handle = await launch(executablePath, optsWithRoot);
    // BACKLOG-1969: install DOM-event capture + capture the renderer console BEFORE first paint so
    // every real pointerover/mousedown/click is logged as "reality" next to the driver's "intent".
    // Best-effort + non-fatal — observability must never break a launch.
    await driver.installActionLogging();
    await driver.waitForFirstPaint();
    // BACKLOG-1940 / BACKLOG-1971: bring the window to the FRONT on launch so a headful run is
    // visibly on top (the founder must be able to see it) — this is UNCONDITIONAL in the driver's
    // own launch, so NO run (including a custom drive script) can be accidentally invisible. It is
    // NOT a per-caller opt-in. Best-effort + non-fatal.
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
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingPhoneIphone), Testids.onboardingPhoneIphone)) continue;
      if (await this.clickIfPresent(this.byRole(Onboarding.phoneTypeIphone.role, Onboarding.phoneTypeIphone.name), 'role=button:iPhone')) {
        continue;
      }
      // Email connect: only click a provider when NOT skipping (OAuth needs a human / stubbing).
      if (!skip && opts.provider) {
        const providerTestid =
          opts.provider === 'gmail' || opts.provider === 'outlook' ? Testids.onboardingEmailConnectPrimary : undefined;
        if (providerTestid && (await this.clickIfPresent(this.page.getByTestId(providerTestid), providerTestid))) continue;
        const provider = opts.provider === 'gmail' ? Onboarding.connectGmail : Onboarding.connectOutlook;
        if (await this.clickIfPresent(this.byRole(provider.role, provider.name), `role=button:connect-${opts.provider}`)) continue;
      }
      // Prefer Skip when skipping (testid first), otherwise Continue (testid first).
      if (skip && (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingSkip), Testids.onboardingSkip))) continue;
      if (skip && (await this.clickIfPresent(this.byRole(Onboarding.skip.role, Onboarding.skip.name), 'role=button:skip'))) continue;
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingContinue), Testids.onboardingContinue)) continue;
      // Some steps render their OWN continue (secure-storage / contacts) — try those testids too.
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingSecureStorageContinue), Testids.onboardingSecureStorageContinue)) continue;
      if (await this.clickIfPresent(this.page.getByTestId(Testids.onboardingContactsContinue), Testids.onboardingContactsContinue)) continue;
      if (await this.clickIfPresent(this.byRole(Onboarding.continue.role, Onboarding.continue.name), 'role=button:continue')) continue;

      await this.page.waitForTimeout(500);
    }
    throw new Error(
      `[keepr-e2e] completeOnboarding did not reach the ready state within ${timeoutMs}ms (last state: ${await this.detectState()}).`,
    );
  }

  /**
   * BACKLOG-1940 / BACKLOG-1971: bring the app window to the front + focus it. Called
   * UNCONDITIONALLY from the driver's own launch (see static launch()), so NO run — including a
   * custom drive script — can be accidentally invisible; foregrounding is NOT a per-caller opt-in.
   *
   * Three layers, each best-effort and NON-FATAL (wrapped so a foreground failure can never fail a
   * step): (1) page.bringToFront() (works for both strategies), (2) the main-process
   * BrowserWindow.focus({steal:true}) + show()/moveTop() via the Electron app handle (steals OS
   * focus on the 'electron'/'unpackaged' strategies), and (3) on macOS an `osascript activate` so a
   * headful run is genuinely on top of other windows.
   */
  async bringToFront(): Promise<void> {
    await this.page.bringToFront().catch(() => undefined);
    // Main-process focus: the ElectronApplication handle (present for electron/unpackaged) lets us
    // steal OS focus, which page.bringToFront() alone does not guarantee for a background-launched app.
    if (this.app) {
      await this.app
        .evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.moveTop();
            win.focus();
          }
        })
        .catch(() => undefined);
    }
    if (process.platform === 'darwin') {
      await activateMacApp('Keepr').catch(() => undefined);
    }
  }

  /**
   * BACKLOG-1971: hover an element by testid, logging the `[driver-action] … hover testid=<t> …`
   * INTENT line (via the shared ActionLogger) BEFORE the Playwright hover so the driver's intent
   * sits next to the DOM's `[dom-event] pointerover …` reality. `label` overrides the logged target
   * (e.g. a role/data-action descriptor when the element has no testid). Resolves the VISIBLE match
   * (testids are duplicated for mobile/desktop). Throws (→ HARNESS_ERROR upstream) if it never appears.
   */
  async hover(testid: string, label?: string): Promise<void> {
    const loc = await this.resolveVisibleTestid(testid, `hover: testid "${testid}"`);
    await this.logIntent('hover', label ?? testid, loc);
    await loc.hover();
  }

  /**
   * BACKLOG-1971: press (click) an element by testid, logging the `[driver-action] … press
   * testid=<t> …` INTENT line (via the shared ActionLogger) BEFORE the Playwright click so intent
   * sits next to the DOM's `[dom-event] click …` reality. `label` overrides the logged target.
   * Resolves the VISIBLE match. Throws (→ HARNESS_ERROR upstream) if the testid never appears — it
   * never silently no-ops. (This is the public, logged sibling of the internal clickTestidOrThrow.)
   */
  async press(testid: string, label?: string): Promise<void> {
    const loc = await this.resolveVisibleTestid(testid, `press: testid "${testid}"`);
    await this.logIntent('press', label ?? testid, loc);
    await loc.click();
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
      // BACKLOG-1969: log INTENT before dismissing the tour (target = the data-action selector).
      await this.logIntent('press', 'data-action=skip', skip);
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
    // BACKLOG-1948 additive guard: if the transactions view is ALREADY open (tx-list visible) — e.g.
    // the app auto-opened it after creating an audit — the dashboard nav button sits BEHIND that
    // overlay and a click would be intercepted (30s timeout). Since we are already on the list, this
    // is a no-op. This CANNOT affect callers that reach gotoTransactions from the dashboard (e.g. the
    // BACKLOG-1950 filter-toggle cell): there tx-list is NOT yet visible, so the guard is skipped and
    // the nav click proceeds exactly as before.
    if (await this.isTestidVisible(Testids.txList)) return;
    await this.clickTestidOrThrow(Testids.navTransactions, 'gotoTransactions: open transactions');
    // tx-list is ALWAYS rendered on the transactions view (empty or not). Its absence is a
    // harness/app-shape problem — surfaced by throwing here, classified as HARNESS_ERROR upstream.
    await this.waitTestidOrThrow(Testids.txList, 'gotoTransactions: tx-list container did not render');
  }

  /**
   * BACKLOG-1948: dismiss the auto-opened Transaction Details modal so its `fixed inset-0 z-[60]`
   * overlay stops intercepting pointer events on the underlying transactions list. NO-OP when no such
   * modal is open (guarded on the overlay/close-control visibility). Best-effort + non-fatal — a
   * dismiss failure must never fail an otherwise-passing step (the assertions read the DB + the list).
   */
  async dismissTransactionDetailsIfOpen(): Promise<boolean> {
    const close = this.page.getByTestId(TransactionDetailsView.closeTestId).locator('visible=true').first();
    const open = await close.isVisible().catch(() => false);
    if (!open) return false;
    // Escape first (harmless: ResponsiveModal has no key handler, but costs ~nothing), then click the
    // close control (the desktop X / mobile Back — same testid on both).
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.logIntent('press', TransactionDetailsView.closeTestId, close);
    await close.click().catch(() => undefined);
    // Wait for the details overlay to actually detach so the list/nav underneath is interactable.
    await this.page
      .getByTestId(TransactionDetailsView.overlayTestId)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
    return true;
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
    // BACKLOG-1969: log INTENT before opening the transaction card by address.
    await this.logIntent('press', `role=heading:${query}`, heading);
    await heading.first().click();
    // The email tab (with the filter toggle) is the anchor for downstream steps.
    await this.filterToggle()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
  }

  /**
   * BACKLOG-1948: fill a testid'd input via the logged fill path. Resolves the VISIBLE element (inputs
   * are duplicated across mobile/desktop layouts) and logs a `[driver-action] … fill …` INTENT line
   * (via the shared ActionLogger) BEFORE the Playwright fill, so intent sits next to the DOM's
   * `[dom-event] input …` reality. Throws (→ HARNESS_ERROR upstream) if the testid never appears.
   */
  private async fillTestid(testid: string, value: string, context: string): Promise<void> {
    const loc = await this.resolveVisibleTestid(testid, context);
    this.actionLog.intent('fill', testid, value);
    await loc.fill(value);
  }

  async createTransactionViaWizard(input: CreateAuditInput): Promise<void> {
    const role = input.role ?? CreateAudit.clientRoleValue;

    // ---- Open the wizard. nav-new-audit either opens StartNewAuditModal (AI add-on) or goes
    // straight to the AuditTransactionModal (non-AI). Handle BOTH: if the create-manually button
    // appears, press it; otherwise proceed. A missing address input at the end is a HARNESS_ERROR. ----
    await this.clickTestidOrThrow(Testids.navNewAudit, 'createAudit: open New Audit');
    const manualBtn = this.page.getByTestId(CreateAudit.createManuallyTestId).locator('visible=true').first();
    const sawModal = await manualBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (sawModal) {
      await this.logIntent('press', CreateAudit.createManuallyTestId, manualBtn);
      await manualBtn.click();
    }

    // ---- Step 1: Transaction details. Address + start date are the DB-assertion keys; the transaction
    // type defaults to 'purchase' (only flip it if a different type was requested). ----
    await this.waitTestidOrThrow(CreateAudit.addressInputTestId, 'createAudit: step 1 (address) did not render');
    await this.fillTestid(CreateAudit.addressInputTestId, input.address, 'createAudit: fill address');
    // Dismiss any Google-Places autocomplete dropdown so it never intercepts the date/submit clicks
    // (free-text entry only — we never select a suggestion, so no network dependency). Non-fatal.
    await this.page.keyboard.press('Escape').catch(() => undefined);
    if (input.transactionType === 'sale') {
      await this.clickTestidOrThrow(CreateAudit.typeSaleTestId, 'createAudit: select Sale');
    } else if (input.transactionType === 'purchase') {
      await this.clickTestidOrThrow(CreateAudit.typePurchaseTestId, 'createAudit: select Purchase');
    }
    await this.fillTestid(CreateAudit.startDateInputTestId, input.startDate, 'createAudit: fill start date');
    if (input.closedAt) {
      await this.fillTestid(CreateAudit.endDateInputTestId, input.closedAt, 'createAudit: fill end date');
    }
    await this.clickTestidOrThrow(CreateAudit.submitTestId, 'createAudit: continue to step 2');

    // ---- Step 2: Select a contact ID-AGNOSTICALLY (BACKLOG-1948 / BACKLOG-1949) — by visible display
    // name when given, else the FIRST available row — so the cell never depends on a literal seed id
    // (which BACKLOG-1949 converts to a UUID). Then continue. ----
    await this.waitTestidOrThrow(CreateAudit.step2TestId, 'createAudit: step 2 (select contacts) did not render');
    let contactRow: Locator;
    let contactLabel: string;
    if (input.contactName) {
      // The row whose contact-row-name label matches the visible display name.
      contactRow = this.page
        .locator(CreateAudit.contactRowAny)
        .filter({ has: this.page.getByTestId(CreateAudit.contactRowName).filter({ hasText: input.contactName }) })
        .locator('visible=true')
        .first();
      contactLabel = `contact-row:name="${input.contactName}"`;
    } else {
      contactRow = this.page.locator(CreateAudit.contactRowAny).locator('visible=true').first();
      contactLabel = 'contact-row:first';
    }
    try {
      await contactRow.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] createAudit: ${contactLabel} not found in step 2 (selector-not-found / seed missing).`,
      );
    }
    await this.logIntent('press', contactLabel, contactRow);
    await contactRow.click();
    await this.clickTestidOrThrow(CreateAudit.submitTestId, 'createAudit: continue to step 3');

    // ---- Step 3: Assign the Client role to the (single) selected contact, then create. Exactly ONE
    // contact was selected in step 2, so exactly ONE role-select renders — target it by the
    // `role-select-*` PREFIX (ID-agnostic), never by a literal contact id. ----
    await this.waitTestidOrThrow(CreateAudit.step3TestId, 'createAudit: step 3 (assign roles) did not render');
    const roleSelect = this.page.locator(CreateAudit.roleSelectAny).locator('visible=true').first();
    try {
      await roleSelect.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error('[keepr-e2e] createAudit: role select (role-select-*) not found in step 3 (selector-not-found).');
    }
    this.actionLog.intent('fill', CreateAudit.roleSelectAny, role);
    await roleSelect.selectOption(role);
    await this.clickTestidOrThrow(CreateAudit.submitTestId, 'createAudit: create transaction');

    // ---- The modal closes and the app navigates to the transaction on success. Wait for the wizard
    // (its address input) to detach so the caller can then observe the transactions list. A modal that
    // never closes means the create did not succeed — surface it as a HARNESS_ERROR by throwing. ----
    try {
      await this.page
        .getByTestId(CreateAudit.addressInputTestId)
        .first()
        .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error('[keepr-e2e] createAudit: wizard did not close after Create Transaction (create may have failed).');
    }
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
    // BACKLOG-1969: log INTENT before flipping the address filter switch.
    await this.logIntent('press', Filter.addressToggleTestId, this.filterToggle());
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

  // ---- add-users-with-roles flow (BACKLOG-1949) ---------------------------
  //
  // These helpers drive the EditContactsModal 2-screen flow: open it from the overview tab, select
  // seeded contacts in Screen 2, then assign each an explicit role in Screen 1 and Save. All are built
  // on the logged press() + resolveVisibleTestid, so a missing testid surfaces as a HARNESS_ERROR
  // (thrown), never a silent no-op — matching the trust discipline of the filter-toggle cell.

  /**
   * Open the EditContactsModal via the LIVE overview-tab "Edit Contacts" button
   * (BACKLOG-1949 added its testid). Waits for the modal shell (its Save button) to render.
   */
  async openEditContacts(): Promise<void> {
    await this.press(Contacts.editContactsButton, 'edit-contacts-button');
    await this.waitTestidOrThrow(Contacts.saveButton, 'openEditContacts: EditContactsModal did not render');
  }

  /**
   * From the open modal, add the given seeded contacts (by DB id) to the transaction: open Screen 2,
   * click each contact's selection row (targeted by the additive data-contact-id), confirm "Add
   * Selected", then wait for Screen 1 to show each contact's role row. A missing row/button throws
   * (→ HARNESS_ERROR). Uses the empty-state add button when no contacts are assigned yet.
   */
  async addContactsById(contactIds: string[]): Promise<void> {
    // Screen 1 → Screen 2. The empty state uses a different testid than the populated header.
    const emptyAdd = this.page.getByTestId(Contacts.emptyStateAddButton).locator('visible=true').first();
    if (await emptyAdd.isVisible().catch(() => false)) {
      await this.logIntent('press', Contacts.emptyStateAddButton, emptyAdd);
      await emptyAdd.click();
    } else {
      await this.press(Contacts.addContactsButton, 'add-contacts-button');
    }
    await this.waitTestidOrThrow(Contacts.addContactsOverlay, 'addContactsById: Add Contacts overlay did not open');

    // Select each contact by the additive data-contact-id on its ContactRow.
    for (const id of contactIds) {
      const row = this.page.locator(Contacts.selectRowByContactId(id)).locator('visible=true').first();
      try {
        await row.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
      } catch {
        throw new Error(
          `[keepr-e2e] addContactsById: selection row for contact "${id}" not found in Screen 2 (not seeded / not available / app-shape changed).`,
        );
      }
      await this.logIntent('press', `contact-row[${id}]`, row);
      await row.click();
    }

    // Confirm the batch add (desktop "Add Selected"). Resolve the VISIBLE one (mobile twin exists).
    await this.press(Contacts.addSelectedButton, 'add-selected-button');

    // Back on Screen 1: every added contact must now have a role row.
    for (const id of contactIds) {
      await this.waitTestidOrThrow(
        Contacts.contactRoleRow(id),
        `addContactsById: contact "${id}" did not appear as an assigned role row after add`,
      );
    }
  }

  /**
   * Read the currently-selected role (the <select> VALUE, not the display label) for an assigned
   * contact's row. Resolves the VISIBLE role-select (rendered twice: mobile + desktop). Empty string =
   * the "Select role..." unassigned state. Throws (→ HARNESS_ERROR) if the select never appears.
   */
  async readAssignedRole(contactId: string): Promise<string> {
    const sel = await this.resolveVisibleTestid(
      Contacts.roleSelect(contactId),
      `readAssignedRole: role select for "${contactId}"`,
    );
    return (await sel.inputValue()) ?? '';
  }

  /**
   * Assign a role to an assigned contact by selecting the option whose VALUE is `roleValue`
   * (a SPECIFIC_ROLES string, e.g. "escrow_officer" — NOT the display label). Resolves the VISIBLE
   * role-select and confirms the value actually changed. Throws (→ HARNESS_ERROR) if the select is
   * missing; a value that fails to apply is surfaced by the post-condition read in the spec.
   */
  async assignRole(contactId: string, roleValue: string): Promise<void> {
    const sel = await this.resolveVisibleTestid(
      Contacts.roleSelect(contactId),
      `assignRole: role select for "${contactId}"`,
    );
    await this.logIntent('press', `${Contacts.roleSelect(contactId)}=${roleValue}`, sel);
    await sel.selectOption(roleValue);
    await this.page
      .waitForFunction(
        ({ id, want }) => {
          const els = Array.from(document.querySelectorAll(`[data-testid="role-select-${id}"]`));
          const visible = els.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }) as HTMLSelectElement | undefined;
          return visible?.value === want;
        },
        { id: contactId, want: roleValue },
        { timeout: 10_000 },
      )
      .catch(() => undefined);
  }

  /**
   * Save the EditContactsModal (persists via batchUpdateContacts) and wait for the modal to close.
   * Throws (→ HARNESS_ERROR) if the Save button is missing; a validation error (unassigned role) keeps
   * the modal open — the spec asserts roles were set BEFORE saving, so that path is a real FAIL, not
   * silently swallowed.
   */
  async saveContacts(): Promise<void> {
    await this.press(Contacts.saveButton, 'edit-contacts-modal-save');
    await this.page
      .getByTestId(Contacts.saveButton)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  // ---- BEGIN BACKLOG-1978 (remove-contact-from-transaction cell) ----------
  // Additive driver method for the P2-C2 remove cell. EXTENDS the BACKLOG-1949 add-with-roles helpers
  // above (openEditContacts / saveContacts are REUSED as-is). Isolated in this region because parallel
  // P2 cells also append to this file — expect a mechanical merge later.

  /**
   * From the open EditContactsModal (Screen 1, assigned-contacts view), REMOVE one assigned contact by
   * clicking its per-chip remove control. The button carries the pre-existing (BACKLOG-1949-era)
   * `remove-contact-<id>` testid on ContactRoleRow — rendered TWICE (mobile + desktop), so we resolve the
   * VISIBLE one via press()/resolveVisibleTestid. A missing button THROWS (→ HARNESS_ERROR upstream),
   * never a silent no-op. After the click, waits for the contact's role row to DETACH so the caller knows
   * the in-modal removal took effect BEFORE Save (the DB delta is asserted after saveContacts()).
   */
  async removeContact(contactId: string): Promise<void> {
    await this.press(Contacts.removeContactButton(contactId), `remove-contact[${contactId}]`);
    // The assigned row for this contact should disappear from Screen 1 once removed (pre-Save state).
    await this.page
      .getByTestId(Contacts.contactRoleRow(contactId))
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }
  // ---- END BACKLOG-1978 ---------------------------------------------------

  // ==========================================================================
  // BACKLOG-1982 — delete-emails flow (individual + BULK email unlink).
  //
  // Drives the TransactionEmailsTab thread cards: single unlink via the per-thread
  // "unlink" button + UnlinkEmailModal confirm, and bulk unlink via selection mode
  // (select-emails-button) + BulkSelectionBar + BulkRemoveConfirmModal. All built on
  // the logged press()/resolveVisibleTestid, so a missing testid surfaces as a thrown
  // HARNESS_ERROR (never a silent no-op) — matching the filter-toggle/users-roles cells.
  // Kept in a labeled region: parallel cells touch this file (mechanical merge later).
  // ==========================================================================

  /** Locate the EmailThreadCard whose data-thread-id matches, scoped to a VISIBLE card. */
  private threadCardByThreadId(threadId: string): Locator {
    return this.page
      .locator(`[data-testid="${DeleteEmails.emailThreadCard}"][data-thread-id="${threadId}"]`)
      .locator('visible=true')
      .first();
  }

  /** Count of currently-rendered email thread cards (VISIBLE). */
  async emailThreadCardCount(): Promise<number> {
    return this.page.getByTestId(DeleteEmails.emailThreadCard).locator('visible=true').count();
  }

  /**
   * Unlink a SINGLE email thread by its UI thread id (data-thread-id): hover the card to reveal the
   * per-thread unlink button, click it, then confirm in the UnlinkEmailModal. Throws (→ HARNESS_ERROR)
   * if the card / unlink button / confirm button never appears. The backend expands to all thread
   * siblings sharing the email's thread_id (asserted against the DB by the caller).
   */
  async unlinkThreadById(threadId: string): Promise<void> {
    const card = this.threadCardByThreadId(threadId);
    try {
      await card.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] unlinkThreadById: thread card "${threadId}" not found (selector-not-found / not linked / app-shape changed).`,
      );
    }
    // Hover to reveal the action buttons (they are opacity-0 until hover on the card).
    await card.hover().catch(() => undefined);
    const unlinkBtn = card.getByTestId(DeleteEmails.unlinkThreadButton).locator('visible=true').first();
    try {
      await unlinkBtn.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] unlinkThreadById: unlink button not found on thread card "${threadId}" (selector-not-found).`,
      );
    }
    await this.logIntent('press', DeleteEmails.unlinkThreadButton, unlinkBtn);
    await unlinkBtn.click();
    // Confirm in the UnlinkEmailModal (the "Remove Email" button — testid added attribute-only).
    await this.press(DeleteEmails.unlinkEmailConfirmButton, 'unlink-email-confirm-button');
    // Wait for the confirm modal to close so the DB write has been dispatched before the caller reads.
    await this.page
      .getByTestId(DeleteEmails.unlinkEmailConfirmButton)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  // ---- manual attach-emails flow (BACKLOG-1979) ---------------------------
  //
  // PARALLEL-CELL NOTE: this is an ADDITIVE, clearly-labeled region appended to the driver. Other
  // in-flight cells append their own regions; keep this block self-contained so the later mechanical
  // merge is trivial. It drives the AttachEmailsModal: open → search (server-side, 500ms debounce) →
  // select the sole result thread → confirm attach. Every step is built on the logged press/fill +
  // resolveVisibleTestid, so a missing testid surfaces as a HARNESS_ERROR (thrown), never a silent
  // no-op or a false PASS/FAIL — matching the filter-toggle cell's trust discipline.

  /**
   * Open the Attach Emails modal from the transaction Emails tab and wait for its shell to render.
   * The `attach-emails-button` is rendered on BOTH the empty and populated Emails-tab states (plus
   * mobile/desktop copies), so we resolve the VISIBLE one. Throws (→ HARNESS_ERROR) if the button or
   * the modal never appears.
   */
  async openAttachEmailsModal(): Promise<void> {
    await this.press(AttachEmails.openButtonTestId, 'attach-emails-button');
    await this.waitTestidOrThrow(AttachEmails.modalTestId, 'openAttachEmailsModal: AttachEmailsModal did not render');
    // The search box is the anchor for the next step; ensure it is present before returning.
    await this.waitTestidOrThrow(AttachEmails.searchInputTestId, 'openAttachEmailsModal: search box did not render');
  }

  /**
   * Type a query into the modal's server-side search box and wait for the debounced (500ms) fetch to
   * settle. We do NOT assert a result here — the caller asserts the exact visible thread count so a
   * wrong count is classified deliberately (a HARNESS_ERROR precheck vs a FAIL). Uses the logged fill
   * path (resolves the VISIBLE input); a missing box throws (→ HARNESS_ERROR).
   *
   * SR-FIX (BACKLOG-1979): BEFORE typing, CLEAR the modal's pre-filled `after-date-input`. The modal
   * seeds that lower bound from the audit start (auditStartDate = transaction.started_at); the
   * manual-attach target is sent BEFORE that window, so with the default `after` bound in place the
   * modal's fetch (getUnlinkedEmails → getCachedEmails, `sent_at >= after`) EXCLUDES the target and the
   * search would surface 0 threads (→ HARNESS_ERROR, never PASS). Clearing the input to '' drops the
   * bound at every layer — component `if (after)` is falsy → `options.after` unset → handler passes
   * `after: null` → getCachedEmails omits the `sent_at >= ?` condition — so the out-of-window target is
   * fetched. The `before` bound (audit end, in 2026+) does NOT exclude a 2025-12 target, so only the
   * `after` bound must be cleared. Changing the date input triggers the modal's
   * [debouncedQuery, afterDate, beforeDate] fetch effect just like the search box does.
   */
  async searchAttachEmails(query: string): Promise<void> {
    // Clear the pre-filled lower date bound so an out-of-window target is fetched (SR-FIX above).
    const afterInput = await this.resolveVisibleTestid(
      AttachEmails.afterDateInputTestId,
      'searchAttachEmails: clearing the pre-filled after-date filter',
    );
    this.actionLog.intent('fill', AttachEmails.afterDateInputTestId, '');
    await afterInput.fill('');

    const input = await this.resolveVisibleTestid(
      AttachEmails.searchInputTestId,
      `searchAttachEmails: search box for "${query}"`,
    );
    this.actionLog.intent('fill', AttachEmails.searchInputTestId, query);
    await input.fill(query);
    // Wait out the 500ms debounce + the async getUnlinkedEmails round-trip + list re-render (both the
    // cleared date bound and the query re-run the same fetch effect). The list reads from the local
    // cache offline (getCachedEmails), so this settles quickly; the extra margin absorbs the debounce +
    // a background "refresh" pass that no-ops without a provider.
    await this.page.waitForTimeout(1500);
  }

  /**
   * VISIBLE thread cards scoped to the attach modal. SR-FIX (live run): `EmailThreadCard` renders the
   * same `thread-<id>` testid in the BACKGROUND Emails tab too, so an unscoped locator counted those
   * (4 background + 1 modal = 5). Scope under the modal shell so the count reflects only the search rows.
   */
  private attachModalThreads(): Locator {
    return this.page
      .locator(`[data-testid="${AttachEmails.modalTestId}"]`)
      .locator(AttachEmails.threadAny)
      .locator('visible=true');
  }

  /** Count of currently-VISIBLE thread cards in the attach modal (the search result rows). */
  async visibleAttachThreadCount(): Promise<number> {
    return this.attachModalThreads().count();
  }

  /**
   * Select the SOLE visible thread card in the attach modal (the search must have narrowed results to
   * exactly one). Throws (→ HARNESS_ERROR) if there is not exactly one visible thread — an ambiguous
   * or empty result is a setup problem, NOT a false attach. Clicking the card toggles its selection on.
   */
  async selectSoleAttachThread(): Promise<void> {
    const count = await this.visibleAttachThreadCount();
    if (count !== 1) {
      throw new Error(
        `[keepr-e2e] selectSoleAttachThread: expected exactly 1 visible thread in the attach modal, saw ${count} (search did not isolate the target — setup/app-shape problem).`,
      );
    }
    const card = this.attachModalThreads().first();
    await card.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    await this.logIntent('press', 'attach-thread-card:sole', card);
    await card.click();
  }

  // ---- delete-emails: subject/selection helpers (BACKLOG-1982) ------------

  /**
   * Locate the EmailThreadCard whose visible subject CONTAINS `subjectSubstring`. Used for NULL-thread
   * emails whose UI card id is `subject-<normalized>` (not a stable thread-<id>) — matching by the
   * on-screen subject avoids depending on the exact normalizeSubject output. Resolves a VISIBLE card.
   */
  private threadCardBySubject(subjectSubstring: string): Locator {
    return this.page
      .locator(`[data-testid="${DeleteEmails.emailThreadCard}"]`)
      .filter({ has: this.page.getByTestId(DeleteEmails.threadSubject).filter({ hasText: subjectSubstring }) })
      .locator('visible=true')
      .first();
  }

  /** Unlink a single email thread identified by a subject substring (for NULL-thread singletons). */
  async unlinkThreadBySubject(subjectSubstring: string): Promise<void> {
    const card = this.threadCardBySubject(subjectSubstring);
    try {
      await card.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] unlinkThreadBySubject: thread card matching subject "${subjectSubstring}" not found (selector-not-found / not linked).`,
      );
    }
    await card.hover().catch(() => undefined);
    const unlinkBtn = card.getByTestId(DeleteEmails.unlinkThreadButton).locator('visible=true').first();
    try {
      await unlinkBtn.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] unlinkThreadBySubject: unlink button not found on the card for "${subjectSubstring}" (selector-not-found).`,
      );
    }
    await this.logIntent('press', DeleteEmails.unlinkThreadButton, unlinkBtn);
    await unlinkBtn.click();
    await this.press(DeleteEmails.unlinkEmailConfirmButton, 'unlink-email-confirm-button');
    await this.page
      .getByTestId(DeleteEmails.unlinkEmailConfirmButton)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  /** Select an email thread card (selection mode) identified by a subject substring. */
  async selectEmailThreadBySubject(subjectSubstring: string): Promise<void> {
    const card = this.threadCardBySubject(subjectSubstring);
    try {
      await card.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] selectEmailThreadBySubject: thread card matching subject "${subjectSubstring}" not found (selector-not-found / not linked).`,
      );
    }
    await this.logIntent('press', `${DeleteEmails.emailThreadCard}[subject~="${subjectSubstring}"]`, card);
    await card.click();
  }

  /** Enter email selection mode (Select button). Idempotent-ish: no-op if already selecting. */
  async enterEmailSelectionMode(): Promise<void> {
    await this.press(DeleteEmails.selectEmailsButton, 'select-emails-button (enter)');
    // The floating bulk bar appears once selection mode is on — wait for it so subsequent selects land.
    await this.page
      .getByTestId(DeleteEmails.emailsBulkBar)
      .locator('visible=true')
      .first()
      .waitFor({ state: 'visible', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  /**
   * Select an email thread card by its UI thread id while in selection mode (clicks the card, which
   * toggles its selection). Throws (→ HARNESS_ERROR) if the card never appears.
   */
  async selectEmailThreadById(threadId: string): Promise<void> {
    const card = this.threadCardByThreadId(threadId);
    try {
      await card.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] selectEmailThreadById: thread card "${threadId}" not found (selector-not-found / not linked).`,
      );
    }
    await this.logIntent('press', `${DeleteEmails.emailThreadCard}[${threadId}]`, card);
    await card.click();
  }

  /**
   * Confirm the attach (→ transactions:link-emails, writes communications with link_source='manual').
   * The confirm button (`attach-button`) is DISABLED until at least one thread is selected, so we wait
   * for it to become enabled first (a still-disabled button means nothing was selected — a setup
   * problem surfaced by the wait timing out → HARNESS_ERROR). After clicking, the modal closes on
   * success; we wait for its shell to detach so the linked count can be observed.
   */
  async confirmAttachEmails(): Promise<void> {
    const confirm = await this.resolveVisibleTestid(
      AttachEmails.confirmTestId,
      'confirmAttachEmails: attach/confirm button',
    );
    // The button is enabled only once a selection exists; a disabled button here means no thread was
    // selected — treat a persistent disabled state as a thrown HARNESS_ERROR (never a false attach).
    await this.page
      .waitForFunction(
        (testid) => {
          const els = Array.from(document.querySelectorAll(`[data-testid="${testid}"]`));
          const visible = els.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }) as HTMLButtonElement | undefined;
          return !!visible && !visible.disabled;
        },
        AttachEmails.confirmTestId,
        { timeout: TESTID_WAIT_MS },
      )
      .catch(() => {
        throw new Error(
          '[keepr-e2e] confirmAttachEmails: the attach button never became enabled (no thread selected — setup problem).',
        );
      });
    await this.logIntent('press', AttachEmails.confirmTestId, confirm);
    await confirm.click();
    // On success the modal closes (onAttached → onClose). Wait for the shell to detach so the caller
    // can OBSERVE the DB link. A modal that never closes means the attach failed — surface it by the
    // caller's post-condition DB read (which would see 0 manual links) rather than hanging here.
    await this.page
      .getByTestId(AttachEmails.modalTestId)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }
  // ---- END BACKLOG-1979 ---------------------------------------------------

  // ---- contacts category-filter flow (BACKLOG-1977, P2-C1) ----------------
  //
  // Drives the standalone Contacts module (src/components/Contacts.tsx → ContactSearchList with
  // showCategoryFilter) reached from the Dashboard "Manage Contacts" card (nav-clients-contacts, which
  // ALREADY exists on develop). All built on the logged press()/resolveVisibleTestid, so a missing
  // testid surfaces as a HARNESS_ERROR (thrown), never a silent no-op.
  //
  // MERGE NOTE (int/qa-harness-p2): P2-F1 (#1926) already defines the canonical `openContactsModule()`
  // below in the BACKLOG-1976 region — this cell REUSES it (F1's helper now also waits for the
  // ContactSearchList to render, folding in C1's render-assertion), so no duplicate is defined here.

  /**
   * Count the currently-rendered contact rows in the list. ContactRow renders one
   * `[data-testid="contact-row"]` per visible contact; the filter is client-side, so this reflects the
   * post-filter visible set. The list container's own presence is a precondition (openContactsModule
   * already waited for it), so a legitimately-empty filtered list returns 0 (a valid PASS input), not an error.
   */
  async visibleContactRowCount(): Promise<number> {
    return this.pollVisibleContactRowCountUntilStable();
  }

  /**
   * Return the visible contact-row count once it has STABILIZED (unchanged across N consecutive reads).
   *
   * ROOT-CAUSE FIX (live run, BACKLOG-1977) — supersedes the earlier spinner-premise `waitForContactsSettled`,
   * which WRONGLY assumed the list re-fetches (with a "Loading contacts..." spinner) on every filter/search
   * change. It does NOT: the grouped Source/Role filter and the search box are a SYNCHRONOUS useMemo over the
   * already-loaded `contacts` prop (ContactSearchList.tsx ~L415-448). The only async step is the ONE initial
   * load (now awaited in openContactsModule); after that, filter/search re-renders are synchronous and no
   * spinner reappears — so waiting for a spinner that never comes was a no-op that left the 4→2 / 1→0
   * under-render (a stale count read against a not-yet-hydrated list).
   *
   * Poll-until-stable is robust to ANY residual async hydration WITHOUT a false premise: it reads the count,
   * and once it is IDENTICAL for `stableReads` consecutive samples it returns. Crucially, this does NOT mask a
   * real filter/predicate bug — a genuinely-wrong count simply stabilizes at the wrong value and the caller's
   * assertion still FAILS (per the cell's trust model: a wrong render is a FAIL, never retried away).
   */
  private async pollVisibleContactRowCountUntilStable(): Promise<number> {
    const stableReads = 3; // consecutive identical samples required
    const intervalMs = 100;
    const maxAttempts = 60; // ~6s ceiling; the list is already hydrated by openContactsModule
    const read = (): Promise<number> =>
      this.page.locator(ContactsModule.contactRow).locator('visible=true').count();

    let last = await read();
    let stable = 1;
    for (let i = 0; i < maxAttempts && stable < stableReads; i++) {
      await this.page.waitForTimeout(intervalMs);
      const current = await read();
      if (current === last) {
        stable += 1;
      } else {
        last = current;
        stable = 1;
      }
    }
    return last;
  }

  /** The set of visible rows' data-contact-id values (useful for diagnostics / exact-membership checks). */
  async visibleContactIds(): Promise<string[]> {
    return this.page
      .locator(ContactsModule.contactRow)
      .locator('visible=true')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-contact-id') ?? '').filter((id) => id !== ''));
  }

  /** Type into the contact search input (replacing any prior text). */
  async setContactSearch(query: string): Promise<void> {
    await this.fillTestid(ContactsModule.searchInputTestId, query, 'setContactSearch: fill search');
  }

  /**
   * Open a grouped filter dropdown (source or role) by clicking its trigger and waiting for the panel.
   * Idempotent-ish: if the panel is already visible, this still clicks — callers use ensureFilterOpen.
   */
  private async openFilterDropdown(base: string): Promise<void> {
    await this.clickTestidOrThrow(ContactsModule.filterTrigger(base), `openFilterDropdown: open ${base}`);
    await this.waitTestidOrThrow(ContactsModule.filterPanel(base), `openFilterDropdown: ${base} panel did not open`);
  }

  /** Ensure a grouped filter dropdown's panel is open (no-op if already visible). */
  private async ensureFilterOpen(base: string): Promise<void> {
    const panelVisible = await this.isTestidVisible(ContactsModule.filterPanel(base));
    if (!panelVisible) await this.openFilterDropdown(base);
  }

  /** Close a grouped filter dropdown's panel (Escape returns focus to the trigger). No-op if closed. */
  private async closeFilterDropdown(base: string): Promise<void> {
    const panelVisible = await this.isTestidVisible(ContactsModule.filterPanel(base));
    if (!panelVisible) return;
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page
      .getByTestId(ContactsModule.filterPanel(base))
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  /**
   * Trigger the bulk remove: click the floating bar's Remove action, then confirm in the
   * BulkRemoveConfirmModal. Throws (→ HARNESS_ERROR) if either control never appears. Waits for the
   * confirm modal to close so the DB writes are dispatched before the caller reads.
   */
  async bulkRemoveSelectedEmails(): Promise<void> {
    await this.press(DeleteEmails.emailsBulkRemove, 'emails-bulk-remove');
    await this.waitTestidOrThrow(DeleteEmails.bulkRemoveConfirmTitle, 'bulkRemoveSelectedEmails: confirm modal did not open');
    await this.press(DeleteEmails.bulkRemoveConfirmButton, 'bulk-remove-confirm-button');
    await this.page
      .getByTestId(DeleteEmails.bulkRemoveConfirmButton)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }
  // ---- END BACKLOG-1982 (delete-emails flow) ------------------------------

  /**
   * Set a single leaf checkbox in a grouped filter to the desired checked state. Opens the panel first,
   * reads the current checkbox state, and toggles only if needed (each click flips exactly one leaf).
   * Throws (→ HARNESS_ERROR) if the checkbox never appears.
   */
  private async setFilterLeaf(base: string, leafId: string, checked: boolean): Promise<void> {
    await this.ensureFilterOpen(base);
    const testid = ContactsModule.filterLeafCheckbox(base, leafId);
    const box = await this.resolveVisibleTestid(testid, `setFilterLeaf: ${testid}`);
    const isChecked = await box.isChecked().catch(() => false);
    if (isChecked !== checked) {
      await this.logIntent('press', `${testid}=${checked}`, box);
      await box.click();
    }
  }

  /**
   * Drive the grouped Source/Role filter to an EXACT selection: for each dimension, set every leaf in
   * `wantSelected` ON and every other known leaf OFF, so the resulting selection matches the intended
   * scenario deterministically (independent of the persisted default). `allLeaves` is the full leaf-id
   * universe per dimension (the caller passes ALL_SOURCE_LEAF_IDS / ALL_ROLE_LEAF_IDS). Disabled leaves
   * (e.g. Brokers "no data") are skipped by the caller (they can never be selected).
   *
   * Panels are opened once per dimension and closed after, so the list re-renders with the final
   * selection before the caller reads visibleContactRowCount().
   */
  async setCategoryFilter(opts: {
    sourceLeaves: readonly string[];
    roleLeaves: readonly string[];
    allSourceLeaves: readonly string[];
    allRoleLeaves: readonly string[];
    disabledRoleLeaves?: readonly string[];
  }): Promise<void> {
    const wantSources = new Set(opts.sourceLeaves);
    await this.openFilterDropdown(ContactsModule.sourceFilter);
    for (const leaf of opts.allSourceLeaves) {
      await this.setFilterLeaf(ContactsModule.sourceFilter, leaf, wantSources.has(leaf));
    }
    await this.closeFilterDropdown(ContactsModule.sourceFilter);

    const wantRoles = new Set(opts.roleLeaves);
    const disabled = new Set(opts.disabledRoleLeaves ?? []);
    await this.openFilterDropdown(ContactsModule.roleFilter);
    for (const leaf of opts.allRoleLeaves) {
      if (disabled.has(leaf)) continue; // e.g. Brokers — permanently disabled, never toggles
      await this.setFilterLeaf(ContactsModule.roleFilter, leaf, wantRoles.has(leaf));
    }
    await this.closeFilterDropdown(ContactsModule.roleFilter);
    // NO settle-wait here: the grouped filter is a SYNCHRONOUS useMemo over the already-loaded `contacts`
    // prop (ContactSearchList.tsx ~L415-448) — closing the panel applies the selection synchronously, with
    // NO re-fetch and NO spinner. The caller reads via visibleContactRowCount(), which polls the visible
    // count until it stabilizes (pollVisibleContactRowCountUntilStable), covering any residual React re-render
    // without relying on a (non-existent) refetch spinner.
  }
  // ---- END BACKLOG-1977 (P2-C1 contacts category-filter) ------------------

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

    const exportBtn = this.byRole(Exporter.exportButton.role, Exporter.exportButton.name).first();
    // BACKLOG-1969: log INTENT before opening the export modal.
    await this.logIntent('press', 'role=button:Export', exportBtn);
    await exportBtn.click();

    // Fill date fields if provided (ExportModal step 1).
    const dateInputs = this.page.locator(Exporter.modalDateInputs);
    if (opts.startDate && (await dateInputs.count()) > 0) {
      // BACKLOG-1969: log INTENT before each fill (the value is the "text" of a fill action).
      this.actionLog.intent('fill', 'input[type=date]:start', opts.startDate);
      await dateInputs.nth(0).fill(opts.startDate).catch(() => undefined);
      if (opts.endDate) {
        this.actionLog.intent('fill', 'input[type=date]:end', opts.endDate);
        await dateInputs.nth(1).fill(opts.endDate).catch(() => undefined);
      }
    }

    // Confirm export (second "Export" — inside the modal).
    const confirm = this.byRole(Exporter.modalExportConfirm.role, Exporter.modalExportConfirm.name);
    const confirmCount = await confirm.count();
    // BACKLOG-1969: log INTENT before confirming the export.
    await this.logIntent('press', 'role=button:Export(confirm)', confirm.first());
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

  // ---------------------------------------------------------------------------
  // BACKLOG-1983 (export-completeness cell): trigger the combined-PDF export via the REAL preload
  // bridge (window.api.transactions.exportPDF → ipcRenderer.invoke('transactions:export-pdf', ...)).
  // Passing an EXPLICIT outputPath bypasses the native save dialog, and the seeded covering
  // email_sync_state makes the awaited pre-export sync take the "covered" (no-network) branch. Returns
  // the handler's { success, path, error } so the cell can HARNESS_ERROR if the PDF was not produced.
  // ---------------------------------------------------------------------------
  async exportPdfToPath(
    transactionId: string,
    outputPath: string,
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    return this.page.evaluate(
      async ({ txId, out }) => {
        const api = (window as unknown as {
          api?: { transactions?: { exportPDF?: (id: string, p: string) => Promise<unknown> } };
        }).api;
        const fn = api?.transactions?.exportPDF;
        if (typeof fn !== 'function') {
          return { success: false, error: 'window.api.transactions.exportPDF is not available' };
        }
        return (await fn(txId, out)) as { success: boolean; path?: string; error?: string };
      },
      { txId: transactionId, out: outputPath },
    );
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

  // ---- BACKLOG-1976 (P2-F1): cross-cutting nav helpers ---------------------
  //
  // Additive foundation helpers the Phase-2 cells share. Each is built on the existing logged
  // press() + resolveVisibleTestid / isTestidVisible, so a missing testid surfaces as a
  // HARNESS_ERROR (thrown), never a silent no-op — matching the trust discipline of the rest of
  // the driver. NONE of these modify the behavior of an existing method. Kept in ONE clearly
  // labeled region to minimize the conflict surface with parallel cells editing this file.

  /**
   * Open the standalone Contacts module from the dashboard via the "Clients & Contacts" card
   * (nav-clients-contacts → showContacts). Throws (→ HARNESS_ERROR upstream) if the card is missing.
   *
   * MERGE NOTE (int/qa-harness-p2, BACKLOG-1977 P2-C1): the C1 category-filter cell needs the
   * ContactSearchList to have rendered before it counts rows, so the render-assertion it originally
   * carried in its own helper is folded in here — this single canonical helper now BOTH clicks the nav
   * card AND waits for `contact-search-list`. Throws if the list never appears.
   */
  async openContactsModule(): Promise<void> {
    await this.press(Nav.clientsContacts, 'nav-clients-contacts');
    await this.waitTestidOrThrow(ContactsModule.searchListTestId, 'openContactsModule: contact-search-list did not render');
    // ROOT-CAUSE FIX (live run, BACKLOG-1977): the `contact-search-list` CONTAINER renders IMMEDIATELY
    // (ContactSearchList.tsx root div), while the parent's ASYNC initial load (useContactList.loadContacts →
    // contacts:get-all worker query) is still in flight and `contacts` is still `[]`. The category filter
    // is a SYNCHRONOUS useMemo over the `contacts` prop (ContactSearchList.tsx ~L415-448) — there is NO
    // re-fetch on filter change — so if the first scenario counts before this hydration finishes, it reads
    // a partial/empty list (the live-run 4→2 / 1→0 under-render). `isLoading = loading || externalContactsLoading`
    // starts `true` (useContactList.ts) → the `loading-state` spinner renders on mount, so waiting for it to
    // CLEAR is a reliable "initial contacts load complete" signal. If it already cleared, the hidden-wait
    // returns immediately (Playwright treats an absent element as hidden).
    await this.page
      .getByTestId(ContactsModule.loadingStateTestId)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  /**
   * Click a transaction row by its STABLE transaction id (BACKLOG-1976 data-tx-id on the row root),
   * independent of the row's list position. Resolves the VISIBLE match; throws (→ HARNESS_ERROR
   * upstream) if no row with that id is present (not seeded / filtered out / app-shape changed).
   */
  async selectTxRow(txId: string): Promise<void> {
    const row = this.page.locator(TxList.rowByTxId(txId)).locator('visible=true').first();
    try {
      await row.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        `[keepr-e2e] selectTxRow: no transaction row with data-tx-id="${txId}" found (not seeded / filtered out / app-shape changed).`,
      );
    }
    await this.logIntent('press', `tx-row[${txId}]`, row);
    await row.click();
  }

  /**
   * Enter the transactions-list selection (bulk) mode via the toolbar Edit toggle. The toggle is a
   * single button whose label flips Edit↔Done; this presses it. Idempotent-ish guard omitted (the
   * toolbar owns the boolean) — callers that need determinism should pair with the BulkActionBar's
   * appearance. Throws (→ HARNESS_ERROR) if the toggle testid is missing.
   */
  async enterSelectionMode(): Promise<void> {
    await this.press(TxList.selectionToggle, 'tx-selection-toggle:enter');
  }

  /**
   * Exit the transactions-list selection (bulk) mode via the same toolbar toggle (Done). Symmetric
   * with enterSelectionMode. Throws (→ HARNESS_ERROR) if the toggle testid is missing.
   */
  async exitSelectionMode(): Promise<void> {
    await this.press(TxList.selectionToggle, 'tx-selection-toggle:exit');
  }

  // ==========================================================================
  // BACKLOG-1981 (P2-C5) — delete-transactions flow (individual + BULK).
  //
  // Drives the transaction DELETE paths: single delete via the transaction-detail Overview tab's red
  // "Delete Transaction" trigger + DeleteConfirmModal confirm; bulk delete via the tx-list selection
  // mode (tx-selection-toggle — REUSED from the F1 enterSelectionMode/selectTxRow helpers above) +
  // BulkActionBar + BulkDeleteConfirmModal. All built on the logged press()/resolveVisibleTestid, so a
  // missing testid surfaces as a thrown HARNESS_ERROR (never a silent no-op) — matching the sibling
  // delete-emails/users-roles cells. Kept in a labeled region: parallel cells touch this file.
  // ==========================================================================

  /**
   * From an OPEN transaction detail view (Overview tab), delete the transaction: click the red
   * "Delete Transaction" trigger (no testid → role+accessible-name), then confirm in the
   * DeleteConfirmModal (delete-transaction-confirm). The app's handleDelete → transactions:delete is a
   * bare cascade DELETE; the caller asserts the DB effect. Throws (→ HARNESS_ERROR) if the trigger or
   * the confirm never appears. Waits for the confirm modal to close so the write is dispatched before
   * the caller reads the DB.
   */
  async deleteOpenTransaction(): Promise<void> {
    // The Overview-tab trigger has no testid — target it by role + exact accessible name. It scrolls
    // into view within the detail modal body. A missing trigger is a HARNESS_ERROR (thrown).
    const trigger = this.byRole(
      DeleteTransactions.singleDeleteTrigger.role,
      DeleteTransactions.singleDeleteTrigger.name,
    ).locator('visible=true').first();
    try {
      await trigger.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(
        '[keepr-e2e] deleteOpenTransaction: the "Delete Transaction" trigger was not found on the Overview tab (selector-not-found / app-shape changed).',
      );
    }
    await this.logIntent('press', 'role=button:Delete Transaction', trigger);
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click();
    // Confirm in the DeleteConfirmModal (delete-transaction-confirm).
    await this.press(DeleteTransactions.singleDeleteConfirm, 'delete-transaction-confirm');
    // Wait for the confirm modal to close so the DB write has been dispatched before the caller reads.
    await this.page
      .getByTestId(DeleteTransactions.singleDeleteConfirm)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }

  /**
   * From the tx-list selection mode with >=1 rows already selected (via enterSelectionMode +
   * selectTxRow), trigger a BULK delete: click the BulkActionBar Delete (bulk-delete-button, VISIBLE
   * copy) then confirm in the BulkDeleteConfirmModal (bulk-delete-confirm). The handler loops per-id
   * transactions:delete (each a cascade DELETE); the caller asserts the DB effect. Throws
   * (→ HARNESS_ERROR) if either button never appears. Waits for the confirm modal to close.
   */
  async bulkDeleteSelected(): Promise<void> {
    await this.press(DeleteTransactions.bulkDeleteButton, 'bulk-delete-button');
    await this.press(DeleteTransactions.bulkDeleteConfirm, 'bulk-delete-confirm');
    await this.page
      .getByTestId(DeleteTransactions.bulkDeleteConfirm)
      .first()
      .waitFor({ state: 'hidden', timeout: TESTID_WAIT_MS })
      .catch(() => undefined);
  }
  // ---- END BACKLOG-1981 ---------------------------------------------------

  // ---- internals ----------------------------------------------------------

  /**
   * BACKLOG-1969: install renderer DOM-event capture (addInitScript) + a console listener that
   * re-emits the renderer's `[dom-event]` lines to the driver's own log, so the DRIVER's intent
   * and the DOM's reality sit in one interleaved stream. Best-effort + non-fatal: any failure to
   * wire logging must never fail a launch. No-op cost is near-zero when logging is disabled.
   */
  private async installActionLogging(): Promise<void> {
    if (!this.actionLog.isEnabled) return;
    // Re-emit renderer console lines that carry the [dom-event] prefix (the "reality" stream).
    this.page.on('console', (msg) => {
      try {
        this.actionLog.forwardConsoleLine(msg.text());
      } catch {
        /* never let logging break a run */
      }
    });
    // addInitScript covers every FUTURE document (navigations/reloads)...
    await this.page.addInitScript(DOM_CAPTURE_INIT_SCRIPT).catch(() => undefined);
    // ...and inject once into the ALREADY-loaded first document too, so reality lines are captured
    // from the very first paint (the init-script is idempotent via its window flag). Non-fatal.
    await this.page.evaluate(DOM_CAPTURE_INIT_SCRIPT).catch(() => undefined);
  }

  /**
   * BACKLOG-1969: emit a driver INTENT line before performing `verb` on `locator`, resolving the
   * element's visible text so the log reads like `press testid=nav-new-audit text="New Audit"`.
   * Text resolution is best-effort + non-fatal (a short timeout, swallowed on failure) — logging
   * must NEVER add a failure mode to a driver step.
   */
  private async logIntent(verb: ActionVerb, target: string, locator?: Locator): Promise<void> {
    if (!this.actionLog.isEnabled) return;
    let text = '';
    if (locator) {
      text = await locator
        .first()
        .innerText({ timeout: 1_000 })
        .catch(() => '');
    }
    this.actionLog.intent(verb, target, text);
  }

  /**
   * Resolve the VISIBLE element for a testid, waiting up to TESTID_WAIT_MS for it to appear. Several
   * testids are duplicated for mobile (`sm:hidden`) and desktop (`hidden sm:flex`) layouts, so a bare
   * `.first()` could resolve the HIDDEN variant — we scope to `visible=true`. THROWS with an
   * actionable message if it never appears; callers let it propagate so the runner classifies a
   * missing testid as HARNESS_ERROR (never a silent no-op or a false FAIL). Shared by
   * clickTestidOrThrow + the public hover()/press() (BACKLOG-1971).
   */
  private async resolveVisibleTestid(testid: string, context: string): Promise<Locator> {
    const loc = this.page.getByTestId(testid).locator('visible=true').first();
    try {
      await loc.waitFor({ state: 'visible', timeout: TESTID_WAIT_MS });
    } catch {
      throw new Error(`[keepr-e2e] ${context}: testid "${testid}" not found (selector-not-found / app-shape changed).`);
    }
    return loc;
  }

  /**
   * Wait for a testid to be visible, then click it. If the testid never appears, THROW with an
   * actionable message. Callers let this propagate so the runner classifies it as a HARNESS_ERROR
   * (a missing testid = the harness could not proceed) — never a silent no-op or a false FAIL.
   */
  private async clickTestidOrThrow(testid: string, context: string): Promise<void> {
    const loc = await this.resolveVisibleTestid(testid, context);
    // BACKLOG-1969: log INTENT (with resolved text) immediately BEFORE the click.
    await this.logIntent('press', testid, loc);
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

  private async clickIfPresent(loc: Locator, label?: string): Promise<boolean> {
    const target = loc.first();
    if (await target.isVisible().catch(() => false)) {
      // BACKLOG-1969: log INTENT before the click. `label` is the caller's known target (a testid or
      // a role-name); when absent we fall back to a compact locator description so the line is still
      // greppable. Resolved text comes from the element itself.
      await this.logIntent('press', label ?? describeLocator(target), target);
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
 * BACKLOG-1969: compact, greppable descriptor for a Locator with no caller-supplied label. Playwright's
 * Locator.toString() renders its selector (e.g. `locator('getByRole(...)')`); we strip the wrapper so
 * the intent line stays short. Purely for the log — never used for element resolution.
 */
function describeLocator(loc: Locator): string {
  const raw = String(loc);
  const m = raw.match(/@?locator\('(.+)'\)\s*$/) ?? raw.match(/locator\('(.+)'\)/);
  return (m ? m[1] : raw).slice(0, 80);
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
