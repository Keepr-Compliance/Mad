/**
 * BACKLOG-4054 — the driver focuses the LAUNCHED app only, never an app by name.
 *
 *   - bringToFront() calls app.focus({ steal: true }) and focuses the first window INSIDE the
 *     launched process (fake ElectronApplication), on every platform, and spawns no process;
 *   - source guard: no harness code under e2e/ or scripts/qa/ invokes osascript, `tell application`,
 *     `open -a/-b` or shell.openPath/openExternal, or names the installed app's bundle or bundle id
 *     (a by-name activation resolves to the installed Keepr app, not the launched one).
 *
 * Pure Node → no Electron, no app launch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const execFileSpy = jest.fn();
const spawnSpy = jest.fn();
function mockCp() {
  const actual = jest.requireActual('node:child_process');
  return {
    ...actual,
    execFile: (...a: unknown[]) => execFileSpy(...a),
    spawn: (...a: unknown[]) => spawnSpy(...a),
  };
}
jest.mock('node:child_process', () => mockCp());
jest.mock('child_process', () => mockCp());

import { KeeprAppDriver } from '../appDriver';

const repoRoot = join(__dirname, '..', '..', '..');

function fakeLaunched() {
  const calls: string[] = [];
  const win = {
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    moveTop: () => calls.push('moveTop'),
    focus: () => calls.push('win.focus'),
  };
  const electronApp = { focus: jest.fn((o: unknown) => calls.push(`app.focus:${JSON.stringify(o)}`)) };
  const accessed: string[] = [];
  const mod = { app: electronApp, BrowserWindow: { getAllWindows: () => [win] } } as Record<string, unknown>;
  const proxy = new Proxy(mod, { get: (t, k) => { accessed.push(String(k)); return t[k as string]; } });
  const app = { evaluate: jest.fn(async (fn: (m: unknown) => unknown) => fn(proxy)) };
  const page = { bringToFront: jest.fn(async () => undefined) };
  return { calls, app, page, electronApp, accessed };
}

function driverWith(page: unknown, app: unknown): KeeprAppDriver {
  const driver = new (KeeprAppDriver as unknown as new (repoRoot: string, opts: object) => KeeprAppDriver)(
    repoRoot,
    {},
  );
  (driver as unknown as { handle: { page: unknown; app: unknown } }).handle = { page, app };
  return driver;
}

describe('bringToFront focuses the launched process (BACKLOG-4054)', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    execFileSpy.mockReset();
    spawnSpy.mockReset();
  });

  it.each(['darwin', 'win32', 'linux'])('F1 %s: app.focus({steal:true}) + window show/moveTop/focus, in-process', async (plat) => {
    Object.defineProperty(process, 'platform', { value: plat });
    const f = fakeLaunched();
    await driverWith(f.page, f.app).bringToFront();
    expect(f.page.bringToFront).toHaveBeenCalledTimes(1);
    expect(f.app.evaluate).toHaveBeenCalledTimes(1);
    expect(f.electronApp.focus).toHaveBeenCalledWith({ steal: true });
    expect(f.calls).toEqual(['app.focus:{"steal":true}', 'show', 'moveTop', 'win.focus']);
    expect([...new Set(f.accessed)].sort()).toEqual(['BrowserWindow', 'app']);
  });

  it('F2 darwin: spawns no process (no osascript / open)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const f = fakeLaunched();
    await driverWith(f.page, f.app).bringToFront();
    expect(execFileSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('F3 no app handle (cdp): page only, nothing spawned, never throws', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const f = fakeLaunched();
    await expect(driverWith(f.page, undefined).bringToFront()).resolves.toBeUndefined();
    expect(f.page.bringToFront).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });
});

/** Forbidden: any by-name OS activation path from harness code. */
const BY_NAME_ACTIVATION = [
  /\bosascript\b/,
  /tell\s+application\b/i,
  /\bopen\s+-[ab]\b/,
  /['"`]open['"`]\s*,\s*\[\s*['"`]-[ab]['"`]/,
  /\bshell\.open(Path|External)\b/,
  /Keepr\.app\b/,
  /com\.keeprcompliance\.keepr\b/,
];
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|sh)$/;
const SKIP_DIR = new Set(['node_modules', '__tests__', '.artifacts', 'test-results', 'dist']);

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(p, out);
    } else if (CODE_EXT.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const GUARD_ROOTS = ['e2e', 'scripts/qa'];

describe('source guard: no by-name app activation in harness code (BACKLOG-4054)', () => {
  // One positive control per pattern: every pattern must match its own sample, so no pattern in
  // the list can be dead. The first sample is the exact line this item removed.
  const POSITIVE: Array<[RegExp, string]> = [
    [BY_NAME_ACTIVATION[0], "execFile('osascript', ['-e', `tell application \"${appName}\" to activate`])"],
    [BY_NAME_ACTIVATION[1], 'tell application "Keepr" to activate'],
    [BY_NAME_ACTIVATION[2], 'open -a Keepr'],
    [BY_NAME_ACTIVATION[3], "execFile('open', ['-b', 'some.bundle.id'])"],
    [BY_NAME_ACTIVATION[4], "shell.openPath('/Applications/Some.app')"],
    [BY_NAME_ACTIVATION[4], 'shell.openExternal(url)'],
    [BY_NAME_ACTIVATION[5], "const p = '/Applications/Keepr.app';"],
    [BY_NAME_ACTIVATION[6], "tell application id \"com.keeprcompliance.keepr\" to activate"],
  ];

  it('G0 every pattern matches its own sample (positive control), and the fix does not match', () => {
    expect(new Set(POSITIVE.map(([re]) => re)).size).toBe(BY_NAME_ACTIVATION.length);
    for (const [re, line] of POSITIVE) expect({ re: String(re), line, hit: re.test(line) }).toEqual({ re: String(re), line, hit: true });
    for (const ok of ['app.focus({ steal: true });', 'win.focus();', 'await this.page.bringToFront();']) {
      expect(BY_NAME_ACTIVATION.some((re) => re.test(ok))).toBe(false);
    }
  });

  it('G1 walks a non-trivial file set, including appDriver.ts', () => {
    const files = GUARD_ROOTS.flatMap((r) => walk(join(repoRoot, r), []));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join(repoRoot, 'e2e', 'driver', 'appDriver.ts'));
  });

  it('G2 no harness file contains a by-name activation', () => {
    const hits: string[] = [];
    for (const f of GUARD_ROOTS.flatMap((r) => walk(join(repoRoot, r), []))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BY_NAME_ACTIVATION.some((re) => re.test(line))) hits.push(`${relative(repoRoot, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
