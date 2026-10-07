/**
 * useAuditSubmission Hook
 * Manages transaction creation/update, change detection, and submission state.
 * Extracted from useAuditTransaction.ts (TASK-2261)
 */
import { useState, useCallback } from "react";
import {
  ROLE_TO_CATEGORY,
} from "../../constants/contactRoles";
import type { Transaction } from "../../../electron/types/models";
import type { AddressData, ContactAssignment, ContactAssignments } from "./types";
import { parseMoney } from "../../components/transactionDates/commission";

interface UseAuditSubmissionProps {
  userId: string;
  editTransaction?: Transaction;
  isEditing: boolean;
  addressData: AddressData;
  originalAddressData: AddressData | null;
  contactAssignments: ContactAssignments;
  onSuccess: (transaction: Transaction) => void;
  onClose: () => void;
}

export interface UseAuditSubmissionReturn {
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  handleCreateTransaction: () => Promise<void>;
}

export function useAuditSubmission({
  userId,
  editTransaction,
  isEditing,
  addressData,
  originalAddressData,
  contactAssignments,
  onSuccess,
  onClose,
}: UseAuditSubmissionProps): UseAuditSubmissionReturn {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Detect changes between original and current address data
   */
  const getAddressChanges = useCallback((): Record<string, { original: string; corrected: string }> | null => {
    if (!originalAddressData) return null;

    const changes: Record<string, { original: string; corrected: string }> = {};

    if (addressData.property_address !== originalAddressData.property_address) {
      changes.property_address = {
        original: originalAddressData.property_address,
        corrected: addressData.property_address,
      };
    }
    if (addressData.transaction_type !== originalAddressData.transaction_type) {
      changes.transaction_type = {
        original: originalAddressData.transaction_type,
        corrected: addressData.transaction_type,
      };
    }
    if (addressData.property_street !== originalAddressData.property_street) {
      changes.property_street = {
        original: originalAddressData.property_street,
        corrected: addressData.property_street,
      };
    }
    if (addressData.property_city !== originalAddressData.property_city) {
      changes.property_city = {
        original: originalAddressData.property_city,
        corrected: addressData.property_city,
      };
    }
    if (addressData.property_state !== originalAddressData.property_state) {
      changes.property_state = {
        original: originalAddressData.property_state,
        corrected: addressData.property_state,
      };
    }
    if (addressData.property_zip !== originalAddressData.property_zip) {
      changes.property_zip = {
        original: originalAddressData.property_zip,
        corrected: addressData.property_zip,
      };
    }
    if (addressData.started_at !== originalAddressData.started_at) {
      changes.started_at = {
        original: originalAddressData.started_at,
        corrected: addressData.started_at,
      };
    }
    if ((addressData.closed_at || "") !== (originalAddressData.closed_at || "")) {
      changes.closed_at = {
        original: originalAddressData.closed_at || "",
        corrected: addressData.closed_at || "",
      };
    }

    return Object.keys(changes).length > 0 ? changes : null;
  }, [addressData, originalAddressData]);

  /**
   * Create or update the transaction with all contact assignments
   */
  const handleCreateTransaction = useCallback(async (): Promise<void> => {
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const assignments = Object.entries(contactAssignments).flatMap(
        ([role, contacts]: [string, ContactAssignment[]]) =>
          contacts.map((contact: ContactAssignment) => ({
            role: role,
            role_category: ROLE_TO_CATEGORY[role],
            contact_id: contact.contactId,
            is_primary: contact.isPrimary ? 1 : 0,
            notes: contact.notes || null,
          })),
      );

      let result: { success: boolean; transaction?: Transaction; error?: string };

      // BACKLOG-3614: the optional Listing Price, typed as text on step 1.
      // Step validation has already rejected an unparseable value, so `ok` is
      // true here; blank parses to null (not entered).
      const { listing_price_text: listingPriceText, ...address } = addressData;
      const listingParsed = parseMoney(listingPriceText ?? "");
      const listingPrice = listingParsed.ok ? listingParsed.value : null;

      if (isEditing && editTransaction) {
        const updateData = {
          property_address: addressData.property_address,
          property_street: addressData.property_street,
          property_city: addressData.property_city,
          property_state: addressData.property_state,
          property_zip: addressData.property_zip,
          property_coordinates: addressData.property_coordinates
            ? JSON.stringify(addressData.property_coordinates)
            : undefined,
          transaction_type: addressData.transaction_type as Transaction["transaction_type"],
          detection_status: "confirmed" as const,
          reviewed_at: new Date().toISOString(),
          started_at: addressData.started_at,
          closing_deadline: addressData.closing_deadline || null,
          closed_at: addressData.closed_at || null,
          // BACKLOG-3614: blank clears it.
          listing_price: listingPrice,
        };

        const updateResult = await window.api.transactions.update(
          editTransaction.id,
          updateData,
        );

        const changes = getAddressChanges();
        if (changes && window.api.feedback?.recordTransaction) {
          await window.api.feedback.recordTransaction(userId, {
            detectedTransactionId: editTransaction.id,
            action: "confirm",
            corrections: changes,
          });
        }

        result = {
          success: updateResult.success,
          transaction: updateResult.success
            ? { ...editTransaction, ...updateData } as Transaction
            : undefined,
          error: updateResult.error,
        };
      } else {
        result = await window.api.transactions.createAudited(userId, {
          ...address,
          // BACKLOG-3614: sent only when entered; a blank field creates the deal
          // with no listing price.
          ...(listingPrice !== null ? { listing_price: listingPrice } : {}),
          contact_assignments: assignments,
        });
      }

      if (result.success && result.transaction) {
        onSuccess(result.transaction);
        onClose();
      } else {
        setError(result.error || `Failed to ${isEditing ? "update" : "create"} transaction`);
        setLoading(false);
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : `Failed to ${isEditing ? "update" : "create"} transaction`;
      setError(errorMessage);
      setLoading(false);
    }
  }, [
    loading,
    contactAssignments,
    isEditing,
    editTransaction,
    addressData,
    getAddressChanges,
    userId,
    onSuccess,
    onClose,
  ]);

  return {
    loading,
    error,
    setError,
    handleCreateTransaction,
  };
}
