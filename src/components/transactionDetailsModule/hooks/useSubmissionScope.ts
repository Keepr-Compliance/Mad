/**
 * BACKLOG-3683 (founder decision B) — what a submission with the dates on the
 * date step would send.
 *
 * The dates are not saved until Submit, but the summary is shown before that,
 * so it is counted from the candidate dates. They are converted by
 * `confirmedDatesUpdate`, the same function the save uses, and the main
 * process reads them through the same window as the submit — so the summary
 * cannot promise a different set than the one sent.
 */
import { useCallback, useRef, useState } from "react";
import { transactionService } from "../../../services";
import {
  confirmedDatesUpdate,
  type ConfirmedTransactionDates,
} from "../../transactionDates";
import type { SubmissionScopeIpcResult } from "@electron/types/ipc/window-api-transactions";

export type SubmissionScope = Required<Pick<SubmissionScopeIpcResult, "inWindow">>;

export type SubmissionScopeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; scope: SubmissionScope }
  | { status: "failed" };

export function useSubmissionScope(transactionId: string): {
  state: SubmissionScopeState;
  load: (dates: ConfirmedTransactionDates) => Promise<void>;
} {
  const [state, setState] = useState<SubmissionScopeState>({ status: "idle" });
  const runRef = useRef(0);

  const load = useCallback(
    async (dates: ConfirmedTransactionDates) => {
      const run = ++runRef.current;
      setState({ status: "loading" });
      const update = confirmedDatesUpdate(dates);
      const answer = await transactionService.getSubmissionScope(transactionId, {
        started_at: update.started_at,
        closed_at: update.closed_at,
      });
      if (run !== runRef.current) return;
      if (answer.success && answer.inWindow) {
        setState({ status: "ready", scope: { inWindow: answer.inWindow } });
      } else {
        setState({ status: "failed" });
      }
    },
    [transactionId]
  );

  return { state, load };
}
