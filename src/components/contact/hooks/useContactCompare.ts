import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type { ContactCompareView } from "@/types/contactProvenance";

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

  return { view, loading, failed, reload };
}
