/**
 * useContactComms
 * BACKLOG-1933 (Phase 2 — Clients & Contacts): loads a contact's emails and
 * text-message threads, aggregated across ALL transactions, via the new
 * contact-scoped IPC (`window.api.contacts.getEmailsForContact` /
 * `getMessagesForContact`).
 *
 * This is the shared data-loading foundation (plan D-3) consumed by:
 * - T1/T2: the Contacts modal's Emails/Texts sections (`Contacts.tsx`)
 * - T4: the transaction "Key Contacts" pane (`TransactionDetailsTab`)
 * so the loaders are not duplicated / allowed to drift.
 *
 * Design notes:
 * - Takes `contactId` as an argument (no context coupling) so it can be used in
 *   components/tests without a provider. Pass `null`/`undefined` to reset.
 * - Returns hydrated `Communication[]` (ready for EmailViewModal) and
 *   `ContactMessageThread[]` (ready for ConversationViewModal — each group
 *   carries the required `phoneNumber`).
 * - Emails and texts load independently, each with its own loading flag, so one
 *   surface can render as soon as its data arrives.
 * - `transaction_id` may be undefined on any email/thread (comms not linked to a
 *   transaction — expected, see BACKLOG-1933 S2); consumers hide the
 *   "See transaction" affordance for those.
 * - StrictMode-safe: a `cancelled` flag guards the async setState (the dev
 *   double-invoke does not leak a stale update).
 */
import { useCallback, useEffect, useState } from "react";
import type { Communication, ContactMessageThread } from "@/types";
import logger from "../utils/logger";

export interface UseContactCommsResult {
  /** Hydrated emails involving the contact, newest-first (deduped by email id). */
  emails: Communication[];
  /** Text-message threads involving the contact, newest-activity-first. */
  messageThreads: ContactMessageThread[];
  /** True while the emails IPC call is in flight. */
  isLoadingEmails: boolean;
  /** True while the messages IPC call is in flight. */
  isLoadingMessages: boolean;
  /** Non-null when the emails fetch failed (message for display/logging). */
  emailsError: string | null;
  /** Non-null when the messages fetch failed. */
  messagesError: string | null;
  /** Re-run both fetches for the current contact. */
  reload: () => void;
}

const EMPTY_EMAILS: Communication[] = [];
const EMPTY_THREADS: ContactMessageThread[] = [];

/**
 * Loads a contact's emails + text threads via the contact-scoped IPC.
 *
 * @param contactId - Contact ID to load comms for; `null`/`undefined` resets to
 *   empty (no fetch).
 */
export function useContactComms(
  contactId?: string | null,
): UseContactCommsResult {
  const [emails, setEmails] = useState<Communication[]>(EMPTY_EMAILS);
  const [messageThreads, setMessageThreads] =
    useState<ContactMessageThread[]>(EMPTY_THREADS);
  const [isLoadingEmails, setIsLoadingEmails] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [emailsError, setEmailsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  // Bump to force a reload of the current contact.
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!contactId) {
      setEmails(EMPTY_EMAILS);
      setMessageThreads(EMPTY_THREADS);
      setIsLoadingEmails(false);
      setIsLoadingMessages(false);
      setEmailsError(null);
      setMessagesError(null);
      return;
    }

    const contactsApi = window.api?.contacts;
    let cancelled = false;

    // --- Emails ---
    setIsLoadingEmails(true);
    setEmailsError(null);
    void (async () => {
      try {
        if (!contactsApi?.getEmailsForContact) {
          if (!cancelled) setEmails(EMPTY_EMAILS);
          return;
        }
        const result = await contactsApi.getEmailsForContact(contactId);
        if (cancelled) return;
        if (result?.success) {
          setEmails(result.emails ?? EMPTY_EMAILS);
        } else {
          setEmails(EMPTY_EMAILS);
          setEmailsError(result?.error ?? "Failed to load emails");
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load emails";
        logger.error("useContactComms: failed to load contact emails", err, {
          contactId,
        });
        setEmails(EMPTY_EMAILS);
        setEmailsError(message);
      } finally {
        if (!cancelled) setIsLoadingEmails(false);
      }
    })();

    // --- Text threads ---
    setIsLoadingMessages(true);
    setMessagesError(null);
    void (async () => {
      try {
        if (!contactsApi?.getMessagesForContact) {
          if (!cancelled) setMessageThreads(EMPTY_THREADS);
          return;
        }
        const result = await contactsApi.getMessagesForContact(contactId);
        if (cancelled) return;
        if (result?.success) {
          setMessageThreads(result.messages ?? EMPTY_THREADS);
        } else {
          setMessageThreads(EMPTY_THREADS);
          setMessagesError(result?.error ?? "Failed to load messages");
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load messages";
        logger.error("useContactComms: failed to load contact messages", err, {
          contactId,
        });
        setMessageThreads(EMPTY_THREADS);
        setMessagesError(message);
      } finally {
        if (!cancelled) setIsLoadingMessages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId, reloadToken]);

  return {
    emails,
    messageThreads,
    isLoadingEmails,
    isLoadingMessages,
    emailsError,
    messagesError,
    reload,
  };
}

export default useContactComms;
