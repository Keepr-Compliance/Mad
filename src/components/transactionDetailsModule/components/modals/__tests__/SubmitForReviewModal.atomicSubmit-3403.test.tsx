/**
 * BACKLOG-3403 / 3398 / 3681 — the renderer half of all-or-nothing submit.
 *
 *   useSubmitForReview  asks the pre-flight first; lists → waits for the
 *                       agent; Continue sends the confirmed keys; a cancel is
 *                       its own outcome (no error toast); a changed list asks
 *                       again.
 *   SubmitForReviewModal shows the list BEFORE sending (Go back / Continue
 *                       anyway) and AFTER (one line per message), the real
 *                       cancel confirm, and no Cancel during the final step.
 *
 * IPC shapes are the handler's (`toSubmitResponse` in
 * transactionExportHandlers.ts) and `transactions:submit-preflight`.
 */
import React from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  NOT_INCLUDED_HEADING_AFTER,
  NOT_INCLUDED_HEADING_BEFORE,
  SUBMISSION_CANCELLED_COPY,
  SubmitForReviewModal,
  notIncludedLine,
  notIncludedReasonText,
  notIncludedSource,
  type NotIncludedItem,
  type SubmitProgress,
} from "../SubmitForReviewModal";
import { useSubmitForReview } from "../../../hooks/useSubmitForReview";
import type { Transaction } from "@/types";

