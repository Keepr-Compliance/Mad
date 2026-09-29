/**
 * BACKLOG-3399 (release part) — a successful submission whose attachments did
 * not all reach the broker says so on the success screen.
 *
 * Two IPC fields, both already returned by transactions:submit and
 * transactions:resubmit (`transactionExportHandlers.ts`):
 *   attachmentsFailed          gathered attachments whose upload failed
 *   flaggedWithoutAttachments  texts/emails that advertise an attachment and
 *                              contributed none (a count of ITEMS)
 *
 * Two links in the chain, one block each:
 *   useSubmitForReview   holds both counts from a SUCCESSFUL result; clears
 *                        them on a failed submit and on reset.
 *   SubmitForReviewModal renders one amber line per non-zero count, only on
 *                        success, after the checklists line.
 *
 * Fixtures are invented.
 */
import React from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CHECKLISTS_NOT_SENT_COPY,
  SubmitForReviewModal,
  attachmentsFailedCopy,
  flaggedWithoutAttachmentsCopy,
  type SubmitProgress,
} from "../SubmitForReviewModal";
import { useSubmitForReview } from "../../../hooks/useSubmitForReview";
import type { Transaction } from "@/types";

const transaction = {
  id: "txn-3399",
  user_id: "user-3399",
  property_address: "12 Willow Lane",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-02-02",
  closed_at: "2026-04-10T15:00:00.000Z",
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

const FAILED_ID = "submit-review-attachments-failed";
const FLAGGED_ID = "submit-review-flagged-without-attachments";
const CHECKLISTS_ID = "submit-review-checklists-not-sent";

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

describe("BACKLOG-3399 — the success screen names attachments that did not reach the broker", () => {
  it("copy, singular and plural, in full", () => {
    expect(attachmentsFailedCopy(1)).toBe(
      "Submitted, but 1 attachment couldn't be uploaded, so your broker won't see it.",
    );
    expect(attachmentsFailedCopy(3)).toBe(
      "Submitted, but 3 attachments couldn't be uploaded, so your broker won't see them.",
    );
    expect(flaggedWithoutAttachmentsCopy(1)).toBe(
      "Submitted, but the attachments from 1 text or email weren't included, so your broker won't see them.",
    );
    expect(flaggedWithoutAttachmentsCopy(2)).toBe(
      "Submitted, but the attachments from 2 texts or emails weren't included, so your broker won't see them.",
    );
  });

  it("success + attachmentsFailed=3 -> the upload line only", () => {
    renderModal({ progress: COMPLETE, attachmentsFailed: 3 });
    expect(screen.getByTestId(FAILED_ID)).toHaveTextContent(attachmentsFailedCopy(3));
    expect(screen.queryByTestId(FLAGGED_ID)).toBeNull();
    expect(screen.getByText("Successfully Submitted")).toBeInTheDocument();
  });

  it("success + attachmentsFailed=1 -> singular", () => {
    renderModal({ progress: COMPLETE, attachmentsFailed: 1 });
    expect(screen.getByTestId(FAILED_ID)).toHaveTextContent(attachmentsFailedCopy(1));
  });

  it("success + flaggedWithoutAttachments=2 -> the not-included line only", () => {
    renderModal({ progress: COMPLETE, flaggedWithoutAttachments: 2 });
    expect(screen.getByTestId(FLAGGED_ID)).toHaveTextContent(
      flaggedWithoutAttachmentsCopy(2),
    );
    expect(screen.queryByTestId(FAILED_ID)).toBeNull();
  });

  it("success + flaggedWithoutAttachments=1 -> singular", () => {
    renderModal({ progress: COMPLETE, flaggedWithoutAttachments: 1 });
    expect(screen.getByTestId(FLAGGED_ID)).toHaveTextContent(
      flaggedWithoutAttachmentsCopy(1),
    );
  });

  it("success with both counts 0 -> no line", () => {
    renderModal({ progress: COMPLETE, attachmentsFailed: 0, flaggedWithoutAttachments: 0 });
    expect(screen.queryByTestId(FAILED_ID)).toBeNull();
    expect(screen.queryByTestId(FLAGGED_ID)).toBeNull();
  });

  it("success with neither prop passed -> no line", () => {
    renderModal({ progress: COMPLETE });
    expect(screen.queryByTestId(FAILED_ID)).toBeNull();
    expect(screen.queryByTestId(FLAGGED_ID)).toBeNull();
  });

  it("a failed submit never shows either line, even with stale counts", () => {
    renderModal({
      progress: FAILED,
      error: "boom",
      attachmentsFailed: 2,
      flaggedWithoutAttachments: 2,
    });
    expect(screen.queryByTestId(FAILED_ID)).toBeNull();
    expect(screen.queryByTestId(FLAGGED_ID)).toBeNull();
  });

  it("with the checklists line: all three render, checklists -> uploads -> not included, then the export ask", () => {
    renderModal({
      progress: COMPLETE,
      checklistsNotSent: "refused",
      attachmentsFailed: 2,
      flaggedWithoutAttachments: 4,
    });
    const lines = screen.getAllByRole("status").map((el) => el.textContent);
    expect(lines).toEqual([
      CHECKLISTS_NOT_SENT_COPY.refused,
      attachmentsFailedCopy(2),
      flaggedWithoutAttachmentsCopy(4),
    ]);
    const flagged = screen.getByTestId(FLAGGED_ID);
    const ask = screen.getByTestId("submit-review-success-ask");
    expect(
      flagged.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId(CHECKLISTS_ID)).toBeInTheDocument();
  });
});

describe("BACKLOG-3399 — useSubmitForReview holds both counts from the IPC result", () => {
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
  ])(
    "isResubmit=%s: success carries them; absent fields read 0; failure and reset clear them",
    async (isResubmit, api) => {
      const { result } = renderHook(() =>
        useSubmitForReview({ transactionId: "txn-3399", isResubmit }),
      );
      expect(result.current.attachmentsFailed).toBe(0);
      expect(result.current.flaggedWithoutAttachments).toBe(0);

      api.mockResolvedValueOnce({
        success: true,
        submissionId: "s-1",
        attachmentsFailed: 2,
        flaggedWithoutAttachments: 1,
      });
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.attachmentsFailed).toBe(2);
      expect(result.current.flaggedWithoutAttachments).toBe(1);

      // A success whose result omits both fields must read 0, not keep the
      // previous run's counts and not become undefined/NaN.
      api.mockResolvedValueOnce({ success: true, submissionId: "s-2" });
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.attachmentsFailed).toBe(0);
      expect(result.current.flaggedWithoutAttachments).toBe(0);

      api.mockResolvedValueOnce({
        success: true,
        submissionId: "s-3",
        attachmentsFailed: 5,
        flaggedWithoutAttachments: 3,
      });
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.attachmentsFailed).toBe(5);

      api.mockResolvedValueOnce({ success: false, error: "no" });
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.attachmentsFailed).toBe(0);
      expect(result.current.flaggedWithoutAttachments).toBe(0);

      api.mockResolvedValueOnce({
        success: true,
        submissionId: "s-4",
        attachmentsFailed: 1,
        flaggedWithoutAttachments: 1,
      });
      await act(async () => {
        await result.current.submit();
      });
      expect(result.current.flaggedWithoutAttachments).toBe(1);
      act(() => result.current.reset());
      expect(result.current.attachmentsFailed).toBe(0);
      expect(result.current.flaggedWithoutAttachments).toBe(0);

      expect(api).toHaveBeenCalledTimes(5);
    },
  );
});
