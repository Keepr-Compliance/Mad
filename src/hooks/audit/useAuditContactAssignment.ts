/**
 * useAuditContactAssignment Hook
 * Manages contact selection, role assignment, and lazy contact loading.
 * Extracted from useAuditTransaction.ts (TASK-2261)
 */
import { useState, useEffect, useCallback } from "react";
import type { Contact, Transaction } from "../../../electron/types/models";
import type { ContactAssignment, ContactAssignments } from "./types";
import { useContactDirectory } from "../contacts/useContactDirectory";
import logger from "../../utils/logger";

interface UseAuditContactAssignmentProps {
  userId: string;
  propertyAddress: string;
  editTransaction?: Transaction;
}

export interface UseAuditContactAssignmentReturn {
  contactAssignments: ContactAssignments;
  selectedContactIds: string[];
  setSelectedContactIds: React.Dispatch<React.SetStateAction<string[]>>;
  assignContact: (role: string, contactId: string, isPrimary?: boolean, notes?: string) => void;
  removeContact: (role: string, contactId: string) => void;
  // Contact loading state (lazy-loaded when reaching step 2)
  contacts: Contact[];
  contactsLoading: boolean;
  contactsError: string | null;
  refreshContacts: () => Promise<void>;
  /**
   * BACKLOG-2631 — BOTH halves, committed as one render.
   *
   * This was `silentRefreshContacts`, and it re-read the SAVED half only. The
   * address-book half sat behind a once-per-mount guard in this file, so
   * answering "yes, same person" inside the wizard left the record the user had
   * just merged away on screen as a selectable row for the life of the modal —
   * `contacts:confirm-link` writes a `contact_source_links` row and
   * `contacts:get-available` suppresses on exactly that table, so the record
   * would have gone on the next read and there was no next read.
   *
   * The guard is gone and the refresh is the shared one. The name says which
   * lists move, because that was the thing the old name did not say.
   */
  refreshBothLists: () => Promise<void>;
  // External contacts (from macOS Contacts app, etc.)
  externalContacts: Contact[];
  externalContactsLoading: boolean;
  // Trigger lazy loading of contacts (called when step transitions to 2)
  triggerLazyLoad: () => void;
}