const transaction = {
  id: "txn-3403",
  user_id: "user-3403",
  property_address: "7 Orchard Row",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

const ITEMS: NotIncludedItem[] = [
  { key: "msg:m1", kind: "text", localMessageId: "m1", threadId: "chat-1", sentAt: "2026-09-24T15:00:00.000Z", label: "Jane Doe", filename: null, reason: "text_attachment_not_on_this_computer", localAttachmentId: null },
  { key: "att:a1", kind: "email", localMessageId: "e1", threadId: "thread-e1", sentAt: "2026-10-02T15:00:00.000Z", label: "Inspection report", filename: "Contract.pdf", reason: "email_attachment_not_downloaded", localAttachmentId: "a1" },
  { key: "att:a2", kind: "email", localMessageId: "e2", threadId: "thread-e2", sentAt: "2026-10-03T15:00:00.000Z", label: "Offer", filename: "Offer.pdf", reason: "file_missing_on_this_computer", localAttachmentId: "a2" },
  { key: "att:a3", kind: "email", localMessageId: "e3", threadId: "thread-e3", sentAt: "2026-10-03T15:00:00.000Z", label: "Photos", filename: "Video.mov", reason: "file_too_large", localAttachmentId: "a3" },
];

const UPLOADING: SubmitProgress = { stage: "attachments", stageProgress: 10, overallProgress: 20 };
const FINALIZING: SubmitProgress = { stage: "finalizing", stageProgress: 0, overallProgress: 90 };
const COMPLETE: SubmitProgress = { stage: "complete", stageProgress: 100, overallProgress: 100 };

function renderModal(overrides: Partial<React.ComponentProps<typeof SubmitForReviewModal>> = {}) {
  const props = {
    onCancel: jest.fn(),
    onSubmit: jest.fn(),
    onPreflightBack: jest.fn(),
    onPreflightContinue: jest.fn(),
    onCancelSubmit: jest.fn(),
    ...overrides,
  };
  render(
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
      {...props}
    />,
  );
  return props;
}

describe("BACKLOG-3681 — one line per message, which file, why", () => {
  it("every reason reads as its own sentence", () => {
    expect(ITEMS.map(notIncludedLine)).toEqual([
      "Text with Jane Doe, Sep 24 — Keepr doesn't have a copy of a photo or file from this text.",
      'Email "Inspection report", Oct 2 — Contract.pdf couldn\'t be downloaded from the mailbox.',
      'Email "Offer", Oct 3 — Offer.pdf is no longer on this computer.',
      'Email "Photos", Oct 3 — Video.mov is larger than 50 MB.',
    ]);
  });

  it("the success screen lists them under one heading", () => {
    renderModal({ progress: COMPLETE, notIncluded: ITEMS });
    const block = screen.getByTestId("submit-review-not-included");
    expect(block).toHaveTextContent(NOT_INCLUDED_HEADING_AFTER);
    // BACKLOG-3731: grouped by conversation — the source heads its group.
    for (const item of ITEMS) {
      expect(block).toHaveTextContent(notIncludedSource(item));
      expect(block).toHaveTextContent(notIncludedReasonText(item));
    }
  });

  it("nothing left out → no block; a failed submit never shows one", () => {
    renderModal({ progress: COMPLETE, notIncluded: [] });
    expect(screen.queryByTestId("submit-review-not-included")).toBeNull();
  });
});

describe("BACKLOG-3403 — the pre-flight question, before anything is sent", () => {
  it("lists the files with Go back / Continue anyway, and hides Submit", () => {
    const props = renderModal({ preflightItems: ITEMS.slice(0, 2) });
    const block = screen.getByTestId("submit-review-preflight");
    expect(block).toHaveTextContent(NOT_INCLUDED_HEADING_BEFORE);
    expect(screen.queryByTestId("submit-review-submit")).toBeNull();
    fireEvent.click(screen.getByTestId("submit-review-preflight-continue"));
    expect(props.onPreflightContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("submit-review-preflight-back"));
    expect(props.onPreflightBack).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("a changed list says so", () => {
    renderModal({ preflightItems: ITEMS, preflightChanged: true });
    expect(screen.getByTestId("submit-review-preflight-changed")).toBeInTheDocument();
  });
});

describe("BACKLOG-3398 — Cancel really cancels", () => {
  it("the confirm calls the real cancel, not a bare close", () => {
    const props = renderModal({ isSubmitting: true, progress: UPLOADING });
    fireEvent.click(screen.getByTestId("submit-review-close"));
    expect(screen.getByText("Cancel this submission? Nothing will be sent to your broker.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("submit-review-cancel-confirm"));
    expect(props.onCancelSubmit).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("during the final step there is no Cancel: the X does nothing", () => {
    const props = renderModal({ isSubmitting: true, progress: FINALIZING });
    fireEvent.click(screen.getByTestId("submit-review-close"));
    expect(screen.queryByTestId("submit-review-cancel-confirm")).toBeNull();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  /**
   * The race the agent can actually hit: the confirm is open from the upload
   * stage when the final step begins. It must go away — a Cancel pressed now
   * would be refused by the main process anyway.
   * MUTATION: drop `!isFinalizing` from the confirm's render gate → red.
   */
  it("a confirm opened during the upload disappears when the final step begins", () => {
    const onCancelSubmit = jest.fn();
    const base = {
      transaction, emailCount: 1, textThreadCount: 1, attachmentCount: 0, emailAttachmentCount: 0,
      totalSizeBytes: 0, error: null, onCancel: jest.fn(), onSubmit: jest.fn(), onCancelSubmit,
    };
    const { rerender } = render(<SubmitForReviewModal {...base} isSubmitting progress={UPLOADING} />);
    fireEvent.click(screen.getByTestId("submit-review-close"));
    expect(screen.getByTestId("submit-review-cancel-confirm")).toBeInTheDocument();
    rerender(<SubmitForReviewModal {...base} isSubmitting progress={FINALIZING} />);
    expect(screen.queryByTestId("submit-review-cancel-confirm")).toBeNull();
  });

  it("after a cancel: says nothing was sent, offers Done", () => {
    const props = renderModal({ cancelled: true });
    expect(screen.getByTestId("submit-review-cancelled")).toHaveTextContent(SUBMISSION_CANCELLED_COPY);
    fireEvent.click(screen.getByTestId("submit-review-done"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3403 — useSubmitForReview", () => {
  const submit = jest.fn();
  const resubmit = jest.fn();
  const submitPreflight = jest.fn();
  const cancelSubmit = jest.fn();
  beforeEach(() => {
    [submit, resubmit, submitPreflight, cancelSubmit].forEach((f) => f.mockReset());
    (window as unknown as { api: unknown }).api = {
      transactions: { submit, resubmit, submitPreflight, cancelSubmit, onSubmitProgress: () => () => undefined },
    };
  });

  it("nothing to list → sends at once with no confirmed keys", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: [] });
    submit.mockResolvedValue({ success: true, submissionId: "s-1", notIncluded: [] });
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403" }));
    await act(async () => {
      await result.current.submit();
    });
    expect(submit).toHaveBeenCalledWith("txn-3403", { acceptedExclusionKeys: [] });
    expect(result.current.progress?.stage).toBe("complete");
  });

  /**
   * MUTATION: send without waiting for the agent (skip the pre-flight stop)
   * → `submit` is called before Continue → red.
   */
  it("a list → waits; Continue sends exactly the listed keys; the result's list is kept", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: ITEMS });
    submit.mockResolvedValue({ success: true, submissionId: "s-1", notIncluded: ITEMS });
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403", onSuccess }));
    await act(async () => {
      await result.current.submit();
    });
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.preflightItems).toEqual(ITEMS);
    await act(async () => {
      await result.current.confirmPreflight();
    });
    expect(submit).toHaveBeenCalledWith("txn-3403", { acceptedExclusionKeys: ITEMS.map((i) => i.key) });
    expect(result.current.notIncluded).toEqual(ITEMS);
    expect(onSuccess).toHaveBeenCalledWith("s-1");
  });

  it("Go back sends nothing", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: ITEMS });
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403" }));
    await act(async () => {
      await result.current.submit();
    });
    act(() => result.current.dismissPreflight());
    expect(result.current.preflightItems).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  /** MUTATION: treat `cancelled` as a failure → onError fires → red. */
  it("a cancelled result is not an error: no onError, `cancelled` set", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: [] });
    submit.mockResolvedValue({ success: false, cancelled: true, error: SUBMISSION_CANCELLED_COPY });
    const onError = jest.fn();
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403", onError }));
    await act(async () => {
      await result.current.submit();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.cancelled).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("a changed list asks again instead of failing", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: [] });
    submit.mockResolvedValue({ success: false, preflightChanged: true, notIncluded: ITEMS.slice(0, 1), error: "x" });
    const onError = jest.fn();
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403", onError }));
    await act(async () => {
      await result.current.submit();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.preflightItems).toEqual(ITEMS.slice(0, 1));
    expect(result.current.preflightChanged).toBe(true);
  });

  it("cancel() asks the main process; a refusal (final step) leaves it running", async () => {
    cancelSubmit.mockResolvedValueOnce({ success: true, cancelled: false, reason: "finalizing" });
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3403" }));
    let ok = true;
    await act(async () => {
      ok = await result.current.cancel();
    });
    expect(cancelSubmit).toHaveBeenCalledWith("txn-3403");
    expect(ok).toBe(false);
    expect(result.current.isCancelling).toBe(false);
  });
});
