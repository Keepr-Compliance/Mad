/**
 * BACKLOG-4181: `track` / `event` — the one way main-process code sends a
 * diagnostics line to Sentry Logs.
 *
 * Has NO Sentry import: installSentry injects the sink after `Sentry.init`.
 * Until then (and in every unit test that does not set one) every call is a
 * no-op, so the route modules can call it directly.
 *
 * Every call checks the "Share diagnostics with Keepr" switch LIVE, accepts
 * only an op listed in `DIAG_ROUTE_KEYS`, and keeps only that op's fields:
 * finite numbers, booleans, and strings in `DIAG_STRING_FIELDS` whose format
 * matches. Anything else is dropped and counted. The body is the op name —
 * never a message, never `logger.fmt`. At most `DIAG_RATE_CAP_PER_MINUTE`
 * lines per op per minute.
 *
 * Numbers in `DIAG_NUMBER_SETS` must be one of the listed values, and
 * `DIAG_BOOLEAN_FIELDS` must be booleans (BACKLOG-4181 PR 3). Once the device
 * profile is known, the four machine-class keys (`DIAG_MACHINE_KEYS`) are added
 * to every log from the `machineClass` getter, each re-validated here. This is
 * the capture-time check; the transport filter repeats it at send time.
 *
 * The device id is sent as an attribute on each log ONLY. Never put it on the
 * Sentry scope (setTag / setUser / setContext / setAttribute(s)): crash events
 * carry the user id, and that would join the two.
 */

import {
  DIAG_BASE_FORMATS,
  DIAG_BOOLEAN_FIELDS,
  DIAG_MACHINE_KEYS,
  DIAG_MACHINE_STRING_FORMATS,
  DIAG_NUMBER_SETS,
  DIAG_ROUTE_KEYS,
  DIAG_STRING_FIELDS,
  isDiagOp,
  type DiagFields,
  type DiagOp,
  type DiagValue,
} from "./fields";
import { getDiagnosticsDeviceId, isDiagnosticsSharingEnabled } from "../diagnosticsSharingPreference";

export type DiagLevel = "info" | "warn";
export type DiagnosticsSink = (level: DiagLevel, body: string, attributes: Record<string, DiagValue>) => void;

export const DIAG_RATE_CAP_PER_MINUTE = 60;

interface DiagnosticsConfig {
  sink: DiagnosticsSink;
  appVersion: string;
  os: string;
  now?: () => number;
  /** BACKLOG-4185 machine class getter (installSentry passes deviceProfileService.getMachineClass). */
  machineClass?: () => Record<string, unknown> | null;
}

function capturedOk(field: string, value: unknown): value is number | boolean {
  if (DIAG_BOOLEAN_FIELDS.has(field)) return typeof value === "boolean";
  const set = DIAG_NUMBER_SETS[field];
  if (set) return typeof value === "number" && set.includes(value);
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

let config: DiagnosticsConfig | null = null;
let droppedCount = 0;
const windows = new Map<string, { startedAt: number; count: number }>();

/** Called once by installSentry after `Sentry.init`. */
export function configureDiagnostics(next: DiagnosticsConfig): void {
  config = next;
}

/** Fields (and whole calls) dropped since start; for tests and debugging. */
export function getDroppedDiagnosticsCount(): number {
  return droppedCount;
}

function underRateCap(op: string, now: number): boolean {
  const w = windows.get(op);
  if (!w || now - w.startedAt >= 60_000) {
    windows.set(op, { startedAt: now, count: 1 });
    return true;
  }
  if (w.count >= DIAG_RATE_CAP_PER_MINUTE) return false;
  w.count += 1;
  return true;
}

function send(level: DiagLevel, op: DiagOp, durationMs: number | null, fields: Record<string, unknown> | undefined): void {
  try {
    if (!config || !isDiagnosticsSharingEnabled()) return;
    if (!isDiagOp(op)) {
      droppedCount += 1;
      return;
    }
    const routeKeys = DIAG_ROUTE_KEYS[op] as readonly string[];
    const attributes: Record<string, DiagValue> = { "keepr.diag": true, "keepr.op": op };
    if (DIAG_BASE_FORMATS["keepr.os"].test(config.os)) attributes["keepr.os"] = config.os;
    if (DIAG_BASE_FORMATS["keepr.appVersion"].test(config.appVersion)) attributes["keepr.appVersion"] = config.appVersion;
    const id = getDiagnosticsDeviceId();
    if (DIAG_BASE_FORMATS["keepr.deviceId"].test(id)) attributes["keepr.deviceId"] = id;
    if (durationMs !== null) {
      if (!Number.isFinite(durationMs) || !routeKeys.includes("durationMs")) {
        droppedCount += 1;
        return;
      }
      attributes["keepr.durationMs"] = Math.round(durationMs);
    }
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === null || value === undefined) continue;
      if (key === "durationMs" || !routeKeys.includes(key)) {
        droppedCount += 1;
        continue;
      }
      const format = DIAG_STRING_FIELDS[key];
      if (format) {
        if (typeof value === "string" && format.test(value)) attributes[`keepr.${key}`] = value;
        else droppedCount += 1;
      } else if (capturedOk(key, value)) {
        attributes[`keepr.${key}`] = value;
      } else {
        droppedCount += 1;
      }
    }
    const mc = config.machineClass?.() ?? null;
    if (mc) {
      for (const full of DIAG_MACHINE_KEYS) {
        const field = full.slice("keepr.".length);
        const value = mc[field];
        if (value === undefined || value === null) continue;
        const fmt = DIAG_MACHINE_STRING_FORMATS[field];
        if (fmt ? typeof value === "string" && fmt.test(value) : capturedOk(field, value)) attributes[full] = value as DiagValue;
        else droppedCount += 1;
      }
    }
    const now = (config.now ?? Date.now)();
    if (!underRateCap(op, now)) return;
    config.sink(level, op, attributes);
  } catch {
    // Telemetry only: never affects the caller.
  }
}

/** A timed operation: slow IPC handler, main-process block, window freeze. */
export function track<Op extends DiagOp>(op: Op, durationMs: number, fields?: DiagFields<Op>): void {
  send("warn", op, durationMs, fields as Record<string, unknown> | undefined);
}

/** A point-in-time event, e.g. a freeze starting. */
export function event<Op extends DiagOp>(op: Op, fields?: DiagFields<Op>): void {
  send("info", op, null, fields as Record<string, unknown> | undefined);
}

/** Test-only. */
export function __resetDiagnosticsForTests(): void {
  config = null;
  droppedCount = 0;
  windows.clear();
}
