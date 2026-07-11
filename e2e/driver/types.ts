import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Public typed API for the Keepr Playwright-Electron driver (BACKLOG-1849).
 *
 * The driver drives the PACKAGED desktop app. Two launch strategies exist because the
 * production build hardens Electron fuses (`EnableNodeCliInspectArguments=false`,
 * `RunAsNode=false`), which BLOCKS Playwright's `_electron.launch()` main-process attach:
 *
 *   - `electron`  Playwright `_electron.launch({ executablePath })`. Full main + renderer
 *                 control (needed to stub native dialogs for export). Requires a build with
 *                 the inspect fuse ENABLED — produce one with `npm run package:qa`.
 *   - `cdp`       Spawn the app with `--remote-debugging-port` and `chromium.connectOverCDP`.
 *                 Renderer-only (no main-process access), but works against the STANDARD
 *                 hardened/notarized build with no fuse change. Empirically verified to attach.
 *
 * See e2e/README.md for the full launch-strategy + TCC + session-reuse rationale.
 */
/**
 * - `electron`    Playwright `_electron.launch()` against a PACKAGED (QA-fused) build.
 * - `cdp`         Spawn the packaged app + connectOverCDP (renderer-only, hardened build).
 * - `unpackaged`  BACKLOG-1940 pivot: `_electron.launch()` against the node_modules electron
 *                 binary running the BUILT `dist-electron/main.js` (default fuses → inspector
 *                 works). NO packaging, NO codesign, NO Gatekeeper. This is the reliable path
 *                 for feature-verification / watch-it-drive runs. Requires an isolated
 *                 `--user-data-dir` and sets `KEEPR_E2E=1` so main loads built dist/ assets.
 */
export type LaunchStrategy = 'electron' | 'cdp' | 'unpackaged';

export type AppState = 'ready' | 'onboarding' | 'unknown';

export interface AppDriverOptions {
  /** Path to the packaged app executable. Defaults resolve /Applications then dist/. Override with KEEPR_APP_PATH. */
  executablePath?: string;
  /** Launch strategy. Default 'electron' (falls back to 'cdp' guidance if the fuse blocks it). */
  strategy?: LaunchStrategy;
  /**
   * Repo root — REQUIRED for the 'unpackaged' strategy (BACKLOG-1940). Used to resolve the
   * node_modules electron binary and the built dist-electron/main.js entry. Ignored otherwise.
   */
  repoRoot?: string;
  /**
   * Reuse the persisted Electron userData profile (default true) so a prior one-time login
   * is reused with NO re-login. When false, an isolated temp userData dir is used.
   */
  reuseProfile?: boolean;
  /** Explicit userData dir override (implies reuseProfile=false when set to a non-default path). */
  userDataDir?: string;
  /**
   * Remote-debugging port for the 'cdp' strategy. Omit (default) to use a FREE ephemeral port.
   * If set, it is asserted free before launch and the launch FAILS FAST if it is already in use,
   * so CDP can never attach to a foreign process (e.g. a dev instance on 9222). (BACKLOG-1886)
   */
  cdpPort?: number;
  /** Launch/attach timeout (ms). Default 30000. */
  launchTimeoutMs?: number;
  /** Extra command-line args passed to the app. */
  extraArgs?: string[];
  /** Extra environment for the launched app. */
  env?: Record<string, string>;
  /** Directory for screenshots/artifacts. Default e2e/.artifacts. */
  artifactsDir?: string;
}

export interface OnboardingOptions {
  /** Skip optional steps and race to the ready state instead of completing each screen. Default true. */
  skip?: boolean;
  /** Which email provider to connect if the flow requires it. */
  provider?: 'outlook' | 'gmail';
  /** Max time (ms) to reach the ready state. Default 120000. */
  timeoutMs?: number;
}

