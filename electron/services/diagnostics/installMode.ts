/**
 * Install-mode derivation (BACKLOG-3432)
 *
 * Reports WHERE the running build was installed, as one of four fixed values,
 * so that a Windows user who is still on a per-machine install after the
 * per-user installer has shipped is identifiable instead of invisible.
 *
 * NEVER report `process.execPath` itself, and never log it. A per-user install
 * path contains the Windows account name
 * (`C:\Users\<name>\AppData\Local\Programs\keepr\Keepr.exe`). The derived value
 * answers the question and carries no personal data. This repository is public.
 *
 * The installer cannot report anything -- NSIS has no channel back to us. The
 * app can, on every session, which is why the signal lives here.
 *
 * Pure on purpose: every input is a parameter, so the table of cases below is
 * testable without an Electron runtime. `getInstallMode()` is the only part
 * that touches `process`.
 */

export type InstallMode = "per-machine" | "per-user" | "other" | "n/a";

export interface InstallModeInput {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `process.execPath`. Used for classification only; never reported. */
  execPath: string;
  /** `app.isPackaged`. An unpackaged build is never an "install". */
  isPackaged: boolean;
  /** `process.env`, or any subset of it. */
  env: Partial<Record<string, string>>;
}

/**
 * Environment variables naming a per-machine install root.
 *
 * All three are read because they disagree by process bitness: for a 32-bit
 * process on 64-bit Windows `%ProgramFiles%` is `C:\Program Files (x86)` while
 * `%ProgramW6432%` is `C:\Program Files`. Keepr ships x64, but reading all
 * three costs nothing and removes the bitness assumption.
 */
const PER_MACHINE_ENV_KEYS = [
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
] as const;

/**
 * Environment variables naming a per-user install root.
 *
 * `%LOCALAPPDATA%` is the default parent of the NSIS per-user directory, but
 * NOT the only possible one: `setInstallModePerUser` resolves
 * `FOLDERID_UserProgramFiles` first, which can be redirected
 * (app-builder-lib 26.15.6, templates/nsis/multiUser.nsh:30-47). A redirected
 * install therefore classifies as "other", not as a false "per-machine".
 */
const PER_USER_ENV_KEYS = ["LOCALAPPDATA"] as const;

/**
 * Last-resort patterns, consulted only after every environment root has failed
 * to match.
 *
 * They exist because the environment roots can be incomplete -- e.g.
 * `%ProgramFiles(x86)%` unset on a machine whose app sits under
 * `C:\Program Files (x86)`. Both are anchored tightly enough that a directory
 * merely CONTAINING the words cannot match: `C:\Program Files Backup\...` fails
 * because the pattern requires a separator (or ` (x86)\`) immediately after
 * `program files`.
 */
const PER_MACHINE_FALLBACK = /^[a-z]:\\program files( \(x86\))?\\/i;
const PER_USER_FALLBACK = /\\appdata\\local\\/i;

/** Lower-case, forward slashes folded to back slashes, trailing separators cut. */
function normalizePath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * True when `child` sits strictly inside `root`.
 *
 * The comparison is on a path-SEGMENT boundary, not a raw string prefix. A raw
 * prefix test reports `C:\Program Files (x86)\Keepr` as living under
 * `C:\Program Files`, and `...\AppData\Locality\...` as living under
 * `...\AppData\Local`. Requiring a separator at the join is what separates
 * those. Equality is not "inside": the executable is never the root itself.
 */
function isUnder(child: string, root: string | undefined): boolean {
  if (!root) return false;
  const normalizedChild = normalizePath(child);
  const normalizedRoot = normalizePath(root);
  if (normalizedRoot.length === 0) return false;
  return (
    normalizedChild.startsWith(normalizedRoot) &&
    normalizedChild[normalizedRoot.length] === "\\"
  );
}

/**
 * Classify the running build's install location.
 *
 * Order is deliberate:
 *   1. non-Windows           -> "n/a"   (the distinction does not exist there)
 *   2. unpackaged            -> "other" (dev build; execPath is electron)
 *   3. under a machine root  -> "per-machine"
 *   4. under a user root     -> "per-user"
 *   5. anything else         -> "other" (portable, redirected, unknown)
 *
 * Machine roots are tested before user roots. They cannot overlap, so the
 * order is a tie-break that never fires -- stated so nobody has to re-derive it.
 */
export function deriveInstallMode(input: InstallModeInput): InstallMode {
  const { platform, execPath, isPackaged, env } = input;

  if (platform !== "win32") return "n/a";
  if (!isPackaged) return "other";
  if (!execPath) return "other";

  const machineRoots = PER_MACHINE_ENV_KEYS.map((key) => env[key]);
  const userRoots = PER_USER_ENV_KEYS.map((key) => env[key]);

  if (machineRoots.some((root) => isUnder(execPath, root))) return "per-machine";
  if (userRoots.some((root) => isUnder(execPath, root))) return "per-user";

  const slashed = execPath.replace(/\//g, "\\");
  if (PER_MACHINE_FALLBACK.test(slashed)) return "per-machine";
  if (PER_USER_FALLBACK.test(slashed)) return "per-user";

  return "other";
}

/**
 * Read the install mode from the live process.
 *
 * `isPackaged` is a parameter rather than an import so that this module never
 * pulls in `electron` -- it stays importable from a plain jest run.
 */
export function getInstallMode(isPackaged: boolean): InstallMode {
  return deriveInstallMode({
    platform: process.platform,
    execPath: process.execPath,
    isPackaged,
    env: process.env,
  });
}
