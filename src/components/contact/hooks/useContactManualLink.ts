import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type { LinkableSourceRecord, LinkSourceOutcome } from "@/types/contactProvenance";

/**
 * Renderer plumbing for BACKLOG-2426 — manual linking.
 *
 * Keeps `window.api` out of `LinkSourceSearch` so the component stays testable
 * without a preload stub, matching `useContactLinkReview` on this screen.
 *
 * Carries the same `isMountedRef` guard as its sibling: the search runs on
 * every keystroke and the panel closes while requests are in flight.
 */
export function useContactManualLink(userId: string): {
  records: LinkableSourceRecord[];
  loading: boolean;
  searchFailed: boolean;
  search: (query: string) => void;
  link: (
    contactId: string,
    record: LinkableSourceRecord,
    acknowledgedPriorRejection?: boolean,
  ) => Promise<LinkSourceOutcome | null>;
} {
  const [records, setRecords] = useState<LinkableSourceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * A failed search is NOT an empty search.
   *
   * Rendering "no records found" when the channel is broken is the BACKLOG-1898
   * shape — it makes a dead IPC channel indistinguishable from a genuinely
   * empty address book, and here it would tell the user their record does not
   * exist when it does.
   */
  const [searchFailed, setSearchFailed] = useState(false);
  const isMountedRef = useRef(true);
  /** Only the newest search may write state; an earlier reply is stale. */
  const requestSeqRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const search = useCallback(
    (query: string) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      void (async () => {
        try {
          const result = await window.api.contacts.findLinkableSources(userId, query);
          if (!isMountedRef.current || seq !== requestSeqRef.current) return;
          if (!result.success) {
            logger.warn(`[Contacts] linkable source search failed: ${result.error}`);
            setSearchFailed(true);
            setRecords([]);
          } else {
            setSearchFailed(false);
            setRecords(result.records ?? []);
          }
        } catch (err) {
          if (!isMountedRef.current || seq !== requestSeqRef.current) return;
          logger.warn(`[Contacts] linkable source search threw: ${String(err)}`);
          setSearchFailed(true);
          setRecords([]);
        } finally {
          if (isMountedRef.current && seq === requestSeqRef.current) setLoading(false);
        }
      })();
    },
    [userId],
  );

  const link = useCallback(
    async (
      contactId: string,
      record: LinkableSourceRecord,
      acknowledgedPriorRejection?: boolean,
    ): Promise<LinkSourceOutcome | null> => {
      try {
        const result = await window.api.contacts.linkSource(
          userId,
          contactId,
          record.sourceType,
          record.sourceRecordId,
          acknowledgedPriorRejection,
        );
        if (!result.success) {
          logger.warn(`[Contacts] link source failed: ${result.error}`);
          return null;
        }
        return result.outcome ?? null;
      } catch (err) {
        logger.warn(`[Contacts] link source threw: ${String(err)}`);
        return null;
      }
    },
    [userId],
  );

  return { records, loading, searchFailed, search, link };
}
