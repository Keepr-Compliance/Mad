/**
 * useContactCommViewers
 * BACKLOG-1936 (Phase 2 · T4 — Clients & Contacts): shared, in-place email/text
 * viewer plumbing for the ContactPreview card. Extracted verbatim from
 * `Contacts.tsx` (BACKLOG-1934/1935) so the transaction "Key Contacts" pane
 * (`TransactionDetailsTab`) can mount the SAME viewers without a second,
 * divergent copy — the whole point of T4 (unify the two surfaces).
 *
 * What it owns:
 * - The email/thread currently open in place (`viewingEmail` / `viewingThread`).
 * - Click handlers to open a comm over the card (`openEmail` / `openThread`) and
 *   to close it (`closeViewers`) — wired to `ContactPreview`'s `onEmailClick` /
 *   `onMessageClick`.
 * - The email address -> display_name map (via the shared `useContactNameMap`
 *   hook) so `EmailViewModal` resolves From/To when the header carries no name.
 * - The rendered `EmailViewModal` / `ConversationViewModal` elements, mounted in
 *   place over the card.
 *
 * "See transaction" behaviour is CALLER-CONTROLLED via `onSeeTransaction`:
 * - Contacts modal passes `onOpenTransaction` → the button appears (only for
 *   transaction-linked comms) and jumps to the comm's owning transaction,
 *   closing the viewer first.
 * - Transaction "Key Contacts" pane passes `undefined` → no "See transaction"
 *   button (you're already inside a transaction; the only sensible target is
 *   either self (a no-op) or a different transaction, which has no in-place
 *   open-by-id seam in the transaction view — BACKLOG-1936 decision). Closing
 *   the viewer returns to the Key Contacts pane.
 */
import React, { useCallback, useState } from "react";
import {
  EmailViewModal,
  ConversationViewModal,
} from "../components/transactionDetailsModule/components/modals";
import { useContactNameMap } from "./useContactNameMap";
import type { Communication, ContactMessageThread } from "@/types";

/**
 * No-op for EmailViewModal's required `onRemoveFromTransaction` in the contact
 * card, where there is no owning transaction to unlink from. The button itself
 * is hidden via `showRemoveFromTransaction={false}`; this only satisfies the
 * required prop. (Moved from Contacts.tsx during the T4 extraction.)
 */
const noopRemoveFromTransaction = (): void => {};

export interface UseContactCommViewersOptions {
  /**
   * User whose contacts feed the email name-map (for From/To resolution in
   * EmailViewModal). Required — every consumer of the contact card has a user.
   */
  userId: string;
  /**
   * Optional "See transaction" handler. When provided, a "See transaction"
   * button is shown in each viewer — but ONLY when the comm is actually linked
   * to a transaction (`transaction_id` present). Receives that owning
   * transaction id. When omitted, no button is rendered (the transaction-pane
   * context: BACKLOG-1936).
   */
  onSeeTransaction?: (transactionId: string) => void;
}

export interface UseContactCommViewers {
  /** Open an email in place over the card. Wire to ContactPreview.onEmailClick. */
  openEmail: (email: Communication) => void;
  /** Open a text thread in place over the card. Wire to ContactPreview.onMessageClick. */
  openThread: (thread: ContactMessageThread) => void;
  /**
   * Close any open viewer, returning to the card. Call this alongside clearing
   * the previewed contact so a viewer can't outlive its contact.
   */
  closeViewers: () => void;
  /**
   * The rendered viewer modals (email + thread). Mount this once in the consumer;
   * it renders `null` when nothing is open.
   */
  viewers: React.ReactElement;
}

/**
 * Shared in-place email/text viewer plumbing for the ContactPreview card.
 */
