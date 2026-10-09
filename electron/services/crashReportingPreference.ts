/**
 * Crash reporting on/off switch for the desktop app (BACKLOG-3801).
 *
 * WHERE THE VALUE LIVES: `<userData>/crash-reporting.json`, `{"enabled": bool}`.
 * It is read SYNCHRONOUSLY by `electron/bootstrap/installSentry.ts` before
 * `Sentry.init`, which runs at module evaluation — before `app` is ready,
 * before the database is open and before anyone has signed in. So it cannot
 * live in the database or in per-user preferences; it is a per-device setting.
 *
 * DEFAULT IS ON. A missing file, unreadable file, bad JSON or a non-boolean
 * `enabled` all read as ON — the same behaviour every build had before this
 * switch existed.
 *
 * WHAT "OFF" MEANS: nothing reaches Sentry. The gate is the transport that
 * actually talks to the network (`gateBaseTransport`), which every envelope
 * passes through: main-process events, renderer events (the renderer has no
 * network transport of its own — `@sentry/electron/renderer` hands envelopes to
 * main over IPC), sessions, replays, and envelopes left in the offline queue
 * by an earlier run. It is checked per envelope, so turning the switch OFF
 * takes effect immediately. Turning it back ON after a launch that started
 * OFF takes effect on the next launch, because Sentry was initialised
 * disabled for that session (`wasEnabledAtLaunch`).
 */

import fs from "fs";
import path from "path";

export const CRASH_REPORTING_FILE_NAME = "crash-reporting.json";

let filePath: string | null = null;
let enabledNow = true;
let enabledAtLaunch = true;

function readEnabled(file: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { enabled?: unknown }).enabled === "boolean") {
      return (parsed as { enabled: boolean }).enabled;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Read the saved choice from `<userDataDir>/crash-reporting.json`. Called once,
 * synchronously, before `Sentry.init`. Returns the value read.
 */
export function loadCrashReportingPreference(userDataDir: string): boolean {
  filePath = path.join(userDataDir, CRASH_REPORTING_FILE_NAME);
  const enabled = readEnabled(filePath);
  enabledNow = enabled;
  enabledAtLaunch = enabled;
  return enabled;
}

/** Live value — checked for every envelope before it can leave the machine. */
export function isCrashReportingEnabled(): boolean {
  return enabledNow;
}

export interface CrashReportingState {
  /** The saved choice. */
  enabled: boolean;
  /** The choice this session started with (Sentry was initialised from it). */
  wasEnabledAtLaunch: boolean;
}

export function getCrashReportingState(): CrashReportingState {
  return { enabled: enabledNow, wasEnabledAtLaunch: enabledAtLaunch };
}

/**
 * Save the choice. The live flag changes FIRST, so turning reporting off stops
 * sending even if the file write then fails; a write failure is thrown so the
 * caller can tell the user the choice will not survive a restart.
 */
export function setCrashReportingEnabled(enabled: boolean): CrashReportingState {
  enabledNow = enabled;
  if (!filePath) {
    throw new Error("Crash reporting preference was never loaded");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ enabled }), "utf8");
  return getCrashReportingState();
}

/**
 * Wrap the transport that does the network request so it sends nothing while
 * crash reporting is off. Pass the result to `makeElectronOfflineTransport` —
 * INSIDE the offline wrapper, never as its `shouldSend` option: a `shouldSend`
 * that returns false makes the offline transport throw and queue the envelope
 * to disk, which then sends on a later launch.
 *
 * While off, `send` answers 200 without a request, so the offline wrapper
 * treats the envelope as delivered and does not queue it; an envelope already
 * in the queue from an earlier run drains the same way instead of being sent.
 */
export function gateBaseTransport<O, T extends { send: (envelope: never) => PromiseLike<unknown> }>(
  makeBase: (options: O) => T,
): (options: O) => T {
  return (options: O): T => {
    const base = makeBase(options);
    return {
      ...base,
      send: ((envelope: never) =>
        isCrashReportingEnabled()
          ? base.send(envelope)
          : Promise.resolve({ statusCode: 200 })) as T["send"],
    };
  };
}

/** Test-only: forget the loaded path and return to the default. */
export function __resetCrashReportingPreferenceForTests(): void {
  filePath = null;
  enabledNow = true;
  enabledAtLaunch = true;
}
