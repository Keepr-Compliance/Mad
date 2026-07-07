/**
 * Launch-strategy diagnostic for the packaged Keepr app (BACKLOG-1849).
 *
 * Reproduces the spike's empirical finding, so SR / H1 / future engineers can re-verify on any
 * machine or build without re-deriving it:
 *   A) `_electron.launch`  — expected to FAIL on the standard hardened build
 *                            (EnableNodeCliInspectArguments=false), succeed on a QA-fused build.
 *   B) `--remote-debugging-port` + connectOverCDP — expected to ATTACH (renderer-only).
 *
 * Run: `npm run qa:e2e:probe` (optionally KEEPR_APP_PATH=/path/to/binary).
 * Read-only: launches the app, inspects the first window, then quits it.
 */
import { _electron, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { resolveExecutable } from '../driver/paths';

const REPO_ROOT = join(__dirname, '..', '..');
const PORT = Number(process.env.KEEPR_CDP_PORT ?? 9222);

function log(o: unknown): void {
  // eslint-disable-next-line no-console
  console.log('PROBE ' + JSON.stringify(o));
}

function killApp(): void {
  try {
    execFileSync('pkill', ['-f', 'Keepr.app/Contents/MacOS/Keepr']);
  } catch {
    /* nothing to kill */
  }
}

function waitPort(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = (): void => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

async function probeElectron(bin: string): Promise<void> {
  const started = Date.now();
  try {
    const app = await _electron.launch({ executablePath: bin, args: [], timeout: 20_000 });
    const win = await app.firstWindow({ timeout: 8_000 }).catch(() => null);
    const title = win ? await win.title().catch(() => null) : null;
    await app.close().catch(() => undefined);
    log({ probe: 'A_electron_launch', result: 'ATTACHED', ms: Date.now() - started, title });
  } catch (e) {
    log({ probe: 'A_electron_launch', result: 'FAILED', ms: Date.now() - started, error: String(e).split('\n')[0].slice(0, 200) });
  } finally {
    killApp();
  }
}

async function probeCdp(bin: string): Promise<void> {
  const started = Date.now();
  const child = spawn(bin, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], { stdio: 'ignore' });
  try {
    if (!(await waitPort(PORT, 25_000))) {
      log({ probe: 'B_cdp', result: 'PORT_NEVER_OPENED', ms: Date.now() - started });
      return;
    }
    await new Promise((r) => setTimeout(r, 4_000));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 15_000 });
    const pages = browser.contexts().flatMap((c) => c.pages());
    const info = pages.map((p) => ({ url: p.url().slice(0, 80) }));
    await browser.close().catch(() => undefined);
    log({ probe: 'B_cdp', result: 'ATTACHED', ms: Date.now() - started, pageCount: pages.length, pages: info });
  } catch (e) {
    log({ probe: 'B_cdp', result: 'FAILED', ms: Date.now() - started, error: String(e).split('\n')[0].slice(0, 200) });
  } finally {
    try {
      if (child.pid) process.kill(child.pid);
    } catch {
      /* noop */
    }
    killApp();
  }
}

async function main(): Promise<void> {
  const bin = resolveExecutable(REPO_ROOT, process.env.KEEPR_APP_PATH);
  log({ target: bin });
  const which = process.argv[2] ?? 'B';
  // Probe A can crash the process on failure (Playwright rethrows the launch error out-of-band),
  // so run it in isolation via `qa:e2e:probe A`. Default to B (safe, informative).
  if (which === 'A') await probeElectron(bin);
  if (which === 'B') await probeCdp(bin);
  process.exit(0);
}

void main();
