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
 *   electron-updater AppUpdater.js:44).
 * - main.ts applies the off value when the updater is configured, before any
 *   update check can run; the startup read then applies the stored value
 *   before the startup check (updateDownloadPolicy.runStartupUpdateCheck).
 * - A sign-out, or a session for a different user, applies off at once
 *   (installBetaUpdatesSessionReset). A session re-saved for the user whose
 *   value is applied (token refresh) changes nothing. The next good read for
 *   the new user applies that user's value.
 * - Every write naming the preference (start and finish) and every session
 *   change advances one counter. A read applies its value only if the counter
 *   did not move while it ran.
 */

import { autoUpdater } from "electron-updater";
import logService from "./logService";
import { onSessionChanged, type SessionChange } from "./authEvents";

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

let changeCounter = 0;
/** The user whose value was last applied (null: none, or signed out). */
let appliedForUser: string | null = null;

/** The current value of the change counter (capture before a read). */
export function betaUpdatesChangeCount(): number {
  return changeCounter;
}

/** Advance the change counter; returns the new value. */
export function noteBetaUpdatesChange(): number {
  changeCounter += 1;
  return changeCounter;
}

/**
 * Apply a value read or written for `userId`, and remember whose it is.
 * Never throws.
 */
export function applyBetaUpdatesFor(
  userId: string | null,
  value: boolean,
  updater: PrereleaseTarget = autoUpdater,
): void {
  appliedForUser = userId;
  applyBetaUpdates(value, updater);
}

/**
 * A session change: off at once unless it is the same user's session saved
 * again. Never throws.
 */
export function handleSessionChangeForBetaUpdates(
  change: SessionChange,
  updater: PrereleaseTarget = autoUpdater,
): void {
  try {
    const sameUser =
      change.kind === "saved" &&
      typeof change.userId === "string" &&
      change.userId.length > 0 &&
      change.userId === appliedForUser;
    if (sameUser) return;
    noteBetaUpdatesChange();
    appliedForUser = null;
    applyBetaUpdates(false, updater);
  } catch {
    // applyBetaUpdates never throws; nothing else here can.
  }
}

/** Subscribe the reset to session changes. Returns an unsubscribe. */
export function installBetaUpdatesSessionReset(updater?: PrereleaseTarget): () => void {
  return onSessionChanged((change) => handleSessionChangeForBetaUpdates(change, updater));
}

/** Tests only. */
export function resetBetaUpdatesStateForTests(): void {
  changeCounter = 0;
  appliedForUser = null;
}
