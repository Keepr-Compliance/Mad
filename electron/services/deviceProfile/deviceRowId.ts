/**
 * BACKLOG-4185: the devices row id (public.devices.id, gen_random_uuid) that
 * Sentry error / crash events carry so a report can be looked up against the
 * row's hardware profile.
 *
 * - Only devices.id. Never devices.device_id (the machine id) and no hardware
 *   field: the profile lives on the row, nowhere else.
 * - Added per event in beforeSend, never on the Sentry scope: the scope is
 *   persisted to sentry/scope_v3.json in plaintext (installSentry.ts header).
 * - Attached only while "Share diagnostics with Keepr" AND "Send crash reports"
 *   are both ON; the caller passes the live state.
 * - Loaded from the device-profile state file at boot, so a main-process crash
 *   reported on the NEXT launch (minidump, sent before any sign-in) still
 *   carries it. Replaced by the id registerDevice returns once it runs.
 *
 * Dependency-free on purpose: installSentry imports it before anything else
 * exists.
 */
import fs from "fs";
import path from "path";

export const DEVICE_PROFILE_STATE_FILE = "device-profile-state.json";
export const DEVICE_ROW_TAG = "keepr.device_row";
export const DEVICE_ROW_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let rowId: string | null = null;

export function setDeviceRowId(id: unknown): void {
  rowId = typeof id === "string" && DEVICE_ROW_ID_FORMAT.test(id) ? id : null;
}

export function getDeviceRowId(): string | null {
  return rowId;
}

/** Sync, once, at bootstrap (like the privacy preferences beside it). Never throws. */
export function loadDeviceRowIdAtBoot(userDataDir: string): void {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, DEVICE_PROFILE_STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as { rowId?: unknown };
    if (rowId === null) setDeviceRowId(parsed?.rowId);
  } catch {
    // No file (first launch, or the setting is off): no id until registration.
  }
}

/** beforeSend: returns the event with the row id tag added while `enabled`. */
export function attachDeviceRowId<E>(event: E, enabled: boolean): E {
  if (!enabled || rowId === null || event === null || typeof event !== "object") return event;
  const e = event as unknown as { tags?: Record<string, unknown> };
  return { ...(event as object), tags: { ...(e.tags ?? {}), [DEVICE_ROW_TAG]: rowId } } as E;
}

/** Transport replay: the event without the row id tag (a copy; input untouched). */
export function stripDeviceRowId<E>(event: E): E {
  if (event === null || typeof event !== "object") return event;
  const e = event as unknown as { tags?: Record<string, unknown> };
  if (!e.tags || !(DEVICE_ROW_TAG in e.tags)) return event;
  const tags = { ...e.tags };
  delete tags[DEVICE_ROW_TAG];
  return { ...(event as object), tags } as E;
}

export function __resetDeviceRowIdForTests(): void {
  rowId = null;
}
