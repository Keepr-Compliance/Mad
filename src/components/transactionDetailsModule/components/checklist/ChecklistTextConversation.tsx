/**
 * ChecklistTextConversation — BACKLOG-3968 U2.
 *
 * View on a text chip: the conversation the linked text belongs to, opened
 * where the user is (as an email chip's View opens its thread). The
 * conversation is found by the text's `messages.id` (`findTextThread`) and read
 * a page at a time through the paged text reader, all history.
 *
 * Read-only: no hide-from-export here (that stays on the Texts tab).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConversationViewModal } from "../modals";
import { useTextThreadPages } from "../../hooks/useTextThreads";
import { otherParties, textName } from "../../hooks/useChecklistTexts";
import { transactionService } from "../../../../services/transactionService";
import { contactService } from "../../../../services/contactService";
import { extractAllHandles } from "../../../../utils/phoneNormalization";
import logger from "../../../../utils/logger";

interface ChecklistTextConversationProps {
  transactionId: string;
  userId?: string;
  /** `messages.id` of the linked text. */
  messageId: string;
  onClose: () => void;
  /** Said when the conversation cannot be found any more. */
  onShowError: (message: string) => void;
}

const NO_KEYS: string[] = [];

export function ChecklistTextConversation({
  transactionId,
  userId,
  messageId,
  onClose,
  onShowError,
}: ChecklistTextConversationProps): React.ReactElement | null {
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  // Read through refs: a parent that passes new callbacks each render must not
  // look the conversation up again.
  const onCloseRef = useRef(onClose);
  const onShowErrorRef = useRef(onShowError);
  onCloseRef.current = onClose;
  onShowErrorRef.current = onShowError;

  useEffect(() => {
    let cancelled = false;
    void transactionService
      .findTextThread(transactionId, messageId)
      .then((key) => {
        if (cancelled) return;
        if (key) setThreadKey(key);
        else {
          onShowErrorRef.current("This text is no longer on this transaction.");
          onCloseRef.current();
        }
      })
      .catch((err) => {
        if (cancelled) return;
        logger.error("Opening a checklist text failed:", err);
        onShowErrorRef.current("Couldn't open this conversation.");
        onCloseRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [transactionId, messageId]);

  const keys = useMemo(() => (threadKey ? [threadKey] : NO_KEYS), [threadKey]);
  const pages = useTextThreadPages(transactionId, keys, null, !!threadKey);

  const handlesKey = useMemo(() => extractAllHandles(pages.messages).sort().join(","), [pages.messages]);
  useEffect(() => {
    if (!handlesKey) return;
    let cancelled = false;
    void contactService.resolveHandles(handlesKey.split(","), userId, transactionId).then((n) => {
      if (!cancelled) setNames(n);
    });
    return () => {
      cancelled = true;
    };
  }, [handlesKey, userId, transactionId]);

  if (!threadKey) return null;
  const first = pages.messages[0];
  const phone = first ? (otherParties(first)[0] ?? "") : "";
  return (
    <ConversationViewModal
      messages={pages.messages}
      contactName={first ? textName(first, names) : undefined}
      phoneNumber={phone}
      contactNames={names}
      onClose={onClose}
      pagination={{
        hasMore: pages.hasMore,
        loading: pages.loading,
        loadMore: () => void pages.loadMore(),
        totalCount: pages.messages.length,
      }}
    />
  );
}

export default ChecklistTextConversation;
