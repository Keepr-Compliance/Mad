/**
 * useTransactionCommunications Hook
 * Manages communication operations for transaction details
 */
import { useState, useCallback } from "react";
import type { Communication } from "../types";
import logger from '../../../utils/logger';

interface UseTransactionCommunicationsResult {
  unlinkingCommId: string | null;
  showUnlinkConfirm: Communication | null;
  viewingEmail: Communication | null;
  setShowUnlinkConfirm: (comm: Communication | null) => void;
  setViewingEmail: (comm: Communication | null) => void;
  handleUnlinkCommunication: (
    comm: Communication,
    /**
     * BACKLOG-1778: receives the communication ids the backend removed
     * (clicked row + thread siblings) so the caller can drop those rows in
     * place. Empty/undefined when the payload lacks ids (defensive fallback).
     */
    onSuccess: (result: { unlinkedIds?: string[] }) => void,
    onError: (message: string) => void
  ) => Promise<void>;
}

/**
 * Hook for managing transaction communication operations
 */
export function useTransactionCommunications(): UseTransactionCommunicationsResult {
  const [unlinkingCommId, setUnlinkingCommId] = useState<string | null>(null);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState<Communication | null>(null);
  const [viewingEmail, setViewingEmail] = useState<Communication | null>(null);

  /**
   * Handle unlinking a communication from transaction
   */
  const handleUnlinkCommunication = useCallback(
    async (
      comm: Communication,
      onSuccess: (result: { unlinkedIds?: string[] }) => void,
      onError: (message: string) => void
    ): Promise<void> => {
      try {
        setUnlinkingCommId(comm.id);
        // Use communication_id (the actual communications table ID) instead of comm.id
        // comm.id may be the message ID when the communication has a message_id link
        // See: getCommunicationsWithMessages() query returns COALESCE(m.id, c.id) as id
        // Fall back to comm.id if communication_id is not present (e.g., text messages)
        const communicationId = (comm as unknown as { communication_id?: string }).communication_id || comm.id;
        const result = await window.api.transactions.unlinkCommunication(communicationId);

        if (result.success) {
          setShowUnlinkConfirm(null);
          // BACKLOG-1778: forward the removed ids so the caller can update the
          // list in place (falls back to a refetch when ids are absent).
          onSuccess({ unlinkedIds: result.unlinkedIds });
        } else {
          logger.error("Failed to unlink communication:", result.error);
          onError("Failed to unlink email. Please try again.");
        }
      } catch (err) {
        logger.error("Failed to unlink communication:", err);
        onError("Failed to unlink email. Please try again.");
      } finally {
        setUnlinkingCommId(null);
      }
    },
    []
  );

  return {
    unlinkingCommId,
    showUnlinkConfirm,
    viewingEmail,
    setShowUnlinkConfirm,
    setViewingEmail,
    handleUnlinkCommunication,
  };
}
