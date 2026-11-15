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
 *
 * BACKLOG-4245: the same startup read also yields the beta-updates
 * preference (updateChannelPolicy). On every missing leg, slow read or error
 * it is OFF, while auto-download stays ON.
 */

import { autoUpdater } from "electron-updater";
import logService from "./logService";
import sessionService from "./sessionService";
import { readPreferencesCopy } from "./preferencesMirror";
import {
  applyBetaUpdatesFor,
  betaUpdatesChangeCount,
  betaUpdatesFromPreferences,
  type PrereleaseTarget,
} from "./updateChannelPolicy";

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

/** The updater preferences read at startup. */
export interface StoredUpdatePreferences {
  autoDownload: boolean;
  betaUpdates: boolean;
  /** The user whose copy was read; null when none was. */
  userId?: string | null;
}

/** Used for every missing leg, a slow read and an error. */
export const STORED_UPDATE_DEFAULTS: Readonly<StoredUpdatePreferences> = Object.freeze({
  autoDownload: true,
  betaUpdates: false,
});

async function readStoredValues(): Promise<StoredUpdatePreferences> {
  // Read-only peek for the user id: never removes or rewrites the session file.
  const peek = await sessionService.peekSession();
  if (peek.status !== "ok") return { ...STORED_UPDATE_DEFAULTS };
  const session = peek.session;
  if (session.expiresAt && Date.now() > session.expiresAt) return { ...STORED_UPDATE_DEFAULTS };
  const userId = session.user?.id;
  if (typeof userId !== "string" || !userId) return { ...STORED_UPDATE_DEFAULTS };
  const copy = await readPreferencesCopy(userId);
  if (!copy) return { ...STORED_UPDATE_DEFAULTS };
  return {
    autoDownload: autoDownloadFromPreferences(copy.preferences),
    betaUpdates: betaUpdatesFromPreferences(copy.preferences),
    userId,
  };
}

/**
 * The last-known updater preferences from the local preferences copy.
 * Resolves the defaults (auto-download on, beta updates off) on any missing
 * leg, on a read slower than `timeoutMs`, or on an error. Never rejects.
 */
export function readStoredUpdatePreferences(
  timeoutMs: number = STORED_AUTO_DOWNLOAD_TIMEOUT_MS,
): Promise<StoredUpdatePreferences> {
  return new Promise<StoredUpdatePreferences>((resolve) => {
    let settled = false;
    const finish = (value: StoredUpdatePreferences): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      logService.warn("[Updates] Stored update preferences read timed out; using defaults", MODULE);
      finish({ ...STORED_UPDATE_DEFAULTS });
    }, timeoutMs);
    let pending: Promise<StoredUpdatePreferences>;
    try {
      pending = readStoredValues();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(finish, (error: unknown) => {
      logService.warn("[Updates] Stored update preferences read failed; using defaults", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      finish({ ...STORED_UPDATE_DEFAULTS });
    });
  });
}

/**
 * The last-known switch value from the local preferences copy. Resolves true
 * on any missing leg, on a read slower than `timeoutMs`, or on an error.
 * Never rejects.
 */
export async function readStoredAutoDownload(
  timeoutMs: number = STORED_AUTO_DOWNLOAD_TIMEOUT_MS,
): Promise<boolean> {
  return (await readStoredUpdatePreferences(timeoutMs)).autoDownload;
}

/**
 * Startup: read the stored values, apply them, and only THEN run the check.
 * electron-updater reads `autoDownload` and `allowPrerelease` inside
 * checkForUpdates, so both must be set before `runCheck` is called. A failure
 * here never stops the check from running.
 */
export async function runStartupUpdateCheck<T>(
  updater: AutoDownloadTarget & Partial<PrereleaseTarget>,
  runCheck: () => T,
  timeoutMs: number = STORED_AUTO_DOWNLOAD_TIMEOUT_MS,
): Promise<T> {
  let stored: StoredUpdatePreferences = { ...STORED_UPDATE_DEFAULTS };
  const betaChangesAtRead = betaUpdatesChangeCount();
  try {
    stored = await readStoredUpdatePreferences(timeoutMs);
  } catch {
    stored = { ...STORED_UPDATE_DEFAULTS };
  }
  applyAutoDownload(stored.autoDownload, updater);
  // A write or a session change during the read makes the stored value
  // stale: keep what they applied (a session change applies off).
  if (betaUpdatesChangeCount() === betaChangesAtRead) {
    applyBetaUpdatesFor(stored.userId ?? null, stored.betaUpdates, updater as PrereleaseTarget);
  }
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
