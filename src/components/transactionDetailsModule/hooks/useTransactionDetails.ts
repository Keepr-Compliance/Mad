/**
 * useTransactionDetails Hook
 * Manages transaction details data fetching and contact assignment state
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { Contact, Transaction } from "@/types";
import type {
  SuggestedContact,
  ResolvedSuggestedContact,
  ContactAssignment,
  Communication,
} from "../types";
import { isTextMessage, isEmailMessage } from "@/utils/channelHelpers";
import logger from '../../../utils/logger';

interface UseTransactionDetailsResult {
  // Data
  communications: Communication[];
  contactAssignments: ContactAssignment[];
  resolvedSuggestions: ResolvedSuggestedContact[];
  loading: boolean;

  // Actions
  loadDetails: () => Promise<void>;
  loadCommunications: (channelFilter: "email" | "text") => Promise<void>;
  setCommunications: React.Dispatch<React.SetStateAction<Communication[]>>;
  setResolvedSuggestions: React.Dispatch<React.SetStateAction<ResolvedSuggestedContact[]>>;
  updateSuggestedContacts: (remainingSuggestions: SuggestedContact[]) => Promise<void>;
  /**
   * TASK-2094: Optimistically remove communications by ID without triggering a
   * loading state.
   *
   * BACKLOG-1778 fix: the rendered communication rows carry two ids —
   *   `id`              = COALESCE(m.id, e.id, c.id)  (email/message content id)
   *   `communication_id`= c.id                        (communications junction id)
   * Callers may pass either: email unlink passes junction ids (c.id), while text
   * removal passes content ids (m.id). Matching on BOTH fields covers both.
   * Returns the number of rows actually removed so callers can fall back to a
   * full refetch when nothing matched (defensive).
   */
  removeCommunicationsByIds: (ids: string[]) => number;
}

/**
 * Hook for managing transaction details data
 */
