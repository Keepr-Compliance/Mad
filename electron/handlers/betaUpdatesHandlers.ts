/**
 * BACKLOG-4245: eligibility for beta versions, and the Settings state of the
 * "Get beta versions" switch.
 *
 * Eligibility is the plan feature `beta_updates`, read with the strict
 * (fail-closed) reader `resolveStrictFeatureState` (featureGateHandlers). Only
 * "allowed" grants; no session, a failed lookup, a null or empty plan map, a
 * throw and a timeout are all "unknown"; no organization or a missing key is
 * "blocked". The answer is recorded in updateChannelPolicy, which recomputes
 * `allowPrerelease`.
 *
 * When eligibility is read (all bounded, never awaited by the startup check):
 * - after the stored value is recorded as on (startup read, preferences:get,
 *   preferences:update);
 * - every 5 minutes while the stored value is on and eligibility is unknown;
 * - before every periodic and manual update check, for a stored-on user;
 * - when Settings asks for the switch state.
 * A user whose stored value is off triggers none of these except Settings.
 *
 * Once per session, the first time eligibility is confirmed for a stored-on
 * user, one extra update check runs (skipped while a check is running or once
 * an update has been offered).
 */

import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdater } from "electron-updater";
import logService from "../services/logService";
import sessionService from "../services/sessionService";
import supabaseService from "../services/supabaseService";
import { isStoreBuild } from "../services/distributionChannelService";
import { onSessionChanged } from "../services/authEvents";
import { readPreferencesCopy } from "../services/preferencesMirror";
import { checkForUpdatesUnlessStore } from "../services/selfUpdatePolicy";
import {
  betaUpdatesFromPreferences,
  betaUpdatesSessionEpoch,
  getBetaUpdatesInputs,
  onStoredBetaUpdatesRecorded,
  recordBetaEligibility,
  type BetaEligibilityState,
  type PrereleaseTarget,
} from "../services/updateChannelPolicy";
import { resolveStrictFeatureState } from "./featureGateHandlers";
import type { BetaUpdatesState } from "../types/ipc/window-api-services";

const MODULE = "BetaUpdates";

/** Bound for a read triggered by a stored value or the retry timer. */
export const BETA_ELIGIBILITY_TIMEOUT_MS = 10_000;
/** Bound for a read before an update check or for Settings. */
export const BETA_ELIGIBILITY_QUICK_TIMEOUT_MS = 5_000;
/** Retry interval while the stored value is on and eligibility is unknown. */
export const BETA_ELIGIBILITY_RETRY_MS = 5 * 60 * 1000;

type Timer = ReturnType<typeof setInterval>;

/** The updater surface this module needs. */
export type BetaUpdaterTarget = PrereleaseTarget & Pick<AppUpdater, "on" | "checkForUpdates">;

export interface BetaUpdatesDeps {
  resolveState: () => Promise<BetaEligibilityState>;
  /** The user the session file names (null when none or expired). */
  sessionFileUserId: () => Promise<string | null>;
  /** The user of the in-memory Supabase session (null when none). */
  memorySessionUserId: () => Promise<string | null>;
  readStoredForUser: (userId: string) => Promise<boolean>;
  isStoreBuild: () => boolean;
  isPackaged: () => boolean;
  extraCheck: () => void;
  setInterval: (fn: () => void, ms: number) => Timer;
  clearInterval: (t: Timer) => void;
  onQuit: (fn: () => void) => void;
}

