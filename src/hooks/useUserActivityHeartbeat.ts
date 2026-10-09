/**
 * BACKLOG-3833 — tell main that a person is using the app.
 *
 * Listens for real input at the window (capture phase, so a component that
 * stops propagation cannot hide it) and reports at most once per
 * HEARTBEAT_MIN_INTERVAL_MS (leading edge, no trailing timer). Main checks the
 * session is still valid before recording the activity.
 */
import { useEffect } from "react";
import { reportUserActivity } from "../services/sessionActivityService";

export const HEARTBEAT_MIN_INTERVAL_MS = 60_000;
export const USER_ACTIVITY_EVENTS = [
  "keydown",
  "pointerdown",
  "wheel",
  "scroll",
  "touchstart",
] as const;

export function useUserActivityHeartbeat(isAuthenticated: boolean): void {
  useEffect(() => {
    if (!isAuthenticated) return;
    let lastSent = -Infinity;
    const onInput = () => {
      const now = Date.now();
      if (now - lastSent < HEARTBEAT_MIN_INTERVAL_MS) return;
      lastSent = now;
      void reportUserActivity();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of USER_ACTIVITY_EVENTS) {
      window.addEventListener(type, onInput, opts);
    }
    return () => {
      for (const type of USER_ACTIVITY_EVENTS) {
        window.removeEventListener(type, onInput, opts);
      }
    };
  }, [isAuthenticated]);
}
