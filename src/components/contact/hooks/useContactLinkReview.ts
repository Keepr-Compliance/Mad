import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type { ContactReviewItem, ContactSourceProvenance } from "@/types/contactProvenance";

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

  /**
   * BACKLOG-2474 — the count used to move only on mount, on unlink, and on
   * answering an item.
   *
   * A question filed while the user was sitting on this screen stayed invisible
   * until they navigated away and came back. That used to be an edge case; now
   * that the linking pass runs whenever contact data arrives and on every
   * import, it is the common case — the user imports a duplicate, the pass
   * files the question, and the button silently does not appear.
   *
   * Subscribes to the linking-specific channel, NOT `onExternalSyncComplete`.
   * That one fires before the pass has run on some paths, so refreshing on it
   * would re-read the same stale count; and it also drives the import picker's
   * own reload, which must not be triggered from here.
   *
   * Optional-called because the preload bridge is absent in unit tests and in
   * any renderer context where `window.api` is stubbed.
   */
  useEffect(() => {
    return window.api?.contacts?.onLinkReviewUpdated?.(() => {
      refresh();
    });
  }, [refresh]);

  return { count, refresh };
}

/**
 * THE OPEN QUESTIONS, FLAT, FOR THE WHOLE USER (BACKLOG-2626).
 *
 * ===========================================================================
 * WHY THIS READS THE QUEUE RATHER THAN A NEW PER-CONTACT CHANNEL
 * ===========================================================================
 * The walk needs "the questions still outstanding against THIS contact, in the
 * order the queue would ask them". `contacts:get-review-queue` already answers
 * exactly that for every contact at once, in one statement, ordered by
 * `p.cluster_key, p.created_at, p.id`. Filtering it by `contactId` in the
 * renderer gives the walk the queue's OWN order for free.
 *
 * A new contact-scoped channel would be a second predicate to keep equal to
 * `PENDING_JOIN`, and the whole defect this item fixes is two surfaces
 * disagreeing about what is outstanding. One reader, one order, no new IPC.
 *
 * ===========================================================================
 * `refresh` RESOLVES TO THE FRESH ITEMS — THAT IS THE POINT
 * ===========================================================================
 * After an answer the walk must decide, immediately, whether a next question
 * exists. Reading `items` back out of state cannot do it: the caller is inside
 * the handler that triggered the refresh, and the state it can see is the state
 * BEFORE it. That stale read is precisely the founder's complaint in a new
 * costume — a screen that shows him a question he has already answered.
 *
 * So `refresh` returns the array it just fetched, and the walk advances off the
 * RETURN VALUE, never off `items`.
 */
export function useOpenQuestions(userId: string): {
  items: ContactReviewItem[];
  refresh: () => Promise<ContactReviewItem[]>;
} {
  const [items, setItems] = useState<ContactReviewItem[]>([]);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<ContactReviewItem[]> => {
    try {
      const result = await window.api.contacts.getReviewQueue(userId);
      const next = result.success
        ? (result.clusters ?? []).flatMap((cluster) => cluster.items)
        : [];
      if (!result.success) {
        logger.warn(`[Contacts] open questions unavailable: ${result.error}`);
      }
      if (isMountedRef.current) setItems(next);
      return next;
    } catch (err) {
      /*
        AN EMPTY LIST IS THE RIGHT FALLBACK AND A LOGGED ONE IS THE ONLY SAFE
        ONE. No questions means no walk and no badge, so a broken channel simply
        opens the contact card — the behaviour of a healthy empty queue, which is
        why it must be distinguishable in the log. Same discipline as the count
        above, and the same reason: this is the surface a user finds a wrong
        merge on.
      */
      logger.warn(`[Contacts] open questions failed: ${String(err)}`);
      if (isMountedRef.current) setItems([]);
      return [];
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Same subscription as the count above, for the same reason: the linking pass
   * runs on every import and on every contact write, so a question filed while
   * the user sits on this screen must reach the badge without a navigation.
   */
  useEffect(() => {
    return window.api?.contacts?.onLinkReviewUpdated?.(() => {
      void refresh();
    });
  }, [refresh]);

  return { items, refresh };
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
