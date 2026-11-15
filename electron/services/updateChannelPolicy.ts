/**
 * BACKLOG-4245: the beta-updates preference drives which releases the updater
 * considers (electron-updater `allowPrerelease`).
 *
 * - Stored as `updates.betaUpdates` in the same preferences bag (and local
 *   copy) as `updates.autoDownload` (BACKLOG-3469).
 * - Only an explicit `updates.betaUpdates === true` turns prereleases on.
 *   Absent, any other value, or a failed read: off. This also holds when the
 *   running build is itself a prerelease (the library would default to on,
 *   electron-updater AppUpdater.js:218); the preference wins both ways.
 * - Every apply sets `allowPrerelease` AND `allowDowngrade = false`.
 * - `channel` is never assigned (its setter sets `allowDowngrade = true`,
 *   electron-updater AppUpdater.js:43-44).
 * - main.ts applies the off value when the updater is configured, before any
 *   update check can run; the startup read then applies the stored value
 *   before the startup check (updateDownloadPolicy.runStartupUpdateCheck).
 */

import { autoUpdater } from "electron-updater";
import logService from "./logService";

const MODULE = "UpdateChannelPolicy";

/** The updater surface this module needs (electron-updater's autoUpdater). */
export interface PrereleaseTarget {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The preference value held in a preferences bag (or a partial of one).
 * True only when the bag says `updates.betaUpdates === true`.
 */
export function betaUpdatesFromPreferences(preferences: unknown): boolean {
  try {
    if (!isPlainObject(preferences)) return false;
    const updates = preferences.updates;
    if (!isPlainObject(updates)) return false;
    return updates.betaUpdates === true;
  } catch {
    return false;
  }
}

/**
 * What a partial update carries for the preference: null when it does not
 * name `updates.betaUpdates`, otherwise true only for an explicit true.
 */
export function betaUpdatesInPartial(partial: unknown): boolean | null {
  try {
    if (!isPlainObject(partial)) return null;
    const updates = partial.updates;
    if (!isPlainObject(updates)) return null;
    if (!Object.prototype.hasOwnProperty.call(updates, "betaUpdates")) return null;
    return updates.betaUpdates === true;
  } catch {
    return false;
  }
}

/**
 * Set the updater's prerelease flag from the preference, and force
 * downgrades off. Never throws.
 */
export function applyBetaUpdates(
  value: boolean,
  updater: PrereleaseTarget = autoUpdater,
): void {
  const allow = value === true;
  try {
    if (updater.allowPrerelease !== allow) {
      logService.info(`[Updates] Beta updates ${allow ? "on" : "off"}`, MODULE);
    }
    updater.allowPrerelease = allow;
  } catch (error) {
    logService.warn("[Updates] Could not set beta updates", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    updater.allowDowngrade = false;
  } catch (error) {
    logService.warn("[Updates] Could not set downgrade off", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
