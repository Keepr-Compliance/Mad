import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveElectronBinary } from './paths';
import type { AppDriverOptions } from './types';

/**
 * App launch argv, kept free of Playwright imports so the Node jest run can unit-test it.
 */

export function isDefaultProfile(opts: AppDriverOptions): boolean {
  return opts.reuseProfile !== false && !opts.userDataDir;
}

/**
 * Build the app args, adding --user-data-dir only when an isolated profile is requested.
 *
 * BACKLOG-4093: an isolated profile also gets --use-mock-keychain, so the app under test reads the
 * seeder's mock-keychain DB key and never asks the macOS login keychain for the installed app's
 * "keepr Safe Storage" item. The DEFAULT-profile branch must NOT get it: a mock keychain cannot
 * decrypt the real profile's key.
 */
export function buildArgs(opts: AppDriverOptions): { args: string[]; userDataDir: string } {
  const extra = opts.extraArgs ?? [];
  if (isDefaultProfile(opts)) {
    // Reuse the persisted profile: do NOT pass --user-data-dir; the app uses its default.
    return { args: [...extra], userDataDir: '<default persisted profile>' };
  }
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'keepr-e2e-'));
  // Electron maps the Chromium --user-data-dir switch onto app userData (`=` form only).
  return { args: [`--user-data-dir=${userDataDir}`, '--use-mock-keychain', ...extra], userDataDir };
}

export interface UnpackagedLaunch {
  executablePath: string;
  args: string[];
  userDataDir: string;
}

/** In-repo sandbox wrapper and the `-r` guard every unpackaged app launch goes through (BACKLOG-4054). */
export function sandboxWrapperPath(repoRoot: string): string {
  return join(repoRoot, 'scripts', 'qa', 'harness', 'electron-sandboxed.sh');
}
export function appLaunchGuardPath(repoRoot: string): string {
  return join(repoRoot, 'scripts', 'qa', 'harness', 'appLaunchGuard.js');
}

/**
 * BACKLOG-4054: the executable + argv for `_electron.launch` of the UNPACKAGED app.
 *
 * macOS: ALWAYS the in-repo sandbox wrapper (electron-sandboxed.sh, which execs sandbox-exec, which
 * execs Electron, so Playwright's stderr attach and process-group kill are unchanged). KEEPR_ELECTRON_BIN
 * is NOT consulted here: it names the raw binary the node-mode DB readers use. An explicit
 * opts.executablePath is accepted only when it IS the wrapper. A missing wrapper refuses the launch.
 * `-r <appLaunchGuard.js>` must precede `.` so the guard runs before the app's entry.
 * Other platforms: raw electron (no sandbox-exec), guard still loaded.
 */
export function buildUnpackagedLaunch(
  repoRoot: string,
  opts: AppDriverOptions,
  platform: NodeJS.Platform = process.platform,
): UnpackagedLaunch {
  if (isDefaultProfile(opts)) {
    throw new Error('[keepr-e2e] unpackaged launch requires an ISOLATED profile (reuseProfile:false or userDataDir).');
  }
  const guard = appLaunchGuardPath(repoRoot);
  let executablePath: string;
  if (platform === 'darwin') {
    const wrapper = sandboxWrapperPath(repoRoot);
    if (!existsSync(wrapper)) {
      throw new Error(`[keepr-e2e] sandbox wrapper not found at ${wrapper}. Refusing to launch the app unsandboxed.`);
    }
    if (opts.executablePath && realpathSync(opts.executablePath) !== realpathSync(wrapper)) {
      throw new Error(
        `[keepr-e2e] executablePath ${opts.executablePath} is not the sandbox wrapper. Refusing to launch the app unsandboxed.`,
      );
    }
    executablePath = wrapper;
  } else {
    executablePath = resolveElectronBinary(repoRoot, opts.executablePath);
    process.stderr.write(`[keepr-e2e] UNSANDBOXED app launch: no sandbox-exec on ${platform} (guard still loaded)\n`);
  }
  const { args, userDataDir } = buildArgs(opts);
  return { executablePath, args: ['-r', guard, '.', ...args], userDataDir };
}

interface GuardModule {
  resolveReal: (p: string) => string;
  isSameOrUnder: (child: string, parent: string) => boolean;
  isolationFailure: (p: {
    hasMockKeychain: boolean;
    opts: { userDataDir?: string };
    actualUserData: string;
    appData: string;
    label?: string;
  }) => string | null;
}

/** What the driver reads from the launched app's main process (BACKLOG-4054). */
export interface LaunchedIsolation {
  actualUserData: string;
  appData: string;
  hasMockKeychain: boolean;
  guardRan: boolean;
  /** electron-log's file transport path, read through the guard's sentinel; null if unavailable. */
  logFilePath: string | null;
}

/** The slice of the `electron` module that readLaunchedIsolation touches. */
export interface LaunchedElectron {
  app: { getPath(name: 'userData' | 'appData'): string; commandLine: { hasSwitch(name: string): boolean } };
}

/**
 * BACKLOG-4054: runs INSIDE the launched main process via `app.evaluate(readLaunchedIsolation)`.
 * Playwright serialises it with toString(), so it must stay closure-free: no imports, no outer
 * variables, no helpers. Reads live values; the driver judges them with launchedIsolationFailure.
 */
export function readLaunchedIsolation(electron: LaunchedElectron): LaunchedIsolation {
  const a = electron.app;
  const sentinel = (globalThis as { __keeprAppLaunchGuard?: { log?: { transports: { file: { getFile(): { path: string } } } } } })
    .__keeprAppLaunchGuard;
  let logFilePath: string | null = null;
  if (sentinel && sentinel.log) {
    try {
      logFilePath = sentinel.log.transports.file.getFile().path;
    } catch {
      logFilePath = null;
    }
  }
  return {
    actualUserData: a.getPath('userData'),
    appData: a.getPath('appData'),
    hasMockKeychain: a.commandLine.hasSwitch('use-mock-keychain'),
    guardRan: Boolean(sentinel),
    logFilePath,
  };
}

/**
 * BACKLOG-4054: driver-side re-check after launch, on values read from the running main process.
 * Same rules as the -r guard (seederGuard.isolationFailure), plus: the guard must have run, and the
 * main log must be inside the requested profile (the guard redirects it there).
 */
export function launchedIsolationFailure(p: LaunchedIsolation & { requested: string }): string | null {
  if (!p.guardRan) return 'app-launch guard did not run in the main process (-r appLaunchGuard.js missing or after ".").';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const guard = require('../../scripts/qa/harness/seederGuard.js') as GuardModule;
  const failure = guard.isolationFailure({
    hasMockKeychain: p.hasMockKeychain,
    opts: { userDataDir: p.requested },
    actualUserData: p.actualUserData,
    appData: p.appData,
    label: 'app-launch',
  });
  if (failure) return failure;
  if (!p.logFilePath) return 'app-launch log redirect missing: main.log path not readable from the guard sentinel.';
  const logReal = guard.resolveReal(p.logFilePath);
  const profileReal = guard.resolveReal(p.requested);
  if (!guard.isSameOrUnder(logReal, profileReal)) {
    return `app-launch main.log is outside the profile: ${logReal} is not under ${profileReal}.`;
  }
  return null;
}
