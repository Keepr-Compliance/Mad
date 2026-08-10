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
  /** BACKLOG-2502 — the review queue's candidate, as one more column. */
  proposedSource?: { sourceType: string; sourceRecordId: string },
  /** BACKLOG-2502 — present ⇒ `confirm` answers a PROPOSAL, not a contact. */
  proposalId?: string,
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
        const result = await window.api.contacts.getCompareColumns(
          userId,
          contactId,
          proposedSource,
        );
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
    // `proposedSource` is destructured into primitives so a caller passing a
    // fresh object literal each render cannot re-fire the load.
  }, [userId, contactId, proposedSource?.sourceType, proposedSource?.sourceRecordId]);

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
      /*
        BACKLOG-2502 — WHICH CONFIRM, decided by whether a proposal is on screen.

        A proposal is answered by `confirmLink` (`confirmProposal`), which writes
        the verdict, CREATES THE LINK, applies the source values and rejects the
        `record:` cluster siblings, in one transaction. PR D's `confirmSources`
        confirms links that already exist — called here it would write nothing
        about the candidate and the user's answer would vanish.

        `ok: true` DOES NOT MEAN LINKED. When the record is already claimed by a
        different contact, `confirmProposal` records the verdict, creates no
        link, skips the sibling rejection and returns `linked: false`. That is
        the merge guard working; the caller must read `linked`, not `ok`.
      */
      if (proposalId) {
        const result = await window.api.contacts.confirmLink(userId, proposalId);
        if (!result.success) {
          logger.warn(`[Contacts] confirm link failed: ${result.error}`);
          return {
            ok: false,
            error: result.error,
            confirmed: 0,
            alreadyConfirmed: 0,
            proposalsResolved: 0,
          };
        }
        return {
          ok: true,
          linked: result.linked ?? false,
          confirmed: result.linked ? 1 : 0,
          alreadyConfirmed: 0,
          proposalsResolved: 1,
        };
      }
      const outcome = await window.api.contacts.confirmSources(userId, contactId);
      if (!outcome.ok) {
        logger.warn(`[Contacts] confirm sources failed: ${outcome.error}`);
      }
      return outcome;
    } catch (err) {
      logger.warn(`[Contacts] confirm sources threw: ${String(err)}`);
      return null;
    }
  }, [userId, contactId, proposalId]);

  return { view, loading, failed, reload, confirm };
}