export function useContactCommViewers({
  userId,
  onSeeTransaction,
}: UseContactCommViewersOptions): UseContactCommViewers {
  // The email currently open in the in-place EmailViewModal (over the card).
  const [viewingEmail, setViewingEmail] = useState<Communication | null>(null);
  // The text thread currently open in the in-place ConversationViewModal.
  const [viewingThread, setViewingThread] =
    useState<ContactMessageThread | null>(null);

  // Email address -> display_name map so EmailViewModal can resolve From/To when
  // the header carries no name. Reuses the shared, session-cached name-map hook
  // (BACKLOG-1762) — one loader, one cache, one behaviour across all consumers.
  const emailNameMap = useContactNameMap(userId);

  const openEmail = useCallback((email: Communication) => {
    setViewingEmail(email);
  }, []);

  const openThread = useCallback((thread: ContactMessageThread) => {
    setViewingThread(thread);
  }, []);

  const closeViewers = useCallback(() => {
    setViewingEmail(null);
    setViewingThread(null);
  }, []);

  const handleCloseEmail = useCallback(() => {
    setViewingEmail(null);
  }, []);

  const handleCloseThread = useCallback(() => {
    setViewingThread(null);
  }, []);

  // "See transaction" from inside the email viewer: reuse the caller-supplied
  // seam to jump to the email's owning transaction. Only invoked when the email
  // is transaction-linked AND the caller opted in via onSeeTransaction.
  const handleSeeTransactionFromEmail = useCallback(() => {
    const transactionId = viewingEmail?.transaction_id;
    if (!transactionId || !onSeeTransaction) return;
    setViewingEmail(null);
    onSeeTransaction(transactionId);
  }, [viewingEmail, onSeeTransaction]);

  // "See transaction" from inside the thread viewer: same seam as email.
  const handleSeeTransactionFromThread = useCallback(() => {
    const transactionId = viewingThread?.transaction_id;
    if (!transactionId || !onSeeTransaction) return;
    setViewingThread(null);
    onSeeTransaction(transactionId);
  }, [viewingThread, onSeeTransaction]);

  const viewers = (
    <>
      {/*
        Email viewer opened IN PLACE over the contact card. The card is itself a
        modal (Contacts) or an inline pane (TransactionDetailsTab), so mounting
        EmailViewModal here keeps the user on the card — closing returns to it
        (no navigation).
        - showRemoveFromTransaction={false}: there's no owning transaction to
          unlink from in this context; the button is hidden (a no-op satisfies
          the required prop). Transaction-tab usage is unaffected (it omits both).
        - onSeeTransaction is wired only when the caller opted in (onSeeTransaction
          supplied) AND the email is transaction-linked.
      */}
      {viewingEmail && (
        <EmailViewModal
          email={viewingEmail}
          onClose={handleCloseEmail}
          onRemoveFromTransaction={noopRemoveFromTransaction}
          showRemoveFromTransaction={false}
          onSeeTransaction={
            onSeeTransaction && viewingEmail.transaction_id
              ? handleSeeTransactionFromEmail
              : undefined
          }
          nameMap={emailNameMap}
        />
      )}

      {/*
        Text-thread viewer opened IN PLACE over the contact card, mirroring the
        EmailViewModal mount above. The thread group carries its own `messages`
        and the REQUIRED `phoneNumber` (from T1) — passed straight through, no
        client-side grouping. There is no single audit window in the contact-card
        context, so audit dates are intentionally omitted (ConversationViewModal
        hides the audit filter when they are undefined). onSeeTransaction is wired
        only when the caller opted in AND the thread is transaction-linked.
      */}
      {viewingThread && (
        <ConversationViewModal
          messages={viewingThread.messages}
          phoneNumber={viewingThread.phoneNumber}
          onClose={handleCloseThread}
          onSeeTransaction={
            onSeeTransaction && viewingThread.transaction_id
              ? handleSeeTransactionFromThread
              : undefined
          }
        />
      )}
    </>
  );

  return { openEmail, openThread, closeViewers, viewers };
}

export default useContactCommViewers;
