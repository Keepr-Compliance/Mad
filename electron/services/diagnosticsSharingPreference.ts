/**
 * "Share diagnostics with Keepr" switch and the random diagnostics device id
 * (BACKLOG-4181). Mirrors crashReportingPreference.ts.
 *
 * WHERE THE VALUE LIVES: `<userData>/diagnostics-sharing.json`,
 * `{"enabled": bool, "deviceId": "<uuid v4>"}`. Read synchronously by
 * `electron/bootstrap/installSentry.ts` before `Sentry.init`, so it is a
 * per-device setting, not a database row.
 *
 * DEFAULT: `DIAGNOSTICS_SHARING_DEFAULT`, the ONE place the default is set. A
 * missing file, unreadable file, bad JSON or a non-boolean `enabled` all read
 * as this value.
 *
 * WHAT IT GATES: the structured diagnostics the perf helper sends to Sentry
 * Logs (electron/services/diagnostics/perf.ts). It is read LIVE: by the helper
 * at capture, by `beforeSendLog`, and by the transport filter at send time
 * (diagnosticsLogTransport.ts), so turning it off also stops logs captured
 * before the switch and logs waiting in the offline queue.
 *
 * DEVICE ID: `crypto.randomUUID()`, created on first load. It is NOT the
 * hardware id (deviceService.getDeviceId is machineIdSync and must never be
 * used here). It is never put on the Sentry scope and never on crash events,
 * which carry the user id. Turning sharing OFF replaces it, and the transport
 * filter only sends logs stamped with the current id, so logs from before an
 * opt-out are never sent under a later opt-in.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DIAG_BASE_FORMATS } from "./diagnostics/fields";

export const DIAGNOSTICS_SHARING_FILE_NAME = "diagnostics-sharing.json";

/**
 * The default when nothing valid is saved. ONE constant: the founder has not
 * decided whether a release ships this ON before the privacy-policy text is
 * published; flipping it here flips every reader.
 */
export const DIAGNOSTICS_SHARING_DEFAULT = true;

let filePath: string | null = null;
let enabledNow = DIAGNOSTICS_SHARING_DEFAULT;
let deviceId: string | null = null;

function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DIAG_BASE_FORMATS["keepr.deviceId"].test(value);
}

function readFile(file: string): { enabled: boolean; deviceId: string | null } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return { enabled: DIAGNOSTICS_SHARING_DEFAULT, deviceId: null };
    }
    const record = parsed as { enabled?: unknown; deviceId?: unknown };
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : DIAGNOSTICS_SHARING_DEFAULT,
      deviceId: isValidDeviceId(record.deviceId) ? record.deviceId : null,
    };
  } catch {
    return { enabled: DIAGNOSTICS_SHARING_DEFAULT, deviceId: null };
  }
}

function writeFile(): void {
  if (!filePath) {
    throw new Error("Diagnostics sharing preference was never loaded");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ enabled: enabledNow, deviceId }), "utf8");
}

/**
 * Read the saved choice and device id from `<userDataDir>/diagnostics-sharing.json`.
 * Called once, synchronously, before `Sentry.init`. A missing or invalid device id
 * is replaced and saved; a failed save keeps the new id in memory for this session.
 */
export function loadDiagnosticsSharingPreference(userDataDir: string): boolean {
  filePath = path.join(userDataDir, DIAGNOSTICS_SHARING_FILE_NAME);
  const saved = readFile(filePath);
  enabledNow = saved.enabled;
  deviceId = saved.deviceId;
  if (deviceId === null) {
    deviceId = crypto.randomUUID();
    try {
      writeFile();
    } catch {
      // Kept in memory for this session.
    }
  }
  return enabledNow;
}

/** Live value — read by the helper, beforeSendLog and the transport filter. */
export function isDiagnosticsSharingEnabled(): boolean {
  return enabledNow;
}

/** The current random diagnostics device id. */
export function getDiagnosticsDeviceId(): string {
  if (deviceId === null) deviceId = crypto.randomUUID();
  return deviceId;
}

export interface DiagnosticsSharingState {
  enabled: boolean;
}

export function getDiagnosticsSharingState(): DiagnosticsSharingState {
  return { enabled: enabledNow };
}

/**
 * Save the choice. The live flag (and, when turning OFF, the new device id)
 * change FIRST, so turning sharing off stops sending even if the write fails;
 * a write failure is thrown so the caller can tell the user.
 */
export function setDiagnosticsSharingEnabled(enabled: boolean): DiagnosticsSharingState {
  enabledNow = enabled;
  if (!enabled) deviceId = crypto.randomUUID();
  writeFile();
  return getDiagnosticsSharingState();
}

/** Test-only: forget the loaded path and return to the default. */
export function __resetDiagnosticsSharingPreferenceForTests(): void {
  filePath = null;
  enabledNow = DIAGNOSTICS_SHARING_DEFAULT;
  deviceId = null;
}