function defaultDeps(updater: BetaUpdaterTarget): BetaUpdatesDeps {
  return {
    resolveState: () => resolveStrictFeatureState("beta_updates"),
    sessionFileUserId: async () => {
      const peek = await sessionService.peekSession();
      if (peek.status !== "ok") return null;
      const session = peek.session;
      if (session.expiresAt && Date.now() > session.expiresAt) return null;
      const id = session.user?.id;
      return typeof id === "string" && id ? id : null;
    },
    memorySessionUserId: async () => {
      const { data } = await supabaseService.getClient().auth.getSession();
      const id = data?.session?.user?.id;
      return typeof id === "string" && id ? id : null;
    },
    readStoredForUser: async (userId) => {
      const copy = await readPreferencesCopy(userId);
      return copy ? betaUpdatesFromPreferences(copy.preferences) : false;
    },
    isStoreBuild: () => isStoreBuild(),
    isPackaged: () => app.isPackaged,
    extraCheck: () => {
      checkForUpdatesUnlessStore(updater, "periodic")
        ?.then((result) => {
          result?.downloadPromise?.catch(() => {
            /* surfaced via the tagged autoUpdater "error" event */
          });
        })
        .catch(() => {
          /* surfaced via the tagged autoUpdater "error" event */
        });
    },
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearInterval: (t) => clearInterval(t),
    onQuit: (fn) => {
      app.on("before-quit", fn);
    },
  };
}

let deps: BetaUpdatesDeps | null = null;
let target: BetaUpdaterTarget | null = null;
let inFlight: Promise<BetaEligibilityState> | null = null;
let retryTimer: Timer | null = null;
let extraCheckDone = false;
let checkRunning = false;
let updateOffered = false;

function storedOnUser(): string | null {
  const { stored } = getBetaUpdatesInputs();
  return stored && stored.value === true ? stored.userId : null;
}

function withTimeout(p: Promise<BetaEligibilityState>, ms: number): Promise<BetaEligibilityState> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve("unknown");
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve("unknown");
      },
    );
  });
}

/** Reports the session user as soon as it is known, so a later throw or timeout is recorded for that user. */
async function readEligibility(d: BetaUpdatesDeps, onUser: (userId: string) => void): Promise<BetaEligibilityState> {
  const userId = await d.sessionFileUserId();
  if (!userId) return "unknown";
  onUser(userId);
  const memoryUser = await d.memorySessionUserId();
  if (memoryUser !== userId) return "unknown";
  return d.resolveState();
}

function syncRetryTimer(): void {
  const d = deps;
  if (!d) return;
  const user = storedOnUser();
  const { eligibility } = getBetaUpdatesInputs();
  const known =
    eligibility !== null && eligibility.userId === user && eligibility.state !== "unknown";
  const want = user !== null && !known;
  if (want && !retryTimer) {
    retryTimer = d.setInterval(() => {
      void refreshBetaEligibility(BETA_ELIGIBILITY_TIMEOUT_MS);
    }, BETA_ELIGIBILITY_RETRY_MS);
  } else if (!want && retryTimer) {
    d.clearInterval(retryTimer);
    retryTimer = null;
  }
}

function maybeExtraCheck(): void {
  const d = deps;
  if (!d || extraCheckDone || checkRunning || updateOffered) return;
  const user = storedOnUser();
  const { eligibility } = getBetaUpdatesInputs();
  if (!user || !eligibility || eligibility.userId !== user || eligibility.state !== "allowed") return;
  extraCheckDone = true;
  try {
    d.extraCheck();
  } catch {
    // never breaks the eligibility read
  }
}

/**
 * Read eligibility for the session user (bounded) and record it. One read at
 * a time. Never rejects. A result read across a session change is dropped.
 */
