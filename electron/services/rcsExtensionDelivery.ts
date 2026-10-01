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
  /** Copy a folder (recursive), replacing what is there. */
  copyDir(from: string, to: string): Promise<void>;
  readText(p: string): Promise<string>;
}

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
  await fs.copyDir(sourceDir, folder);
  return { folder, version };
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