export interface ExportOptions {
  format?: 'folder' | 'pdf' | 'combined-pdf';
  startDate?: string;
  endDate?: string;
  closingDate?: string;
  /**
   * Destination dir for a folder export. Under the 'electron' strategy the driver stubs the
   * native folder picker (via main-process `dialog.showOpenDialog`) to return this path.
   * Under 'cdp' the native picker cannot be driven — see ExportResult.nativeDialogStubbed.
   */
  destDir?: string;
  /** Max time (ms) to reach export completion. Default 120000. */
  timeoutMs?: number;
}

/**
 * Observed state of the transactions list, read via testids (BACKLOG-1940).
 *
 * The `present` flag is load-bearing for the trust contract: `tx-list` MUST be present when
 * the transactions view is shown. If it is absent, that is an app-shape / harness problem —
 * the caller must classify it as HARNESS_ERROR and must NEVER report it as "0 transactions".
 */
export interface TransactionsListState {
  /** True when the tx-list container testid was found. False => harness/app-shape problem. */
  present: boolean;
  /** True when tx-list is present AND the empty-state (tx-empty) is rendered. */
  empty: boolean;
  /** Number of tx-row-{index} rows found (0 for a correctly-empty list). */
  rowCount: number;
}

/** Result of clickFirstTransaction(). An empty list is a clean, correct outcome — not an error. */
export interface ClickFirstTransactionResult {
  /** True if a first row existed and was clicked. */
  clicked: boolean;
  /** True if the list was correctly empty (nothing to click) — this is a PASS, not a failure. */
  empty: boolean;
}

export interface ExportResult {
  /** True if the export action was triggered (modal confirmed). */
  triggered: boolean;
  format: string;
  destDir?: string;
  /** True only when the native folder dialog was stubbed (electron strategy). */
  nativeDialogStubbed: boolean;
  /** True if a completion indicator was observed within the timeout. */
  completed: boolean;
}

/**
 * Input to createTransactionViaWizard (BACKLOG-1948). The address + startDate are the fields the
 * DB assertion keys on; contactId is a seeded, imported contact selectable in wizard step 2 (e.g.
 * 'qa-seed-contact-1'); role is the step-3 role value (defaults to 'client', which satisfies the
 * Client gate). closedAt/closingDate are optional and default-filled by the app when omitted.
 */
export interface CreateAuditInput {
  address: string;
  /** ISO date (YYYY-MM-DD) for the Representation Start Date input. */
  startDate: string;
  /** A seeded/imported contact id to select in step 2 and assign a role in step 3. */
  contactId: string;
  /** Step-3 role value (default 'client'). */
  role?: string;
  /** Optional ISO date (YYYY-MM-DD) for the End Date input. */
  closedAt?: string;
  /** Transaction type — 'purchase' (default) or 'sale'. */
  transactionType?: 'purchase' | 'sale';
}

export interface AppDriver {
  /** The main window renderer page. */
  readonly page: Page;
  /** The Electron application handle — present only for the 'electron' strategy. */
  readonly app: ElectronApplication | undefined;
  readonly strategy: LaunchStrategy;

