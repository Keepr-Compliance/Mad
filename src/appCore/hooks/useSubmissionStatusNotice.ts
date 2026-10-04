/**
 * useSubmissionStatusNotice Hook (BACKLOG-3594)
 *
 * Tells the agent, once per status change, that a submission came back from
 * the broker: changes requested, rejected or approved. The notice names the
 * transaction and carries an "Open" action.
 *
 * Producer: `submissionSyncService.emitStatusChange` (main) sends
 * `submission-status-changed`, only when the status actually changed, after
 * the local row is written. Bridge: `transactions.onSubmissionStatusChanged`.
 *
 * Mounted by `AppModals`, which `App.tsx` renders on every licensed screen.
 * The old subscriber (`useSubmissionSync`) lives in `Transactions.tsx`, which
 * nothing renders — that is why the agent was never told.
 *
 * The two other mounted subscribers (BACKLOG-3595: the transaction list and
 * the open details header) only refresh data and must never raise a notice;
 * this hook is the single place a notice comes from.
 */

import { useEffect, useRef } from "react";
import { useNotification } from "../../hooks/useNotification";
import type { WindowApiTransactions } from "@electron/types/ipc/window-api-transactions";

/** Payload of `submission-status-changed`, as declared for the preload bridge. */
export type SubmissionStatusChangedEvent = Parameters<
  Parameters<WindowApiTransactions["onSubmissionStatusChanged"]>[0]
>[0];

interface UseSubmissionStatusNoticeOptions {
  /** Open the given transaction (Transactions view + its details). */
  onOpenTransaction: (transactionId: string) => void;
}

type NoticeKind = "success" | "warning";

/** The statuses that mean "your submission came back". Others are not noticed. */
function describe(
  newStatus: string,
  address: string,
): { kind: NoticeKind; text: string } | null {
  switch (newStatus) {
    case "needs_changes":
      return { kind: "warning", text: `Your broker requested changes on ${address}` };
    case "rejected":
      return { kind: "warning", text: `Your broker rejected ${address}` };
    case "approved":
      return { kind: "success", text: `Your broker approved ${address}` };
    default:
      return null;
  }
}

export function useSubmissionStatusNotice({
  onOpenTransaction,
}: UseSubmissionStatusNoticeOptions): void {
  const { notify } = useNotification();

  // Latest values read through refs so the subscription is made once, not
  // re-made whenever the caller passes a new callback.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const openRef = useRef(onOpenTransaction);
  openRef.current = onOpenTransaction;

  // Last status seen per transaction. Realtime and the poller can both apply
  // the same transition (each awaits a network pull before writing), so the
  // same event can arrive twice; only a different status is a new change.
  const lastStatusRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const subscribe = window.api?.transactions?.onSubmissionStatusChanged;
    if (typeof subscribe !== "function") return;

    const unsubscribe = subscribe((data: SubmissionStatusChangedEvent) => {
      if (!data?.transactionId) return;
      const seen = lastStatusRef.current;
      if (seen.get(data.transactionId) === data.newStatus) return;
      seen.set(data.transactionId, data.newStatus);

      const address = data.propertyAddress?.trim() || "a transaction";
      const notice = describe(data.newStatus, address);
      if (!notice) return;

      const transactionId = data.transactionId;
      notifyRef.current[notice.kind](notice.text, {
        // Persistent: sync can land while the agent is looking elsewhere, and a
        // 5 s toast would be gone before they see it.
        persistent: true,
        action: {
          label: "Open",
          onClick: () => openRef.current(transactionId),
        },
      });
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);
}

export default useSubmissionStatusNotice;
