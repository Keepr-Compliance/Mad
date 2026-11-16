/**
 * BACKLOG-4245: the beta-updates preference and the account's eligibility
 * drive which releases the updater considers (electron-updater
 * `allowPrerelease`).
 *
 * - Stored as `updates.betaUpdates` in the same preferences bag (and local
 *   copy) as `updates.autoDownload` (BACKLOG-3469). Only an explicit `true` is
 *   on.
 * - Eligibility is the plan feature `beta_updates`, read in the main process
 *   (betaUpdatesHandlers). "allowed" is the only state that grants.
 * - `allowPrerelease` is true only when, for the same signed-in user, the
 *   stored value is true AND eligibility is "allowed". `recompute` is the only
 *   code that can write true; the other exported writer only writes off.
 *   A prerelease build grants nothing.
 * - Every write sets `allowDowngrade = false`. `channel` is never assigned
 *   (its setter sets `allowDowngrade = true`, electron-updater AppUpdater.js:44).
 * - A sign-out, or a session for a different user, clears both inputs and
 *   writes off. The same user's session saved again (token refresh) changes
 *   nothing.
 * - Counters: a read applies only if no write naming the preference started or
 *   finished, and no session change happened, while it ran. A turn-on applies
 *   only if it is the latest write started and no session change happened
 *   since it started.
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

export type BetaEligibilityState = "allowed" | "blocked" | "unknown";

interface StoredInput {
  userId: string;
  value: boolean;
}

interface EligibilityInput {
  userId: string;
  state: BetaEligibilityState;
}

let storedFor: StoredInput | null = null;
let eligibleFor: EligibilityInput | null = null;

/** Advances on every write start/finish and every session change. */
let changeCounter = 0;
/** Advances when a write naming the preference starts. */
let writeSeq = 0;
/** Advances on every session change that counts as a change. */
let sessionEpoch = 0;

type StoredListener = (userId: string, value: boolean) => void;
const storedListeners = new Set<StoredListener>();

function writeOff(updater: PrereleaseTarget): void {
  try {
    if (updater.allowPrerelease !== false) {
      logService.info("[Updates] Beta updates off", MODULE);
    }
    updater.allowPrerelease = false;
  } catch (error) {
    logService.warn("[Updates] Could not set beta updates", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  writeDowngradeOff(updater);
}

function writeDowngradeOff(updater: PrereleaseTarget): void {
  try {
    updater.allowDowngrade = false;
  } catch (error) {
    logService.warn("[Updates] Could not set downgrade off", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Prereleases off and downgrades off. Never throws. Never writes true. */
export function applyBetaUpdatesOff(updater: PrereleaseTarget = autoUpdater): void {
  writeOff(updater);
}

/**
 * The single place that can write `allowPrerelease = true`: the stored value
 * and eligibility for the same user, both positive. Never throws.
 */
export function recompute(updater: PrereleaseTarget = autoUpdater): boolean {
  const allow =
    storedFor !== null &&
    storedFor.value === true &&
    eligibleFor !== null &&
    eligibleFor.state === "allowed" &&
    eligibleFor.userId === storedFor.userId;
  if (!allow) {
    writeOff(updater);
    return false;
  }
  try {
    if (updater.allowPrerelease !== true) {
      logService.info("[Updates] Beta updates on", MODULE);
    }
    updater.allowPrerelease = true;
  } catch (error) {
    logService.warn("[Updates] Could not set beta updates", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  writeDowngradeOff(updater);
  return true;
}

/** Record the stored preference for a signed-in user, then recompute. */
export function recordStoredBetaUpdates(
  userId: string,
  value: boolean,
  updater: PrereleaseTarget = autoUpdater,
): void {
  storedFor = { userId, value: value === true };
  for (const listener of Array.from(storedListeners)) {
    try {
      listener(userId, value === true);
    } catch {
      // A listener never breaks recording the preference.
    }
  }
  recompute(updater);
}

/** Forget the stored preference (no value could be read), then recompute. */
export function clearStoredBetaUpdates(updater: PrereleaseTarget = autoUpdater): void {
  storedFor = null;
  recompute(updater);
}

/** Record an eligibility answer for a user, then recompute. */
export function recordBetaEligibility(
  userId: string,
  state: BetaEligibilityState,
  updater: PrereleaseTarget = autoUpdater,
): boolean {
  eligibleFor = { userId, state };
  return recompute(updater);
}

/** Subscribe to stored-preference records. Returns an unsubscribe. */
export function onStoredBetaUpdatesRecorded(listener: StoredListener): () => void {
  storedListeners.add(listener);
  return () => {
    storedListeners.delete(listener);
  };
}

/** What is recorded now (copies). */
export function getBetaUpdatesInputs(): {
  stored: StoredInput | null;
  eligibility: EligibilityInput | null;
} {
  return {
    stored: storedFor ? { ...storedFor } : null,
    eligibility: eligibleFor ? { ...eligibleFor } : null,
  };
}

/** The current value of the change counter (capture before a read). */
export function betaUpdatesChangeCount(): number {
  return changeCounter;
}

/** Advance the change counter (a write naming the preference finished). */
export function noteBetaUpdatesChange(): number {
  changeCounter += 1;
  return changeCounter;
}

/** The current session epoch (capture before an eligibility read). */
export function betaUpdatesSessionEpoch(): number {
  return sessionEpoch;
}

export interface BetaWriteToken {
  seq: number;
  epoch: number;
}

/** A write naming the preference starts. */
export function noteBetaUpdatesWriteStart(): BetaWriteToken {
  writeSeq += 1;
  changeCounter += 1;
  return { seq: writeSeq, epoch: sessionEpoch };
}

/** True when no later write started and no session change happened. */
export function isLatestBetaUpdatesWrite(token: BetaWriteToken): boolean {
  return token.seq === writeSeq && token.epoch === sessionEpoch;
}

/**
 * A session change: inputs cleared and off at once, unless it is the same
 * user's session saved again. Never throws.
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
      storedFor !== null &&
      change.userId === storedFor.userId;
    if (sameUser) return;
    sessionEpoch += 1;
    changeCounter += 1;
    storedFor = null;
    eligibleFor = null;
    writeOff(updater);
  } catch {
    // writeOff never throws; nothing else here can.
  }
}

/** Subscribe the reset to session changes. Returns an unsubscribe. */
export function installBetaUpdatesSessionReset(updater?: PrereleaseTarget): () => void {
  return onSessionChanged((change) => handleSessionChangeForBetaUpdates(change, updater));
}

/** Tests only. */
export function resetBetaUpdatesStateForTests(): void {
  storedFor = null;
  eligibleFor = null;
  changeCounter = 0;
  writeSeq = 0;
  sessionEpoch = 0;
  storedListeners.clear();
}