export function refreshBetaEligibility(
  timeoutMs: number = BETA_ELIGIBILITY_TIMEOUT_MS,
): Promise<BetaEligibilityState> {
  const d = deps;
  if (!d) return Promise.resolve("unknown");
  if (inFlight) return inFlight;
  const epoch = betaUpdatesSessionEpoch();
  const run = (async (): Promise<BetaEligibilityState> => {
    let userId: string | null = null;
    let state: BetaEligibilityState = "unknown";
    try {
      const read = readEligibility(d, (id) => {
        userId = id;
      });
      state = await withTimeout(read, timeoutMs);
    } catch {
      state = "unknown";
    }
    if (userId && epoch === betaUpdatesSessionEpoch()) {
      recordBetaEligibility(userId, state, target ?? undefined);
      maybeExtraCheck();
    }
    syncRetryTimer();
    return state;
  })().catch((): BetaEligibilityState => "unknown");
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

/**
 * Before an update check: null when nothing needs to happen (the stored
 * value is not on), so the caller checks at once with no added wait;
 * otherwise a bounded eligibility read the caller awaits first.
 */
export function betaEligibilityBeforeCheck(): Promise<void> | null {
  if (!deps || storedOnUser() === null) return null;
  return refreshBetaEligibility(BETA_ELIGIBILITY_QUICK_TIMEOUT_MS).then(() => undefined);
}

/** Run `check` after the pre-check eligibility read, or at once when none is needed. */
export function runAfterBetaEligibility<T>(check: () => Promise<T> | null): Promise<T | null> | null {
  const pre = betaEligibilityBeforeCheck();
  if (!pre) return check();
  return pre.then(() => check());
}

/** The Settings state of the switch (decided here, not in the renderer). */
export async function getBetaUpdatesState(): Promise<BetaUpdatesState> {
  const d = deps;
  const applied = target?.allowPrerelease === true;
  const none: BetaUpdatesState = { visible: false, stored: false, applied, eligibility: "unknown", note: null };
  if (!d) return none;
  try {
    const shownHere = !d.isStoreBuild() && d.isPackaged();
    if (!shownHere) return none;
    const userId = await d.sessionFileUserId();
    if (!userId) return none;
    const { stored: recorded } = getBetaUpdatesInputs();
    const stored =
      recorded && recorded.userId === userId ? recorded.value : await d.readStoredForUser(userId);
    const eligibility = await refreshBetaEligibility(BETA_ELIGIBILITY_QUICK_TIMEOUT_MS);
    const nowApplied = target?.allowPrerelease === true;
    let note: BetaUpdatesState["note"] = null;
    if (stored && !nowApplied) {
      note = eligibility === "blocked" ? "not_available" : eligibility === "unknown" ? "unreachable" : null;
    }
    return {
      visible: eligibility === "allowed" || stored,
      stored,
      applied: nowApplied,
      eligibility,
      note,
    };
  } catch (error) {
    logService.warn("[BetaUpdates] State read failed", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}

/**
 * Register the IPC channel and the triggers. Call once, after the updater is
 * configured (main.ts, next to the session reset).
 */
export function registerBetaUpdatesHandlers(
  updater: BetaUpdaterTarget = autoUpdater,
  overrides: Partial<BetaUpdatesDeps> = {},
): void {
  target = updater;
  deps = { ...defaultDeps(updater), ...overrides };
  const d = deps;

  ipcMain.handle("updates:get-beta-state", () => getBetaUpdatesState());

  onStoredBetaUpdatesRecorded((_userId, value) => {
    if (value) void refreshBetaEligibility(BETA_ELIGIBILITY_TIMEOUT_MS);
    syncRetryTimer();
  });

  onSessionChanged(() => {
    // updateChannelPolicy's reset (installed first) has already cleared the inputs.
    extraCheckDone = false;
    syncRetryTimer();
  });

  updater.on("checking-for-update", () => {
    checkRunning = true;
  });
  updater.on("update-not-available", () => {
    checkRunning = false;
  });
  updater.on("error", () => {
    checkRunning = false;
  });
  updater.on("update-available", () => {
    checkRunning = false;
    updateOffered = true;
  });

  d.onQuit(() => {
    if (retryTimer) {
      d.clearInterval(retryTimer);
      retryTimer = null;
    }
  });
}

/** Tests only. */
export function resetBetaUpdatesHandlersForTests(): void {
  if (retryTimer && deps) deps.clearInterval(retryTimer);
  deps = null;
  target = null;
  inFlight = null;
  retryTimer = null;
  extraCheckDone = false;
  checkRunning = false;
  updateOffered = false;
}
