/**
 * Keepr's Google Messages extension, delivered by the desktop app — BACKLOG-3659
 * (Release 1: unpacked, until the Chrome Web Store listing).
 *
 * The extension's folder ships inside Keepr (package.json build.extraResources
 * → <resources>/chrome-extension). The guided "Sync Android" flow copies it to
 * Downloads/"Keepr Extension", where Chrome's "Load unpacked" can pick it, and
 * shows it in the file manager. Chrome's Extensions page cannot be opened from
 * another app (chrome:// addresses are refused), so Keepr copies the address
 * and starts Chrome; the user pastes it.
 *
 * Dependencies are injected so jest runs it without Electron.
 */

import * as path from "path";

/** The folder name the user picks in Chrome's "Load unpacked". */
export const RCS_EXTENSION_FOLDER_NAME = "Keepr Extension";
/** Chrome's Extensions page (copied for the user to paste). */
export const CHROME_EXTENSIONS_ADDRESS = "chrome://extensions";

export interface DeliveryFs {
  exists(p: string): Promise<boolean>;
  /** Copy a folder (recursive) to a path that does not exist yet. */
  copyDir(from: string, to: string): Promise<void>;
  readText(p: string): Promise<string>;
  /** Recursive; a missing folder is fine. */
  removeDir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Entry names in a folder; [] when it does not exist. */
  listDir(p: string): Promise<string[]>;
}

/** SR: shown when Windows keeps the old folder in use (Explorer, Chrome). */
export const RCS_EXTENSION_FOLDER_BUSY =
  "Close the Keepr Extension folder (and Chrome's extensions page if it's using it), then try again.";

/** Where the shipped extension is: <resources>/chrome-extension, or the repo's folder in development. */
export function extensionSourceDir(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.isPackaged
    ? path.join(opts.resourcesPath, "chrome-extension")
    : path.join(opts.appPath, "chrome-extension");
}

/** Downloads/"Keepr Extension". */
export function extensionTargetDir(downloadsDir: string): string {
  return path.join(downloadsDir, RCS_EXTENSION_FOLDER_NAME);
}

/**
 * Copy the shipped extension to Downloads (again each time: a newer Keepr
 * brings a newer extension; Chrome's "Reload" then picks it up). Returns the
 * folder and the extension's version.
 *
 * SR S1: copied whole into a temp sibling, then swapped in by RENAMES only,
 * so no file of an older build is left behind and the old folder is never
 * half-emptied (Windows may hold it open — EBUSY/EPERM):
 *   1. old "Keepr Extension" → ".old-<ts>"; if that fails the old folder is
 *      untouched and the error says to close it;
 *   2. the copy → "Keepr Extension"; if that fails the old one is renamed back;
 *   3. ".old-<ts>" is deleted best-effort (leftovers swept next time).
 * The copy is removed on every failure path.
 */
export async function prepareExtensionFolder(
  sourceDir: string,
  downloadsDir: string,
  fs: DeliveryFs,
): Promise<{ folder: string; version: string }> {
  const manifest = path.join(sourceDir, "manifest.json");
  if (!(await fs.exists(manifest))) {
    throw new Error("This Keepr build does not include the Google Messages extension.");
  }
  let version = "";
  try {
    const parsed = JSON.parse(await fs.readText(manifest)) as { version?: unknown };
    version = typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    throw new Error("The Google Messages extension in this Keepr build is damaged.");
  }
  const folder = extensionTargetDir(downloadsDir);
  const stamp = `${process.pid}-${Date.now()}-${(runSeq += 1)}`;
  const staging = `${folder}.new-${stamp}`;
  const old = `${folder}.old-${stamp}`;

  // Leftovers of an earlier attempt (best-effort) — never a folder of a run
  // still in flight.
  inFlightNames.add(path.basename(staging));
  inFlightNames.add(path.basename(old));
  try {
    for (const name of await fs.listDir(downloadsDir).catch(() => [] as string[])) {
      if (inFlightNames.has(name)) continue;
      if (name.startsWith(`${RCS_EXTENSION_FOLDER_NAME}.new-`) || name.startsWith(`${RCS_EXTENSION_FOLDER_NAME}.old-`)) {
        await fs.removeDir(path.join(downloadsDir, name)).catch(() => undefined);
      }
    }
    return await swapIn(sourceDir, folder, staging, old, fs, version);
  } finally {
    inFlightNames.delete(path.basename(staging));
    inFlightNames.delete(path.basename(old));
  }
}

