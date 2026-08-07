import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type { ContactCompareView, ConfirmSourcesOutcome } from "@/types/contactProvenance";

/**
 * Renderer plumbing for BACKLOG-2471 PR C — the compare screen's columns.
 *
 * Keeps `window.api` out of `ContactCompareSources` so the component stays
 * testable without a preload stub, matching `useContactManualLink` and
 * `useContactLinkReview` on this screen. It is also the seam PR G's three
 * transaction callers mount — one loader, not a copy per surface.
 *
 * Carries the same `isMountedRef` guard as its siblings: the pane closes while
 * the request is in flight.
 */
export function useContactCompare(
  userId: string,
  contactId: string,
): {
  view: ContactCompareView | null;
  loading: boolean;
  /**
   * A failed load is NOT an empty one. Rendering "nothing to compare" when the
   * channel is broken is the BACKLOG-1898 shape — it would tell the user their
   * contact is assembled from one record when it is not.
   */
  failed: boolean;
  reload: () => void;
  /**
   * "Yes, these records are all this person" (PR D).
   *
   * Resolves to the outcome so the caller can decide what to do next —
   * `Confirm` closes, `Confirm & edit` closes and opens the form — and so a
   * failure is not mistaken for a success that changed nothing.
   */
  confirm: () => Promise<ConfirmSourcesOutcome | null>;
} {
  const [view, setView] = useState<ContactCompareView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const isMountedRef = useRef(true);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    void (async () => {
      try {
        const result = await window.api.contacts.getCompareColumns(userId, contactId);
        if (!isMountedRef.current || seq !== requestSeqRef.current) return;
        if (!result.success) {
          logger.warn(`[Contacts] compare columns failed: ${result.error}`);
          setFailed(true);
          setView(null);
        } else {
          setFailed(false);
          setView(result.view ?? null);
        }
      } catch (err) {
        if (!isMountedRef.current || seq !== requestSeqRef.current) return;
        logger.warn(`[Contacts] compare columns threw: ${String(err)}`);
        setFailed(true);
        setView(null);
      } finally {
        if (isMountedRef.current && seq === requestSeqRef.current) setLoading(false);
      }
    })();
  }, [userId, contactId]);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * The write. Deliberately NOT wrapped in the request-sequence guard above:
   * that guard exists so a stale READ cannot overwrite a fresh one, and a write
   * has no stale version — it either happened or it did not. Double-press is
   * guarded by the caller's `busy` flag and, durably, by the service skipping
   * links that already carry the verdict.
   */
  const confirm = useCallback(async (): Promise<ConfirmSourcesOutcome | null> => {
    try {
      const outcome = await window.api.contacts.confirmSources(userId, contactId);
      if (!outcome.ok) {
        logger.warn(`[Contacts] confirm sources failed: ${outcome.error}`);
      }
      return outcome;
    } catch (err) {
      logger.warn(`[Contacts] confirm sources threw: ${String(err)}`);
      return null;
    }
  }, [userId, contactId]);

  return { view, loading, failed, reload, confirm };
}