export function useTransactionDetails(
  transaction: Transaction
): UseTransactionDetailsResult {
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [contactAssignments, setContactAssignments] = useState<ContactAssignment[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [resolvedSuggestions, setResolvedSuggestions] = useState<ResolvedSuggestedContact[]>([]);

  // BACKLOG-1778: keep a ref to the latest communications so removeCommunicationsByIds
  // can compute how many rows would be removed (for a synchronous return value)
  // without depending on setState updater timing.
  const communicationsRef = useRef<Communication[]>(communications);
  useEffect(() => {
    communicationsRef.current = communications;
  }, [communications]);

  /**
   * Parse and memoize suggested contacts from transaction
   */
  const suggestedContacts = useMemo((): SuggestedContact[] => {
    if (!transaction.suggested_contacts) return [];
    try {
      const parsed = JSON.parse(transaction.suggested_contacts);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (sc: SuggestedContact) => sc.role && sc.contact_id
        );
      }
      return [];
    } catch {
      return [];
    }
  }, [transaction.suggested_contacts]);

  /**
   * Load full transaction details (including communications).
   * Called on-demand when user navigates to emails/messages/attachments tabs.
   */
  const loadDetails = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const result = await window.api.transactions.getDetails(transaction.id);

      if (result.success && result.transaction) {
        setCommunications(result.transaction.communications || []);
        setContactAssignments(
          result.transaction.contact_assignments || []
        );
      }
    } catch (err) {
      logger.error("Failed to load details:", err);
    } finally {
      setLoading(false);
    }
  }, [transaction.id]);

  /**
   * PERF: Load only emails or only texts — avoids fetching all 74K+ communications.
   * Used when user navigates to the Emails or Messages tab.
   */
  const loadCommunications = useCallback(async (channelFilter: "email" | "text"): Promise<void> => {
    try {
      setLoading(true);
      // getCommunications returns { success, transaction: { communications, contact_assignments } }
      const result = await window.api.transactions.getCommunications(transaction.id, channelFilter) as {
        success: boolean;
        transaction?: { communications?: Communication[]; contact_assignments?: ContactAssignment[] };
      };

      if (result.success && result.transaction) {
        // Merge with existing communications (don't overwrite other channel)
        setCommunications(prev => {
          const newComms: Communication[] = result.transaction?.communications || [];
          // Keep only comms from the OTHER channel; replace the fetched channel entirely.
          const kept = channelFilter === "text"
            ? prev.filter((c: Communication) => !isTextMessage(c))
            : prev.filter((c: Communication) => !isEmailMessage(c));
          return [...kept, ...newComms];
        });
        setContactAssignments(result.transaction.contact_assignments || []);
      }
    } catch (err) {
      logger.error(`Failed to load ${channelFilter} communications:`, err);
    } finally {
      setLoading(false);
    }
  }, [transaction.id]);

  /**
   * PERF: Load lightweight overview (contacts only, no communications).
   * Used for initial render of overview tab — avoids expensive 3-way JOIN.
   */
  const loadOverview = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const result = await window.api.transactions.getOverview(transaction.id);

      if (result.success && result.transaction) {
        setContactAssignments(
          result.transaction.contact_assignments || []
        );
      }
    } catch (err) {
      logger.error("Failed to load overview:", err);
      // Fallback to full details if overview not available
      try {
        const fallback = await window.api.transactions.getDetails(transaction.id);
        if (fallback.success && fallback.transaction) {
          setContactAssignments(fallback.transaction.contact_assignments || []);
        }
      } catch (e) {
        logger.error("Fallback getDetails also failed:", e);
      }
    } finally {
      setLoading(false);
    }
  }, [transaction.id]);

  /**
   * Resolve contact details for all suggested contacts
   */
  useEffect(() => {
    const resolveContacts = async () => {
      if (suggestedContacts.length === 0) {
        setResolvedSuggestions([]);
        return;
      }

      try {
        const contactsResult = await window.api.contacts.getAll(transaction.user_id);
        if (contactsResult.success && contactsResult.contacts) {
          const contactMap = new Map(
            contactsResult.contacts.map((c: Contact) => [c.id, c])
          );
          const resolved = suggestedContacts.map((sc) => ({
            ...sc,
            contact: contactMap.get(sc.contact_id),
          }));
          setResolvedSuggestions(resolved);
        }
      } catch (err) {
        logger.error("Failed to resolve suggested contacts:", err);
        // Still show suggestions without contact details
        setResolvedSuggestions(suggestedContacts.map((sc) => ({ ...sc })));
      }
    };

    resolveContacts();
  }, [suggestedContacts, transaction.user_id]);

  /**
   * PERF: Load lightweight overview on mount (contacts only, no communications).
   * Full details (loadDetails) are loaded on-demand when user navigates to
   * emails/messages/attachments tabs.
   */
  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  /**
   * Helper to update suggested_contacts in database after processing
   */
  const updateSuggestedContacts = useCallback(
    async (remainingSuggestions: SuggestedContact[]): Promise<void> => {
      const newValue =
        remainingSuggestions.length > 0
          ? JSON.stringify(remainingSuggestions)
          : null;
      await window.api.transactions.update(transaction.id, {
        suggested_contacts: newValue,
      });
    },
    [transaction.id]
  );

  /**
   * TASK-2094: Optimistically remove communications by ID from local state.
   * Does NOT trigger loading state or backend refetch — the list updates in-place.
   *
   * BACKLOG-1778: the joined getCommunications payload exposes two ids per row —
   * `id` (COALESCE(m.id, e.id, c.id)) and `communication_id` (c.id). Email unlink
   * returns junction ids (c.id) while text removal passes content ids (m.id), so
   * a row is a match when EITHER field is in the requested id set. Returns the
   * count removed so callers can fall back to a full refetch when 0 matched.
   */
  const removeCommunicationsByIds = useCallback((ids: string[]): number => {
    const idSet = new Set(ids);
    const matches = (c: Communication): boolean => {
      const junctionId = (c as unknown as { communication_id?: string }).communication_id;
      return idSet.has(c.id) || (!!junctionId && idSet.has(junctionId));
    };
    const removedCount = communicationsRef.current.filter(matches).length;
    if (removedCount > 0) {
      setCommunications(prev => prev.filter(c => !matches(c)));
    }
    return removedCount;
  }, []);

  return {
    communications,
    contactAssignments,
    resolvedSuggestions,
    loading,
    loadDetails,
    loadCommunications,
    setCommunications,
    setResolvedSuggestions,
    updateSuggestedContacts,
    removeCommunicationsByIds,
  };
}
