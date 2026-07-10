import { _electron, chromium } from '@playwright/test';
import type { Browser, ElectronApplication, Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const DEFAULT_CDP_PORT = 9222;

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

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
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
 * Launch via a spawned process + Chromium remote-debugging port + connectOverCDP.
 * Renderer-only (no `electronApp` main-process handle). Works against the standard
 * hardened/notarized build with NO fuse change. Electron 35 (Chromium ~134) requires
 * `--remote-allow-origins=*` for CDP attach.
 */
export async function launchCdp(executablePath: string, opts: AppDriverOptions): Promise<LaunchHandle> {
  const port = opts.cdpPort ?? DEFAULT_CDP_PORT;
  const timeout = opts.launchTimeoutMs ?? DEFAULT_TIMEOUT;
  const { args, userDataDir } = buildArgs(opts);
  const child = spawn(executablePath, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...args], {
    stdio: 'ignore',
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  const up = await waitForPort(port, timeout);
  if (!up) {
    try {
      if (child.pid) process.kill(child.pid);
    } catch {
      /* noop */
    }
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
      try {
        if (child.pid) process.kill(child.pid);
      } catch {
        /* noop */
      }
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
