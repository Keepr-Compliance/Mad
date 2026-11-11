/**
 * BACKLOG-4054 — the UNPACKAGED app launch goes through the sandbox wrapper with the -r isolation
 * guard, and the driver re-checks isolation after launch.
 *
 *   - buildUnpackagedLaunch: wrapper on macOS (never KEEPR_ELECTRON_BIN, never a foreign
 *     executablePath, refuses when the wrapper is missing); `-r <guard>` BEFORE '.'; `=` form + mock;
 *   - readLaunchedIsolation: reads LIVE values (fake electron app + fake sentinel);
 *   - launchedIsolationFailure: guard must have run; userData must equal the requested dir; main.log
 *     must be inside the profile;
 *   - launch.ts source: launchUnpackaged uses the builder, never the raw electron binary;
 *   - appLaunchGuard.js source: refusal first, then the profile-local log redirect.
 *
 * Pure Node → no Electron, no app launch.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appLaunchGuardPath,
  buildUnpackagedLaunch,
  launchedIsolationFailure,
  readLaunchedIsolation,
  sandboxWrapperPath,
} from '../launchArgs';

const repoRoot = join(__dirname, '..', '..', '..');
const PROFILE = '/scratch/qa-profile';
const APP_DATA = '/Users/qa/Library/Application Support';

describe('buildUnpackagedLaunch (BACKLOG-4054)', () => {
  const saved = process.env.KEEPR_ELECTRON_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.KEEPR_ELECTRON_BIN;
    else process.env.KEEPR_ELECTRON_BIN = saved;
  });

  it('C1 macOS: the executable is the in-repo sandbox wrapper', () => {
    const l = buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'darwin');
    expect(l.executablePath).toBe(sandboxWrapperPath(repoRoot));
    expect(l.userDataDir).toBe(PROFILE);
  });

  it('C1b -r <appLaunchGuard.js> comes first and "." right after it', () => {
    const { args } = buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'darwin');
    expect(args.slice(0, 3)).toEqual(['-r', appLaunchGuardPath(repoRoot), '.']);
  });

  it('C1c the = form and --use-mock-keychain follow "."; never the space form', () => {
    const { args } = buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'darwin');
    const dot = args.indexOf('.');
    expect(args.indexOf(`--user-data-dir=${PROFILE}`)).toBeGreaterThan(dot);
    expect(args.indexOf('--use-mock-keychain')).toBeGreaterThan(dot);
    expect(args).not.toContain('--user-data-dir');
  });

  it('C2 refuses when the wrapper is missing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'keepr-4054-norepo-'));
    try {
      expect(() => buildUnpackagedLaunch(bare, { userDataDir: PROFILE }, 'darwin')).toThrow(/unsandboxed/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('C3 refuses a foreign executablePath on macOS', () => {
    const foreign = join(repoRoot, 'package.json');
    expect(() =>
      buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE, executablePath: foreign }, 'darwin'),
    ).toThrow(/not the sandbox wrapper/);
  });

  it('C3a accepts executablePath when it IS the wrapper', () => {
    const w = sandboxWrapperPath(repoRoot);
    expect(buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE, executablePath: w }, 'darwin').executablePath).toBe(w);
  });

  it('C3b macOS ignores KEEPR_ELECTRON_BIN (that variable names the raw node-mode binary)', () => {
    process.env.KEEPR_ELECTRON_BIN = '/usr/bin/false';
    expect(buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'darwin').executablePath).toBe(
      sandboxWrapperPath(repoRoot),
    );
  });

  it('non-macOS: raw electron, guard still loaded before ".", one UNSANDBOXED stderr line', () => {
    process.env.KEEPR_ELECTRON_BIN = '/opt/electron';
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const l = buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'linux');
      expect(l.executablePath).toBe('/opt/electron');
      expect(l.args.slice(0, 3)).toEqual(['-r', appLaunchGuardPath(repoRoot), '.']);
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0][0])).toMatch(/UNSANDBOXED app launch: no sandbox-exec on linux/);
    } finally {
      write.mockRestore();
    }
  });

  it('macOS prints no UNSANDBOXED line', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      buildUnpackagedLaunch(repoRoot, { userDataDir: PROFILE }, 'darwin');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('refuses the default persisted profile', () => {
    expect(() => buildUnpackagedLaunch(repoRoot, {}, 'darwin')).toThrow(/ISOLATED/);
  });
});

describe('readLaunchedIsolation (BACKLOG-4054)', () => {
  type Sentinel = { log?: { transports: { file: { getFile(): { path: string } } } } };
  const g = globalThis as { __keeprAppLaunchGuard?: Sentinel };
  afterEach(() => {
    delete g.__keeprAppLaunchGuard;
  });
  // Distinct value per input, so a constant or a swapped key in readLaunchedIsolation is visible.
  const fakeElectron = (hasMock: boolean) => ({
    app: {
      getPath: (name: 'userData' | 'appData') => (name === 'userData' ? '/live/user-data' : '/live/app-data'),
      commandLine: { hasSwitch: (s: string) => s === 'use-mock-keychain' && hasMock },
    },
  });

  it('SR-a reads userData, appData and the mock switch from the live app', () => {
    g.__keeprAppLaunchGuard = { log: { transports: { file: { getFile: () => ({ path: '/live/log-dir/main.log' }) } } } };
    expect(readLaunchedIsolation(fakeElectron(true))).toEqual({
      actualUserData: '/live/user-data',
      appData: '/live/app-data',
      hasMockKeychain: true,
      guardRan: true,
      logFilePath: '/live/log-dir/main.log',
    });
  });

  it('SR-b reports a missing mock switch as false', () => {
    expect(readLaunchedIsolation(fakeElectron(false)).hasMockKeychain).toBe(false);
  });

  it('SR-c no sentinel: guardRan false, logFilePath null', () => {
    const r = readLaunchedIsolation(fakeElectron(true));
    expect(r.guardRan).toBe(false);
    expect(r.logFilePath).toBeNull();
  });

  it('SR-d is closure-free (Playwright serialises it with toString)', () => {
    const src = readLaunchedIsolation.toString();
    expect(src).not.toMatch(/require\(|import\(|launchedIsolationFailure|seederGuard/);
  });
});

describe('launchedIsolationFailure (BACKLOG-4054)', () => {
  const ok = {
    requested: PROFILE,
    actualUserData: PROFILE,
    appData: APP_DATA,
    hasMockKeychain: true,
    guardRan: true,
    logFilePath: `${PROFILE}/logs/main.log`,
  };

  it('passes for the isolated profile', () => {
    expect(launchedIsolationFailure(ok)).toBeNull();
  });

  it('C5a refuses when the -r guard did not run', () => {
    expect(launchedIsolationFailure({ ...ok, guardRan: false })).toMatch(/guard did not run/);
  });

  it('C5b refuses without the mock keychain', () => {
    expect(launchedIsolationFailure({ ...ok, hasMockKeychain: false })).toMatch(/use-mock-keychain/);
  });

  it('C5c refuses a userData mismatch (app moved userData after the guard)', () => {
    expect(launchedIsolationFailure({ ...ok, actualUserData: `${APP_DATA}/keepr-dev` })).toMatch(/mismatch/);
  });

  it('C5d refuses a requested dir inside a real profile', () => {
    const real = `${APP_DATA}/keepr`;
    expect(launchedIsolationFailure({ ...ok, requested: real, actualUserData: real })).toMatch(/REFUSING/);
  });

  it('C5e a symlinked requested dir compares equal to its realpath', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'keepr-4054-ln-')));
    try {
      const target = join(base, 'real');
      mkdirSync(target);
      const link = join(base, 'link');
      // 'junction': a plain symlink needs elevation on the windows-latest CI leg (seed-isolation.test.ts).
      symlinkSync(target, link, 'junction');
      expect(
        launchedIsolationFailure({ ...ok, requested: link, actualUserData: target, logFilePath: join(target, 'logs', 'main.log') }),
      ).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('launchedIsolationFailure: profile-local main.log (BACKLOG-4054)', () => {
  const ok = {
    requested: PROFILE,
    actualUserData: PROFILE,
    appData: APP_DATA,
    hasMockKeychain: true,
    guardRan: true,
    logFilePath: `${PROFILE}/logs/main.log`,
  };

  it('C7a refuses a main.log outside the profile (the installed app log)', () => {
    expect(
      launchedIsolationFailure({ ...ok, logFilePath: '/Users/qa/Library/Logs/keepr/main.log' }),
    ).toMatch(/main\.log is outside the profile/);
  });

  it('C7b refuses when the log path is unreadable (no redirect on the sentinel)', () => {
    expect(launchedIsolationFailure({ ...ok, logFilePath: null })).toMatch(/log redirect missing/);
  });

  it('C7c refuses a sibling dir that only shares the profile prefix', () => {
    expect(launchedIsolationFailure({ ...ok, logFilePath: `${PROFILE}-other/logs/main.log` })).toMatch(
      /outside the profile/,
    );
  });
});

describe('launch.ts routes launchUnpackaged through the builder (BACKLOG-4054)', () => {
  const src = readFileSync(join(__dirname, '..', 'launch.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function launchUnpackaged'), src.indexOf('export async function launchCdp'));

  it('C4 uses buildUnpackagedLaunch and never resolveElectronBinary', () => {
    expect(body).toMatch(/buildUnpackagedLaunch\(/);
    expect(body).not.toMatch(/resolveElectronBinary/);
  });

  it('C4b re-checks isolation after launch and closes on failure', () => {
    expect(body).toMatch(/launchedIsolationFailure\(/);
    expect(body).toMatch(/app\.evaluate\(readLaunchedIsolation\)/);
    expect(body).toMatch(/if \(failure\) \{\s*await app\.close\(\)[^\n]*\n\s*throw /);
  });
});

describe('appLaunchGuard.js wiring (BACKLOG-4054)', () => {
  const src = readFileSync(appLaunchGuardPath(repoRoot), 'utf8');
  it('C6 exits on refusal and sets the sentinel only after the check', () => {
    expect(src).toMatch(/if \(refusal\) \{[\s\S]*process\.exit\(guard\.GUARD_EXIT_CODE\)/);
    expect(src.indexOf('__keeprAppLaunchGuard =')).toBeGreaterThan(src.indexOf('process.exit('));
  });
  it('C6b feeds the guard the live switch and userData, not constants', () => {
    expect(src).toMatch(/hasMockKeychain: app\.commandLine\.hasSwitch\('use-mock-keychain'\)/);
    expect(src).toMatch(/actualUserData: app\.getPath\('userData'\)/);
    expect(src).toMatch(/parseArgs\(process\.argv/);
  });
  it('C6c redirects the main log into the profile, after the refusal check', () => {
    const exitAt = src.indexOf('process.exit(');
    const redirect = src.match(/log\.transports\.file\.resolvePathFn = \(\) => path\.join\(logsDir, 'main\.log'\);/);
    expect(redirect).not.toBeNull();
    expect(src.indexOf(redirect![0])).toBeGreaterThan(exitAt);
    expect(src).toMatch(/const logsDir = path\.join\(userData, 'logs'\);/);
    expect(src.indexOf("app.setPath('logs', logsDir)")).toBeGreaterThan(exitAt);
    expect(src).toMatch(/__keeprAppLaunchGuard = \{ userData, log \}/);
  });
});
