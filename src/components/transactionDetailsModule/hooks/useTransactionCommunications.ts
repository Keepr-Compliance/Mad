/**
 * useTransactionCommunications Hook
 * Manages communication operations for transaction details
 */
import { useState, useCallback } from "react";
import type { Communication } from "../types";
import logger from '../../../utils/logger';

/**
 * BACKLOG-2013 (founder QA): a frozen (post-export) transaction is add-only for
 * linked communications — detaching an already-linked email is blocked by the
 * main-process freeze guard, which throws a `TransactionFrozenError` whose
 * message is surfaced to the renderer as `result.error` (the `wrapHandler` IPC
 * contract preserves the message but not the typed `code`). When that happens we
 * must show the freeze explanation, NOT the generic "Please try again." string —
 * a retry can never succeed. All freeze messages share this prefix (see
 * transactionService.assertTransactionNotFrozenForDetach /
 * transactionDbService identity-freeze message).
 */
const FREEZE_MESSAGE_PREFIX = "Transaction is frozen after export";
const GENERIC_UNLINK_ERROR = "Failed to unlink email. Please try again.";

/**
 * Pick the message to surface for a failed unlink: the freeze explanation when
 * the failure is the export-freeze block, otherwise the generic retry fallback
 * (used for unknown / transient failures where retry may legitimately succeed).
 */
function unlinkErrorMessage(rawMessage: unknown): string {
  if (
    typeof rawMessage === "string" &&
    rawMessage.startsWith(FREEZE_MESSAGE_PREFIX)
  ) {
    return rawMessage;
  }
  return GENERIC_UNLINK_ERROR;
}

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
          // BACKLOG-2013: surface the freeze explanation when the detach was
          // blocked by the export-freeze policy; generic retry message otherwise.
          onError(unlinkErrorMessage(result.error));
        }
      } catch (err) {
        logger.error("Failed to unlink communication:", err);
        // BACKLOG-2013: a thrown TransactionFrozenError arrives here as an Error
        // whose message carries the freeze explanation — surface it, not the
        // misleading "Please try again." string.
        onError(
          unlinkErrorMessage(err instanceof Error ? err.message : undefined),
        );
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
