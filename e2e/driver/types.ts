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
export type LaunchStrategy = 'electron' | 'cdp';

export type AppState = 'ready' | 'onboarding' | 'unknown';

export interface AppDriverOptions {
  /** Path to the packaged app executable. Defaults resolve /Applications then dist/. Override with KEEPR_APP_PATH. */
  executablePath?: string;
  /** Launch strategy. Default 'electron' (falls back to 'cdp' guidance if the fuse blocks it). */
  strategy?: LaunchStrategy;
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
  /** Drive (or skip) onboarding until the ready main-app state is reached. */
  completeOnboarding(opts?: OnboardingOptions): Promise<void>;
  /**
   * True when the app reached the ready state WITHOUT presenting a login/onboarding
   * screen — i.e. the persisted session (userData + keychain) was reused. This is the
   * session-reuse assertion for the packaged smoke test (BACKLOG-1789).
   */
  isSessionReused(): Promise<boolean>;
  /** Navigate to a transaction by address text (e.g. "742 Birchwood Lane NE"). */
  gotoTransaction(query: string): Promise<void>;
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
