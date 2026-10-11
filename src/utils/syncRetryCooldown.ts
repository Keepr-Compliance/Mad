/**
 * BACKLOG-3816: the hold on Sync / Try Again after the phone's backup session ended badly.
 *
 * After the USB link drops (`CONNECTION_LOST`, or the device disconnecting mid-sync) or the
 * phone's backup service refuses to negotiate (`SERVICE_UNAVAILABLE`), the phone's backup
 * service is still winding down. A retry inside that window is what produces the next
 * `SERVICE_UNAVAILABLE` (BACKLOG-2913; seen again on the PC on 2026-10-11, ~4 min after a
 * cable wiggle). So the buttons wait 30 s from the failure.
 */
import { useEffect, useState } from "react";

export const SYNC_RETRY_COOLDOWN_MS = 30_000;

/** `BackupErrorCode` values (electron/types/backup.ts) that start the hold. */
export const SYNC_RETRY_COOLDOWN_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_LOST",
  "SERVICE_UNAVAILABLE",
]);

/** Whole seconds left before the buttons come back; 0 once `now >= retryAvailableAt`. */
export function retrySecondsLeft(retryAvailableAt: number | null | undefined, now: number): number {
  if (retryAvailableAt == null) return 0;
  const ms = retryAvailableAt - now;
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

export function retryCooldownMessage(secondsLeft: number): string {
  return (
    "Your iPhone is finishing the last session — you can try again in " +
    `${secondsLeft} second${secondsLeft === 1 ? "" : "s"}`
  );
}

/**
 * Seconds left in the hold, re-rendering the caller as it counts down. Reads the clock on
 * every tick, so a component mounted part-way through (modal reopened) starts at the
 * right number.
 */
export function useRetryCountdown(retryAvailableAt: number | null | undefined): number {
  // The state only forces re-renders; the clock is read at render time.
  const [, setTick] = useState(0);
  const secondsLeft = retrySecondsLeft(retryAvailableAt, Date.now());

  useEffect(() => {
    if (retryAvailableAt == null || Date.now() >= retryAvailableAt) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= retryAvailableAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [retryAvailableAt]);

  return secondsLeft;
}
