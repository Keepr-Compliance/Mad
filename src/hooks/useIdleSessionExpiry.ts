/**
 * BACKLOG-3833 — when main signs the session out for inactivity, run the
 * normal logout flow so the app returns to the sign-in screen without a reload.
 */
import { useEffect, useRef } from "react";
import { onIdleSessionExpired } from "../services/sessionActivityService";
import logger from "../utils/logger";
import { useUserActivityHeartbeat } from "./useUserActivityHeartbeat";

export const IDLE_SIGN_OUT_MESSAGE =
  "You were signed out after 30 minutes of inactivity. Please sign in again.";

export function useIdleSessionExpiry({
  isAuthenticated,
  onExpired,
}: {
  isAuthenticated: boolean;
  onExpired: () => Promise<void>;
}): void {
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  useEffect(() => {
    if (!isAuthenticated) return;
    let handled = false;
    return onIdleSessionExpired(() => {
      if (handled) return;
      handled = true;
      logger.info("[IdleSession] Main signed the session out for inactivity");
      window.alert(IDLE_SIGN_OUT_MESSAGE);
      void onExpiredRef.current();
    });
  }, [isAuthenticated]);
}

/** Both halves of the idle timeout, for the app shell. */
export function useSessionIdleTimeout(opts: {
  isAuthenticated: boolean;
  onExpired: () => Promise<void>;
}): void {
  useUserActivityHeartbeat(opts.isAuthenticated);
  useIdleSessionExpiry(opts);
}
