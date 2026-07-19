/**
 * useHasBrokenEmailToken (BACKLOG-2127)
 *
 * Live check: does the user have a mailbox whose stored OAuth token is dead
 * (a token row EXISTS but refresh/expiry/check failed)? This is distinct from
 * NOT_CONNECTED (no token row at all).
 *
 * Used to suppress the "Complete your account setup" onboarding prompt for a
 * user whose mailbox is configured-but-broken — that user must see a RECONNECT
 * banner, not onboarding copy. NOT_CONNECTED users still see the setup prompt.
 *
 * Keys off the typed `ConnectionErrorType` discriminator (via
 * providerNeedsEmailSync / isBrokenTokenError) — never string-matches a message.
 *
 * @module hooks/useHasBrokenEmailToken
 */

import { useEffect, useState } from "react";
import logger from "../utils/logger";
import { hasBrokenEmailToken } from "../utils/connectionStatus";

/**
 * @param userId The signed-in user's id, or null/undefined when unavailable.
 * @returns true when at least one provider has a broken (reconnect-able) token.
 */
export function useHasBrokenEmailToken(userId: string | null | undefined): boolean {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!userId) {
      setBroken(false);
      return;
    }

    let aborted = false;

    const check = async () => {
      try {
        const result = await window.api.system.checkAllConnections(userId);
        if (aborted) return;
        setBroken(result.success ? hasBrokenEmailToken(result) : false);
      } catch (error) {
        if (aborted) return;
        // Transient failure — do NOT suppress the setup prompt on an inconclusive
        // check (better to show onboarding copy than to hide it wrongly).
        logger.warn("[useHasBrokenEmailToken] connection check failed", error);
        setBroken(false);
      }
    };

    void check();

    return () => {
      aborted = true;
    };
  }, [userId]);

  return broken;
}
