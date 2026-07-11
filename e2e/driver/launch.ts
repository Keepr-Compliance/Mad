import { _electron, chromium } from '@playwright/test';
import type { Browser, ElectronApplication, Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuiltMainEntry, resolveElectronBinary } from './paths';
import { resolveCdpPort, terminateChildTree, waitForChildPort } from './process';
import type { AppDriverOptions, LaunchStrategy } from './types';

/**
 * Low-level launch layer. Encapsulates the two empirically-validated ways to attach
 * Playwright to the PACKAGED Keepr app (see e2e/README.md).
 */

export interface LaunchHandle {
  strategy: LaunchStrategy;
  page: Page;
  app: ElectronApplication | undefined;
  /** Present only for the 'cdp' strategy. */
  browser?: Browser;
  child?: ChildProcess;
  userDataDir: string;
  close: () => Promise<void>;
}

const DEFAULT_TIMEOUT = 30_000;

function isDefaultProfile(opts: AppDriverOptions): boolean {
  return opts.reuseProfile !== false && !opts.userDataDir;
}

/** Build the app args, adding --user-data-dir only when an isolated profile is requested. */
function buildArgs(opts: AppDriverOptions): { args: string[]; userDataDir: string } {
  const extra = opts.extraArgs ?? [];
  if (isDefaultProfile(opts)) {
    // Reuse the persisted profile: do NOT pass --user-data-dir; the app uses its default.
    return { args: [...extra], userDataDir: '<default persisted profile>' };
  }
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'keepr-e2e-'));
  // Electron maps the Chromium --user-data-dir switch onto app userData.
  return { args: [`--user-data-dir=${userDataDir}`, ...extra], userDataDir };
}

/**
 * Launch via Playwright `_electron.launch`. Requires a build with the inspect fuse enabled
 * (`npm run package:qa`). Against the standard hardened build this REJECTS with
 * "Process failed to launch!" because Playwright never sees the DevTools inspector line.
 */
export async function launchElectron(executablePath: string, opts: AppDriverOptions): Promise<LaunchHandle> {
  const { args, userDataDir } = buildArgs(opts);
  const app = await _electron.launch({
    executablePath,
    args,
    timeout: opts.launchTimeoutMs ?? DEFAULT_TIMEOUT,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  });
  const page = await app.firstWindow({ timeout: opts.launchTimeoutMs ?? DEFAULT_TIMEOUT });
  return {
    strategy: 'electron',
    app,
    page,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
    },
  };
}

/**
 * BACKLOG-1940 pivot — launch the UNPACKAGED build via `_electron.launch()`.
 *
 * Runs the node_modules `electron` binary (default fuses → the Node inspector is enabled, so
 * Playwright's main-process attach works) against the repo's BUILT `dist-electron/main.js`
 * (pointed at via the repo `.` entry). This deliberately AVOIDS packaging, code-signing,
 * Gatekeeper, and the macOS-15 strict-signing crash that killed the packaged QA path.
 *
 * Requirements enforced here:
 *   - An ISOLATED `--user-data-dir` is MANDATORY (reuseProfile:false or an explicit userDataDir);
 *     we never run the unpackaged build against the real persisted keepr profile.
 *   - `KEEPR_E2E=1` is injected so the built main loads the bundled `dist/` assets via the app://
 *     protocol (no Vite dev server needed). This env is inert in any packaged build (double-gated
 *     on !app.isPackaged in main.ts).
 */
export async function launchUnpackaged(opts: AppDriverOptions): Promise<LaunchHandle> {
  if (!opts.repoRoot) {
    throw new Error("[keepr-e2e] launchUnpackaged requires opts.repoRoot (to resolve electron + the built entry).");
  }
  if (isDefaultProfile(opts)) {
    throw new Error(
      "[keepr-e2e] launchUnpackaged requires an ISOLATED profile — pass reuseProfile:false or an explicit userDataDir. " +
        "It must NEVER run against the real persisted keepr profile.",
    );
  }
  const electronBin = resolveElectronBinary(opts.repoRoot, opts.executablePath);
  // Assert the built entry exists so a missing `npm run build` fails fast (→ launch-failed).
  resolveBuiltMainEntry(opts.repoRoot);
  const { args, userDataDir } = buildArgs(opts);
  const app = await _electron.launch({
    executablePath: electronBin,
    // '.' → resolves package.json "main" → the built dist-electron/main.js.
    args: ['.', ...args],
    cwd: opts.repoRoot,
    timeout: opts.launchTimeoutMs ?? DEFAULT_TIMEOUT,
    env: { ...process.env, KEEPR_E2E: '1', ...(opts.env ?? {}) } as Record<string, string>,
  });
  const page = await app.firstWindow({ timeout: opts.launchTimeoutMs ?? DEFAULT_TIMEOUT });
  return {
    strategy: 'unpackaged',
    app,
    page,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
    },
  };
}

/**
 * Launch via a spawned process + Chromium remote-debugging port + connectOverCDP.
 * Renderer-only (no `electronApp` main-process handle). Works against the standard
 * hardened/notarized build with NO fuse change. Electron 35 (Chromium ~134) requires
 * `--remote-allow-origins=*` for CDP attach.
 *
 * Port safety (BACKLOG-1886): the port defaults to a FREE ephemeral port, and an explicitly
 * requested port is asserted free BEFORE spawn (`resolveCdpPort` throws if occupied), so CDP can
 * never attach to a foreign process (e.g. a dev instance on 9222). The child is spawned detached so
 * teardown can SIGTERM->SIGKILL its whole process group (Electron helpers included).
 */
export async function launchCdp(executablePath: string, opts: AppDriverOptions): Promise<LaunchHandle> {
  const timeout = opts.launchTimeoutMs ?? DEFAULT_TIMEOUT;
  const port = await resolveCdpPort(opts.cdpPort);
  const { args, userDataDir } = buildArgs(opts);
  const child = spawn(executablePath, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...args], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  const up = await waitForChildPort(port, timeout);
  if (!up) {
    await terminateChildTree(child);
    throw new Error(`[keepr-e2e] CDP port ${port} never opened within ${timeout}ms.`);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
  const page = await pickAppPage(browser, timeout);

  return {
    strategy: 'cdp',
    app: undefined,
    page,
    browser,
    child,
    userDataDir,
    close: async () => {
      await browser.close().catch(() => undefined); // detaches CDP; does not quit Electron
      await terminateChildTree(child); // SIGTERM -> SIGKILL the spawned PID tree only
    },
  };
}

/** Pick the real app window from the CDP targets, skipping devtools:// and blank pages. */
async function pickAppPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (!url.startsWith('devtools://') && url !== 'about:blank') return p;
      }
    }
    if (Date.now() > deadline) {
      throw new Error('[keepr-e2e] No application window found over CDP (only devtools/blank targets).');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function launch(executablePath: string, opts: AppDriverOptions): Promise<LaunchHandle> {
  const strategy = opts.strategy ?? 'electron';
  if (strategy === 'unpackaged') return launchUnpackaged(opts);
  if (strategy === 'cdp') return launchCdp(executablePath, opts);
  try {
    return await launchElectron(executablePath, opts);
  } catch (err) {
    const msg = String(err);
    if (/Process failed to launch/.test(msg)) {
      throw new Error(
        `[keepr-e2e] _electron.launch failed — the target build has the Node inspect fuse disabled ` +
          `(EnableNodeCliInspectArguments=false). Build a QA artifact with \`npm run package:qa\`, ` +
          `or use strategy:'cdp' for a renderer-only smoke against the hardened build.\nOriginal: ${msg}`,
      );
    }
    throw err;
  }
}