  /** Wait until the renderer has painted its first frame. */
  waitForFirstPaint(timeoutMs?: number): Promise<void>;
  /** Detect whether the app is showing onboarding or the ready main app. */
  detectState(): Promise<AppState>;
  /**
   * Wait until the ready dashboard is actually rendered (a nav testid is visible), up to timeoutMs.
   * Returns false if the app is stuck on a transient screen (e.g. "Verifying your account…") — the
   * caller classifies a false as a HARNESS_ERROR. Non-throwing; single bounded wait (no relaunch).
   */
  waitForReady(timeoutMs?: number): Promise<boolean>;
  /** Drive (or skip) onboarding until the ready main-app state is reached. */
  completeOnboarding(opts?: OnboardingOptions): Promise<void>;
  /**
   * True when the app reached the ready state WITHOUT presenting a login/onboarding
   * screen — i.e. the persisted session (userData + keychain) was reused. This is the
   * session-reuse assertion for the packaged smoke test (BACKLOG-1789).
   */
  isSessionReused(): Promise<boolean>;
  /**
   * Bring the app window to the front and focus it, so a headful run is visibly on top
   * (BACKLOG-1940). Called unconditionally from launch (BACKLOG-1971) so no run is ever invisible.
   * Best-effort + non-fatal — a failure to foreground never fails a step.
   */
  bringToFront(): Promise<void>;
  /**
   * Hover an element by testid, logging a `[driver-action] … hover …` INTENT line before the action
   * (BACKLOG-1971). `label` overrides the logged target for elements addressed by role/selector.
   * Resolves the VISIBLE match; throws (→ HARNESS_ERROR upstream) if the testid never appears.
   */
  hover(testid: string, label?: string): Promise<void>;
  /**
   * Press (click) an element by testid, logging a `[driver-action] … press …` INTENT line before
   * the action (BACKLOG-1971). `label` overrides the logged target. Resolves the VISIBLE match;
   * throws (→ HARNESS_ERROR upstream) if the testid never appears — the public, logged sibling of
   * the driver's internal clickTestidOrThrow.
   */
  press(testid: string, label?: string): Promise<void>;
  /**
   * Dismiss the react-joyride feature tour if it is showing (via its data-action="skip").
   * Returns true if a tour was found and a skip was clicked. SINGLE attempt — never loops.
   */
  dismissTour(): Promise<boolean>;
  /**
   * Navigate to the Settings page via testids (profile avatar → Profile modal → Settings).
   * Resolves once the settings-page testid is visible. Throws (→ HARNESS_ERROR upstream) if
   * a required testid is not found — it never silently no-ops.
   */
  gotoSettings(): Promise<void>;
  /**
   * Close the Settings modal via the settings-close testid and wait for it to disappear, so the
   * dashboard nav is reachable again. Best-effort — resolves even if Settings was already closed.
   */
  closeSettings(): Promise<void>;
  /**
   * Navigate to the Transactions list via the nav-transactions testid. Resolves once the
   * tx-list container testid is visible. Throws if a required testid is missing.
   */
  gotoTransactions(): Promise<void>;
  /**
   * Read the transactions-list state via testids. `tx-list` MUST be present (its absence is
   * an app-shape/harness problem, NOT "0 transactions"). Reports empty vs a row count.
   */
  readTransactionsList(): Promise<TransactionsListState>;
  /**
   * Click the first transaction row (tx-row-0) if present. On an EMPTY list returns
   * `{ clicked: false, empty: true }` — a clean, correct "no transactions" outcome, NOT an error.
   */
  clickFirstTransaction(): Promise<ClickFirstTransactionResult>;
  /** Navigate to a transaction by address text (e.g. "742 Birchwood Lane NE"). */
  gotoTransaction(query: string): Promise<void>;
  /**
   * BACKLOG-1948: drive the New Audit CREATE wizard end-to-end and create a transaction.
   * Presses nav-new-audit → (create-manually-button if the AI-add-on modal appears) → fills step 1
   * (address + start date), selects the given seeded contact in step 2, assigns it the Client role in
   * step 3, then presses Create Transaction. Every step targets a testid; a missing testid THROWS
   * (→ HARNESS_ERROR upstream) — the wizard never silently no-ops or fakes a create.
   */
  createTransactionViaWizard(input: CreateAuditInput): Promise<void>;
  /** Toggle the property-address email filter ON or OFF (idempotent). */
  setAddressFilter(on: boolean): Promise<void>;
  /** Read the current address-filter state (aria-checked). */
  getAddressFilterState(): Promise<boolean>;
  /** Open the export modal and trigger a transaction export. */
  triggerExport(opts?: ExportOptions): Promise<ExportResult>;
  /** Capture a screenshot artifact; returns the PNG bytes. */
  screenshot(name: string): Promise<Buffer>;
  /** The userData dir this instance is using (persisted profile unless isolated). */
  userDataDir(): string;
  /** Shut down the app / detach. */
  close(): Promise<void>;
}
