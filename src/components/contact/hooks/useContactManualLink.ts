import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../../utils/logger";
import type {
  LinkableSourceRecord,
  LinkSourceOutcome,
  SourceRecordRef,
} from "@/types/contactProvenance";

/**
 * Renderer plumbing for BACKLOG-2426 manual linking, reshaped for BACKLOG-2591.
 *
 * ===========================================================================
 * ONE READ PER PANEL OPEN, NOT ONE PER KEYSTROKE
 * ===========================================================================
 * This used to call the main process on every keystroke and carry a request
 * sequence guard so a slow reply could not overwrite a newer one. Both are gone:
 * `ContactSearchList` now filters the list in memory, exactly like the
 * transaction pickers, so there is one load when the panel opens and the whole
 * staleness class disappears with it.
 *
 * The guard was DELETED rather than left inert — an unused ordering guard reads
 * like a live invariant to the next person, and would be re-armed around a
 * problem that no longer exists.
 */
export function useContactManualLink(userId: string): {
  records: LinkableSourceRecord[];
  loading: boolean;
  loadFailed: boolean;
  load: () => void;
  link: (
    contactId: string,
    records: SourceRecordRef[],
    acknowledgedPriorRejections?: SourceRecordRef[],
  ) => Promise<LinkSourceOutcome[] | null>;
} {
  const [records, setRecords] = useState<LinkableSourceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * A failed load is NOT an empty address book.
   *
   * Rendering "no records" when the channel is broken is the BACKLOG-1898
   * shape, and here it would tell the user a person they can see in their Mac
   * address book does not exist. `ContactSearchList` has an `error` branch but
   * only shows it when a caller supplies one — so this flag is what keeps the
   * distinction alive through the BACKLOG-2591 swap instead of inheriting the
   * conflation the transaction pickers still have (BACKLOG-2592).
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    void (async () => {
      try {
        const result = await window.api.contacts.findLinkableSources(userId);
        if (!isMountedRef.current) return;
        if (!result.success) {
          logger.warn(`[Contacts] linkable source load failed: ${result.error}`);
          setLoadFailed(true);
          setRecords([]);
        } else {
          setLoadFailed(false);
          setRecords(result.records ?? []);
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        logger.warn(`[Contacts] linkable source load threw: ${String(err)}`);
        setLoadFailed(true);
        setRecords([]);
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    })();
  }, [userId]);

  const link = useCallback(
    async (
      contactId: string,
      toLink: SourceRecordRef[],
      acknowledgedPriorRejections?: SourceRecordRef[],
    ): Promise<LinkSourceOutcome[] | null> => {
      try {
        const result = await window.api.contacts.linkSource(
          userId,
          contactId,
          toLink,
          acknowledgedPriorRejections,
        );
        if (!result.success) {
          logger.warn(`[Contacts] link source failed: ${result.error}`);
          return null;
        }
        return result.outcomes ?? null;
      } catch (err) {
        logger.warn(`[Contacts] link source threw: ${String(err)}`);
        return null;
      }
    },
    [userId],
  );

  return { records, loading, loadFailed, load, link };
}
