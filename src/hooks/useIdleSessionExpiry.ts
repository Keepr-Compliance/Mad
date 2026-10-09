/**
 * BACKLOG-3833 — when main signs the session out for inactivity, run the
 * normal logout flow so the app returns to the sign-in screen without a reload,
 * then show the reason on the sign-in screen.
 */
import { useEffect, useRef } from "react";
import { onIdleSessionExpired, setSignInNotice } from "../services/sessionActivityService";
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
    // Signed in again: the previous sign-out notice is no longer relevant.
    setSignInNotice(null);
    let handled = false;
    return onIdleSessionExpired(() => {
      if (handled) return;
      handled = true;
      logger.info("[IdleSession] Main signed the session out for inactivity");
      // Leave the signed-in screens FIRST, then show the reason on the
      // sign-in screen. Never a blocking dialog over client data.
      void (async () => {
        try {
          await onExpiredRef.current();
        } finally {
          setSignInNotice(IDLE_SIGN_OUT_MESSAGE);
        }
      })();
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
