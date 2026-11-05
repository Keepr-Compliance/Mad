/**
 * BACKLOG-3469: the Settings "Auto-download Updates" switch drives the real
 * updater flag (electron-updater `autoDownload`).
 *
 * - Default ON: only an explicit `updates.autoDownload === false` turns it off.
 * - Applied on every change (preferences:update), on every successful
 *   preferences read (preferences:get), and at startup from the last-known
 *   local copy (BACKLOG-2824) BEFORE the startup update check runs.
 * - The startup read defaults to ON when there is no session, the session has
 *   expired, there is no copy, the copy has no value, the read is slow, or it
 *   fails.
 * - `autoInstallOnAppQuit` is never touched: the switch is about downloading.
 */

import { autoUpdater } from "electron-updater";
import logService from "./logService";
import sessionService from "./sessionService";
import { readPreferencesCopy } from "./preferencesMirror";

const MODULE = "UpdateDownloadPolicy";

/** How long the startup read may take before the default (ON) is used. */
export const STORED_AUTO_DOWNLOAD_TIMEOUT_MS = 3000;

/** The updater surface this module needs (electron-updater's autoUpdater). */
export interface AutoDownloadTarget {
  autoDownload: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The switch value held in a preferences bag (or a partial of one).
 * True unless the bag says `updates.autoDownload === false`.
 */
export function autoDownloadFromPreferences(preferences: unknown): boolean {
  if (!isPlainObject(preferences)) return true;
  const updates = preferences.updates;
  if (!isPlainObject(updates)) return true;
  return updates.autoDownload !== false;
}

/**
 * The explicit boolean a partial update carries, or null when it carries none.
 */
export function autoDownloadInPartial(partial: unknown): boolean | null {
  if (!isPlainObject(partial)) return null;
  const updates = partial.updates;
  if (!isPlainObject(updates)) return null;
  return typeof updates.autoDownload === "boolean" ? updates.autoDownload : null;
}

/** Set the updater's autoDownload flag. Never throws. */
export function applyAutoDownload(
  value: boolean,
  updater: AutoDownloadTarget = autoUpdater,
): void {
  try {
    if (updater.autoDownload !== value) {
      logService.info(`[Updates] Auto-download ${value ? "on" : "off"}`, MODULE);
    }
    updater.autoDownload = value;
  } catch (error) {
    logService.warn("[Updates] Could not set auto-download", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readStoredValue(): Promise<boolean> {
  // Read-only peek for the user id: never removes or rewrites the session file.
  const peek = await sessionService.peekSession();
  if (peek.status !== "ok") return true;
  const session = peek.session;
  if (session.expiresAt && Date.now() > session.expiresAt) return true;
  const userId = session.user?.id;
  if (typeof userId !== "string" || !userId) return true;
  const copy = await readPreferencesCopy(userId);
  if (!copy) return true;
  return autoDownloadFromPreferences(copy.preferences);
}

/**
 * The last-known switch value from the local preferences copy. Resolves true
 * on any missing leg, on a read slower than `timeoutMs`, or on an error.
 * Never rejects.
 */
export function readStoredAutoDownload(
  timeoutMs: number = STORED_AUTO_DOWNLOAD_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      logService.warn("[Updates] Stored auto-download read timed out; using on", MODULE);
      finish(true);
    }, timeoutMs);
    readStoredValue().then(finish, (error: unknown) => {
      logService.warn("[Updates] Stored auto-download read failed; using on", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      finish(true);
    });
  });
}

/**
 * Startup: read the stored value, apply it, and only THEN run the check.
 * electron-updater reads `autoDownload` inside checkForUpdates, so the flag
 * must be set before `runCheck` is called.
 */
export async function runStartupUpdateCheck<T>(
  updater: AutoDownloadTarget,
  runCheck: () => T,
  timeoutMs: number = STORED_AUTO_DOWNLOAD_TIMEOUT_MS,
): Promise<T> {
  const value = await readStoredAutoDownload(timeoutMs);
  applyAutoDownload(value, updater);
  return runCheck();
}

/**
 * Whether the error-recovery path may re-download. Only when an update was
 * offered this cycle AND auto-download is on: with the switch off, recovery
 * never starts a download.
 */
export function recoveryMayDownload(
  updater: AutoDownloadTarget,
  updateAvailableThisCycle: boolean,
): boolean {
  return updateAvailableThisCycle && updater.autoDownload === true;
}