let runSeq = 0;
/** Names of the temp folders of runs in flight (the sweep skips them). */
const inFlightNames = new Set<string>();
/** The one run in flight per target folder: concurrent callers share it. */
const inFlight = new Map<string, Promise<{ folder: string; version: string }>>();

/**
 * SR (live ENOENT): React's StrictMode runs the install step's effect twice in
 * development, so two copies started at once and the second one's sweep
 * deleted the first one's temp folder mid-copy. Callers share the one run in
 * flight for the same Downloads folder.
 */
export function prepareExtensionFolderShared(
  sourceDir: string,
  downloadsDir: string,
  fs: DeliveryFs,
): Promise<{ folder: string; version: string }> {
  const key = extensionTargetDir(downloadsDir);
  const running = inFlight.get(key);
  if (running) return running;
  const run = prepareExtensionFolder(sourceDir, downloadsDir, fs).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

/** "0.3.84" < "0.3.80"? Dotted numbers, missing parts as 0; anything unreadable is not older. */
export function isOlderVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (v: string | null | undefined): number[] | null =>
    typeof v === "string" && /^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** A folder's extension version (its manifest), or null. */
export async function folderExtensionVersion(dir: string, fs: DeliveryFs): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readText(path.join(dir, "manifest.json"))) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Live (founder, 2026-10-05): after a Keepr update, Downloads/"Keepr
 * Extension" kept the OLD extension — it was only copied by the install step,
 * which runs only while no extension is seen. At app start (an update
 * restarts the app), a folder the user already has is refreshed when this
 * Keepr bundles a newer extension. No folder → nothing (the install step
 * makes it). Windows holding it open → RCS_EXTENSION_FOLDER_BUSY, tried
 * again next start.
 */
export async function refreshExtensionFolderIfOlder(
  sourceDir: string,
  downloadsDir: string,
  fs: DeliveryFs,
): Promise<{ refreshed: boolean; bundledVersion: string | null; error?: string }> {
  const bundledVersion = await folderExtensionVersion(sourceDir, fs);
  const folder = extensionTargetDir(downloadsDir);
  if (!bundledVersion || !(await fs.exists(folder))) return { refreshed: false, bundledVersion };
  const current = await folderExtensionVersion(folder, fs);
  // A folder with no readable manifest is Keepr's to fix too.
  if (current !== null && !isOlderVersion(current, bundledVersion)) return { refreshed: false, bundledVersion };
  try {
    await prepareExtensionFolderShared(sourceDir, downloadsDir, fs);
    return { refreshed: true, bundledVersion };
  } catch (err) {
    return { refreshed: false, bundledVersion, error: err instanceof Error ? err.message : String(err) };
  }
}

async function swapIn(
  sourceDir: string,
  folder: string,
  staging: string,
  old: string,
  fs: DeliveryFs,
  version: string,
): Promise<{ folder: string; version: string }> {
  try {
    await fs.copyDir(sourceDir, staging);
  } catch (err) {
    await fs.removeDir(staging).catch(() => undefined);
    throw err;
  }

  const hadOld = await fs.exists(folder);
  if (hadOld) {
    try {
      await fs.rename(folder, old);
    } catch {
      await fs.removeDir(staging).catch(() => undefined);
      throw new Error(RCS_EXTENSION_FOLDER_BUSY);
    }
  }
  try {
    await fs.rename(staging, folder);
  } catch (err) {
    if (hadOld) await fs.rename(old, folder).catch(() => undefined);
    await fs.removeDir(staging).catch(() => undefined);
    throw hadOld ? new Error(RCS_EXTENSION_FOLDER_BUSY) : err;
  }
  if (hadOld) await fs.removeDir(old).catch(() => undefined);
  return { folder, version };
}

/** What launchChrome needs of a child process (node's ChildProcess has it). */
export interface LaunchedProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

/**
 * SR F1: start Chrome (the first installed candidate). Resolves true only
 * once the process really started ('spawn'); a launch failure ('error', or a
 * throw) resolves false — never an uncaught exception in the main process.
 */
export async function launchChrome(
  candidates: readonly string[],
  exists: (p: string) => Promise<boolean>,
  start: (candidate: string) => LaunchedProcess,
): Promise<boolean> {
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    let child: LaunchedProcess;
    try {
      child = start(candidate);
    } catch {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  }
  return false;
}

/** Where Google Chrome is usually installed (first that exists wins). */
export function chromeCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
    return roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app"];
  return [];
}
