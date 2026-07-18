/**
 * Lifecycle Event Service (BACKLOG-2113)
 *
 * Best-effort recording of app lifecycle events (reset / uninstall / reinstall)
 * to Supabase so support gets visibility into a user resetting or removing the
 * app. The app is the only authenticated place that can record this.
 *
 * CRITICAL CONTRACT:
 *   - The event MUST be written BEFORE local data is wiped, but the write is
 *     BEST-EFFORT: an offline / signed-out / erroring user must STILL be able to
 *     wipe. Therefore this service NEVER throws and NEVER blocks the caller for
 *     more than TIMEOUT_MS. On any failure it logs a warning and resolves.
 *   - Reuses the app's existing authed Supabase client (supabaseService). It does
 *     NOT create a new client. RLS ("Users can insert own lifecycle events")
 *     requires user_id = auth.uid(), so we fetch the session user id and pass it.
 *
 * WIRING (for BACKLOG-2111's appCleanupService `beforeWipe` seam):
 *   The UI/cleanup task injects `logResetEvent` or `logUninstallEvent` as the
 *   `beforeWipe?: () => Promise<void>` hook. Both are safe to await unconditionally.
 */

import { app } from "electron";
import supabaseService from "./supabaseService";
import { getDeviceId } from "./deviceService";
import logService from "./logService";

const LOG_TAG = "LifecycleEvent";

/** Hard ceiling on how long a lifecycle write may delay a wipe. */
const TIMEOUT_MS = 3000;

export type LifecycleEventType = "reset" | "uninstall" | "reinstall";

export interface LifecycleEvent {
  event_type: LifecycleEventType;
  /** Optional free-text reason (e.g. user-provided or trigger context). */
  reason?: string;
  /** Optional extra structured context. Defaults to {} at the DB level. */
  metadata?: Record<string, unknown>;
}

/**
 * A distinct sentinel so a timed-out write is distinguishable from a rejection.
 */
const TIMEOUT_SENTINEL = Symbol("lifecycle-event-timeout");

function timeout(ms: number): Promise<typeof TIMEOUT_SENTINEL> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
    // Do not keep the event loop alive solely for this timer.
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });
}

/**
 * Best-effort insert of a lifecycle event. Never throws; resolves within
 * TIMEOUT_MS even if the network hangs. All failure modes (offline, timeout,
 * error, no session) are logged as warnings and swallowed.
 */
export async function logLifecycleEvent(evt: LifecycleEvent): Promise<void> {
  try {
    // If the timeout wins the race, the write promise is abandoned. Attach a
    // no-op catch so a later rejection on the losing promise does not surface
    // as an unhandledRejection in the main process.
    const write = writeEvent(evt);
    write.catch(() => {});

    const result = await Promise.race([write, timeout(TIMEOUT_MS)]);
    if (result === TIMEOUT_SENTINEL) {
      await logService.warn(
        "Lifecycle event write timed out; proceeding with wipe",
        LOG_TAG,
        { eventType: evt.event_type, timeoutMs: TIMEOUT_MS },
      );
    }
  } catch (error) {
    // Offline / auth / DB error: log and swallow. Wipe MUST proceed.
    await logService.warn(
      "Lifecycle event write failed; proceeding with wipe",
      LOG_TAG,
      {
        eventType: evt.event_type,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * Performs the actual insert. May reject (offline / auth / DB) — the caller
 * (logLifecycleEvent) catches everything.
 */
async function writeEvent(evt: LifecycleEvent): Promise<void> {
  const client = supabaseService.getClient();

  // RLS requires user_id = auth.uid(); fetch it from the current session.
  const { data: sessionData } = await client.auth.getSession();
  const userId = sessionData?.session?.user?.id ?? null;
  if (!userId) {
    // No authenticated session: nothing we can attribute the event to.
    await logService.warn(
      "No authenticated session for lifecycle event; skipping remote log",
      LOG_TAG,
      { eventType: evt.event_type },
    );
    return;
  }

  let deviceId: string | undefined;
  try {
    deviceId = getDeviceId();
  } catch {
    // Device id is optional; omit if the machine id lookup fails.
    deviceId = undefined;
  }

  const row: Record<string, unknown> = {
    user_id: userId,
    event_type: evt.event_type,
    app_version: app.getVersion(),
    platform: process.platform,
  };
  if (deviceId) row.device_id = deviceId;
  if (evt.reason !== undefined) row.reason = evt.reason;
  if (evt.metadata !== undefined) row.metadata = evt.metadata;

  const { error } = await client.from("app_lifecycle_events").insert(row);
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Ready-to-inject `beforeWipe` hook for a RESET.
 * Matches `() => Promise<void>`; safe to await unconditionally.
 */
export function logResetEvent(reason?: string): Promise<void> {
  return logLifecycleEvent({ event_type: "reset", reason });
}

/**
 * Ready-to-inject `beforeWipe` hook for an UNINSTALL.
 * Matches `() => Promise<void>`; safe to await unconditionally.
 */
export function logUninstallEvent(reason?: string): Promise<void> {
  return logLifecycleEvent({ event_type: "uninstall", reason });
}

export default {
  logLifecycleEvent,
  logResetEvent,
  logUninstallEvent,
};
