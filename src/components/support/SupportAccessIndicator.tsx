/**
 * Persistent support access indicator (BACKLOG-2393)
 *
 * Small, always-visible, and it names the date.
 *
 * At thirty days a user will not remember granting anything, and an indicator
 * that only says "support access is on" leaves them with no way to judge
 * whether that is still what they wanted. So it says the day it ends. It also
 * offers to end it, because the only thing worse than forgetting is
 * remembering and not being able to find the switch.
 *
 * Mounted outside LicenseGate alongside SupportWidget, so it is visible on
 * every screen — including the ones people get stuck on, which is precisely
 * when support access tends to be granted.
 */

import React, { useCallback, useEffect, useState } from "react";
import logger from "../../utils/logger";
import {
  formatExpiry,
  formatRemaining,
  getSnapshot,
  revokeAccess,
  subscribeToAccessChanges,
  type SupportAccessState,
} from "../../services/supportAccessService";

/**
 * BACKLOG-2431: the poll is now a backstop, not the primary path.
 *
 * It still runs because `msRemaining` is a countdown that has to tick down on
 * its own, and because a push can be missed if this window was created after
 * the broadcast. But the banner no longer waits on it to notice a grant — see
 * the subscription in the effect below.
 */
const POLL_MS = 60_000;

export function SupportAccessIndicator(): React.ReactElement | null {
  const [state, setState] = useState<SupportAccessState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await getSnapshot();
      setState(snapshot.state);
    } catch (error) {
      // A missing bridge (or an older preload) must not break the app shell.
      logger.debug("Support access indicator unavailable:", error);
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // BACKLOG-2431: apply pushed state immediately so granting access shows the
    // banner now rather than up to POLL_MS later. The push carries the full
    // state, so this needs no round trip.
    const unsubscribe = subscribeToAccessChanges((next) => setState(next));
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  const handleTurnOff = useCallback(async () => {
    setBusy(true);
    try {
      const next = await revokeAccess();
      setState(next);
    } catch (error) {
      logger.error("Could not turn off support access:", error);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!state?.active || !state.consent) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="support-access-indicator"
      className="fixed bottom-4 left-4 z-40 max-w-xs rounded-lg border border-blue-300 bg-blue-50 shadow-sm px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-600"
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-blue-900">
            Keepr support access is on
          </p>
          <p className="text-xs text-blue-800">
            Ends {formatExpiry(state.consent.expiresAt)} (in{" "}
            {formatRemaining(state.msRemaining)})
          </p>
          <button
            onClick={() => void handleTurnOff()}
            disabled={busy}
            className="mt-1 text-xs font-medium text-blue-700 underline hover:text-blue-900 disabled:opacity-50"
          >
            {busy ? "Turning off…" : "Turn off now"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SupportAccessIndicator;
