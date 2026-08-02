import { useCallback, useEffect, useRef, useState } from "react";
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
        setCount(result.success ? (result.count ?? 0) : 0);
      } catch {
        if (!isMountedRef.current) return;
        // A failed count hides the button rather than showing a wrong number.
        // The queue is not urgent; a wrong count on a review surface is worse
        // than a missing one, because it is the number the user trusts.
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
        setSources(result.success ? (result.sources ?? []) : []);
      } catch {
        if (!isMountedRef.current) return;
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
