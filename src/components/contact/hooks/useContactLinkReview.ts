import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type { ContactSourceProvenance } from "@/types/contactProvenance";

/**
 * Renderer plumbing for BACKLOG-2410 — the review-queue count and a contact's
 * provenance.
 *
 * Calls `window.api.contacts.*` directly, matching `useContactList` and
 * `useContactComms` on this screen rather than routing through
 * `src/services/contactService` (which the Contacts screen does not use).
 *
 * Both hooks carry an `isMountedRef` guard, the established pattern here: the
 * Contacts screen unmounts on "Back to Dashboard" while these requests are in
 * flight, and a setState afterwards is a React warning at best and a stale
 * render at worst.
 */

/**
 * How many identity questions are waiting.
 *
 * `null` means NOT YET KNOWN, and it is distinct from `0`. The button renders
 * for neither, but the distinction stops a transient "Review 0 possible
 * duplicates" flashing on every mount — and it is the same "nothing found vs
 * never looked" discipline this epic is built on.
 */
export function useReviewQueueCount(userId: string): {
  count: number | null;
  refresh: () => void;
} {
  const [count, setCount] = useState<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const result = await window.api.contacts.getReviewQueueCount(userId);
        if (!isMountedRef.current) return;
        if (!result.success) {
          logger.warn(`[Contacts] review queue count unavailable: ${result.error}`);
        }
        setCount(result.success ? (result.count ?? 0) : 0);
      } catch (err) {
        if (!isMountedRef.current) return;
        // A failed count hides the button rather than showing a wrong number.
        // The queue is not urgent; a wrong count on a review surface is worse
        // than a missing one, because it is the number the user trusts.
        //
        // BUT IT IS LOGGED. Falling back to 0 silently makes a broken IPC
        // channel indistinguishable from a healthy empty queue — no button, no
        // error, nothing to report. That is the BACKLOG-1898 shape, and on this
        // surface it would hide the one control that lets a user find a wrong
        // merge.
        logger.warn(`[Contacts] review queue count failed: ${String(err)}`);
        setCount(0);
      }
    })();
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { count, refresh };
}

/**
 * Which sources a saved contact was assembled from.
 *
 * Returns `[]` for `null` (no contact selected) and for external, not-yet-
 * imported contacts — they have no crosswalk rows by definition.
 */
export function useContactSources(
  userId: string,
  contactId: string | null,
): {
  sources: ContactSourceProvenance[];
  isLoading: boolean;
  refresh: () => void;
} {
  const [sources, setSources] = useState<ContactSourceProvenance[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!contactId) {
      setSources([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void (async () => {
      try {
        const result = await window.api.contacts.getSources(userId, contactId);
        if (!isMountedRef.current) return;
        if (!result.success) {
          logger.warn(`[Contacts] contact sources unavailable: ${result.error}`);
        }
        setSources(result.success ? (result.sources ?? []) : []);
      } catch (err) {
        if (!isMountedRef.current) return;
        // Same reasoning as the count above: an empty list is the right
        // fallback (the Sources section simply does not render), but a silent
        // one makes a broken channel look exactly like a single-source contact.
        logger.warn(`[Contacts] contact sources load failed: ${String(err)}`);
        setSources([]);
      } finally {
        if (isMountedRef.current) setIsLoading(false);
      }
    })();
  }, [userId, contactId]);

  useEffect(() => {
    load();
  }, [load]);

  return { sources, isLoading, refresh: load };
}