export function useAuditContactAssignment({
  userId,
  propertyAddress,
  editTransaction,
}: UseAuditContactAssignmentProps): UseAuditContactAssignmentReturn {
  // Contact assignments state
  const [contactAssignments, setContactAssignments] = useState<ContactAssignments>({});

  // Selected contact IDs for step 2 (select contacts)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);

  /**
   * BACKLOG-2631 — THE PICKER'S DATA COMES FROM THE SHARED HOOK NOW.
   *
   * This file used to hold its own copy of the loading layer: its own saved-half
   * fetch, its own address-book fetch, and its own once-per-mount guard on the
   * second one. That guard is what made the reported defect possible — the
   * wizard never asked the address book again, so a record merged away inside
   * the questions modal stayed on the list until the modal was closed and
   * reopened.
   *
   * Both `autoLoad*` flags off keep the wizard's lazy behaviour EXACTLY as it was:
   * nothing is read until `triggerLazyLoad` fires on the transition to step 2,
   * so opening the modal on step 1 still costs no contact query. Unifying the
   * refresh must not turn one fetch per picker-open into one fetch per mount —
   * that is asserted as a call count in
   * `ContactAssignmentStep.oneRefreshPath-2631.test.tsx`.
   *
   * `propertyAddress` selects `contacts:get-sorted-by-activity` over
   * `contacts:get-all`, which is what this hook already did.
   */
  const {
    contacts,
    contactsLoading,
    contactsError,
    externalContacts,
    externalContactsLoading,
    loadContacts,
    refreshBothLists,
    triggerLazyLoad,
  } = useContactDirectory({
    userId,
    propertyAddress,
    autoLoadSaved: false,
    autoLoadExternal: false,
  });

  // Wrapper to expose refresh functionality that always forces reload
  const refreshContacts = useCallback((): Promise<void> => {
    return loadContacts();
  }, [loadContacts]);

  // `refreshBothLists` returns the rows it loaded (the import path on Clients &
  // Contacts lands its detail card on them). Nothing in the wizard reads them —
  // it keeps its own `importedTwins` row data — so the promise is flattened to
  // void rather than widening this hook's contract with a value no caller uses.
  const refreshBothListsVoid = useCallback(async (): Promise<void> => {
    await refreshBothLists();
  }, [refreshBothLists]);

  /**
   * Pre-fill contact assignments when editing an existing transaction
   * TASK-1038: Fetch full transaction details (including contact_assignments)
   */
  useEffect(() => {
    if (!editTransaction) return;

    const populateContactAssignments = (
      contactAssignmentsData: Array<{
        id: string;
        contact_id: string;
        contact_name?: string;
        contact_email?: string;
        contact_phone?: string;
        contact_company?: string;
        role?: string;
        specific_role?: string;
        is_primary?: number;
        notes?: string;
      }> | undefined,
      suggestedContactsJson: string | undefined
    ) => {
      if (contactAssignmentsData && contactAssignmentsData.length > 0) {
        const assignments: ContactAssignments = {};
        contactAssignmentsData.forEach((ca) => {
          const role = ca.role || ca.specific_role;
          if (role && ca.contact_id) {
            if (!assignments[role]) {
              assignments[role] = [];
            }
            assignments[role].push({
              contactId: ca.contact_id,
              contactName: ca.contact_name || "",
              contactEmail: ca.contact_email,
              contactPhone: ca.contact_phone,
              contactCompany: ca.contact_company,
              isPrimary: ca.is_primary === 1,
              notes: ca.notes || "",
            });
          }
        });
        setContactAssignments(assignments);
      } else if (suggestedContactsJson) {
        try {
          const suggestedContacts = JSON.parse(suggestedContactsJson);
          const assignments: ContactAssignments = {};
          if (Array.isArray(suggestedContacts)) {
            suggestedContacts.forEach((sc: { role?: string; contact_id?: string; is_primary?: boolean; notes?: string }) => {
              if (sc.role && sc.contact_id) {
                if (!assignments[sc.role]) {
                  assignments[sc.role] = [];
                }
                assignments[sc.role].push({
                  contactId: sc.contact_id,
                  isPrimary: sc.is_primary || false,
                  notes: sc.notes || "",
                });
              }
            });
          }
          setContactAssignments(assignments);
        } catch {
          // Invalid JSON, leave assignments empty
        }
      }
    };

    const fetchFullDetails = async () => {
      try {
        const result = await window.api.transactions.getDetails(editTransaction.id);
        if (result.success && result.transaction) {
          const fullTransaction = result.transaction as Transaction & {
            contact_assignments?: Array<{
              id: string;
              contact_id: string;
              contact_name?: string;
              contact_email?: string;
              contact_phone?: string;
              contact_company?: string;
              role?: string;
              specific_role?: string;
              is_primary?: number;
              notes?: string;
            }>;
          };

          populateContactAssignments(
            fullTransaction.contact_assignments,
            fullTransaction.suggested_contacts
          );
        } else {
          const extendedTransaction = editTransaction as Transaction & {
            contact_assignments?: Array<{
              id: string;
              contact_id: string;
              contact_name?: string;
              contact_email?: string;
              contact_phone?: string;
              contact_company?: string;
              role?: string;
              specific_role?: string;
              is_primary?: number;
              notes?: string;
            }>;
          };
          populateContactAssignments(
            extendedTransaction.contact_assignments,
            editTransaction.suggested_contacts
          );
        }
      } catch (err) {
        logger.error("[useAuditContactAssignment] Failed to fetch transaction details:", err);
        const extendedTransaction = editTransaction as Transaction & {
          contact_assignments?: Array<{
            id: string;
            contact_id: string;
            contact_name?: string;
            contact_email?: string;
            contact_phone?: string;
            contact_company?: string;
            role?: string;
            specific_role?: string;
            is_primary?: number;
            notes?: string;
          }>;
        };
        populateContactAssignments(
          extendedTransaction.contact_assignments,
          editTransaction.suggested_contacts
        );
      }
    };

    fetchFullDetails();
  }, [editTransaction]);

  /**
   * Assign contact to a role
   */
  const assignContact = useCallback((
    role: string,
    contactId: string,
    isPrimary: boolean = false,
    notes: string = "",
  ): void => {
    setContactAssignments(prev => {
      const existing = prev[role] || [];
      const existingIndex = existing.findIndex(
        (c: ContactAssignment) => c.contactId === contactId,
      );

      if (existingIndex !== -1) {
        const updated = [...existing];
        updated[existingIndex] = { contactId, isPrimary, notes };
        return { ...prev, [role]: updated };
      } else {
        return { ...prev, [role]: [...existing, { contactId, isPrimary, notes }] };
      }
    });
  }, []);

  /**
   * Remove contact from a role
   */
  const removeContact = useCallback((role: string, contactId: string): void => {
    setContactAssignments(prev => {
      const existing = prev[role] || [];
      const filtered = existing.filter(
        (c: ContactAssignment) => c.contactId !== contactId,
      );
      return { ...prev, [role]: filtered };
    });
  }, []);

  return {
    contactAssignments,
    selectedContactIds,
    setSelectedContactIds,
    assignContact,
    removeContact,
    contacts,
    contactsLoading,
    contactsError,
    refreshContacts,
    refreshBothLists: refreshBothListsVoid,
    externalContacts,
    externalContactsLoading,
    triggerLazyLoad,
  };
}
