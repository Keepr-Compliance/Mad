/**
 * BACKLOG-3600 (control D5, renderer half) — a successful submission whose
 * checklists did not reach the broker says so on the success screen.
 *
 * Two links in the chain, one test each:
 *   useSubmitForReview  holds `checklistsNotSent` from the IPC result, and
 *                       clears it on a failed submit and on reset;
 *   SubmitForReviewModal renders the line only when the submit SUCCEEDED and
 *                       the field is set.
 *
 * The IPC result shape is the handler's (`transactionExportHandlers.ts`,
 * transactions:submit / transactions:resubmit), which carries the field
 * verbatim from `SubmissionResult.checklistsNotSent`.
 */
import React from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CHECKLISTS_NOT_SENT_COPY,
  SubmitForReviewModal,
  type ChecklistsNotSentReason,
  type SubmitProgress,
} from "../SubmitForReviewModal";
import { useSubmitForReview } from "../../../hooks/useSubmitForReview";
import type { Transaction } from "@/types";

const transaction = {
  id: "txn-3600",
  user_id: "user-3600",
  property_address: "7 Orchard Row",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

const COMPLETE: SubmitProgress = {
  stage: "complete",
  stageProgress: 100,
  overallProgress: 100,
  currentItem: "Submission complete!",
};
const FAILED: SubmitProgress = {
  stage: "failed",
  stageProgress: 0,
  overallProgress: 0,
  currentItem: "x",
};

function renderModal(
  overrides: Partial<React.ComponentProps<typeof SubmitForReviewModal>> = {},
) {
  return render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={1}
      textThreadCount={1}
      attachmentCount={0}
      emailAttachmentCount={0}
      totalSizeBytes={0}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={jest.fn()}
      {...overrides}
    />,
  );
}

describe("BACKLOG-3600 — the success screen names checklists that were not sent", () => {
  it.each(["not_in_plan", "refused", "brokerChecklistsNotDownloaded"] as ChecklistsNotSentReason[])(
    "success + %s -> one line, in full",
    (reason) => {
      renderModal({ progress: COMPLETE, checklistsNotSent: reason });
      expect(screen.getByTestId("submit-review-checklists-not-sent")).toHaveTextContent(
        CHECKLISTS_NOT_SENT_COPY[reason],
      );
      expect(screen.getByText("Successfully Submitted")).toBeInTheDocument();
    },
  );

  it("each reason reads differently (BACKLOG-3599 adds the third)", () => {
    expect(CHECKLISTS_NOT_SENT_COPY.not_in_plan).toBe(
      "Submitted, but your checklists were not sent: checklists are not included in your current plan.",
    );
    expect(CHECKLISTS_NOT_SENT_COPY.refused).toBe(
      "Submitted, but your checklists could not be sent to your broker.",
    );
    expect(CHECKLISTS_NOT_SENT_COPY.brokerChecklistsNotDownloaded).toBe(
      "Submitted, but the checklists your broker added could not be downloaded first, so this version does not include them.",
    );
  });

  it("success without the field -> no line", () => {
    renderModal({ progress: COMPLETE });
    expect(screen.queryByTestId("submit-review-checklists-not-sent")).toBeNull();
  });

  it("a failed submit never shows the line, even with a stale field", () => {
    renderModal({ progress: FAILED, error: "boom", checklistsNotSent: "refused" });
    expect(screen.queryByTestId("submit-review-checklists-not-sent")).toBeNull();
  });
});

describe("BACKLOG-3600 — useSubmitForReview holds the field from the IPC result", () => {
  const submit = jest.fn();
  const resubmit = jest.fn();
  beforeEach(() => {
    submit.mockReset();
    resubmit.mockReset();
    (window as unknown as { api: unknown }).api = {
      transactions: { submit, resubmit, onSubmitProgress: () => () => undefined },
    };
  });

  it.each([
    [false, submit],
    [true, resubmit],
  ])("isResubmit=%s: success carries it; a later failure and reset clear it", async (isResubmit, api) => {
    const { result } = renderHook(() =>
      useSubmitForReview({ transactionId: "txn-3600", isResubmit }),
    );

    api.mockResolvedValueOnce({ success: true, submissionId: "s-1", checklistsNotSent: "not_in_plan" });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.checklistsNotSent).toBe("not_in_plan");

    api.mockResolvedValueOnce({ success: false, error: "no" });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.checklistsNotSent).toBeNull();

    api.mockResolvedValueOnce({ success: true, submissionId: "s-2", checklistsNotSent: "refused" });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.checklistsNotSent).toBe("refused");
    act(() => result.current.reset());
    expect(result.current.checklistsNotSent).toBeNull();
  });
});
