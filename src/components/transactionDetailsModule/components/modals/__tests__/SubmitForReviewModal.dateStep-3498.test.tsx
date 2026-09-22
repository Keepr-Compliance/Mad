/**
 * BACKLOG-3498 — a brokerage agent confirms the transaction's dates before
 * submitting, the same way an individual does before exporting.
 *
 * The dialog now has two screens for a deal that can still be submitted (no
 * status, `not_submitted`, `needs_changes`): the shared "Verify Transaction
 * Dates" step, then Next → the lead and Submission Summary (with Back) →
 * Submit. Pressing Submit saves the dates through the shared writer, waits for
 * the save, and only then calls `onSubmit`. Blocked statuses keep their single
 * screen.
 *
 * WHY THE SAVE MUST BE AWAITED: the submission reads its audit period from the
 * stored row (submissionService loadTransaction → getTransactionById), not from
 * anything this dialog holds. `useSubmitForReview` sends only the id.
 *
 * FIXTURE PROVENANCE — the two date shapes the row holds today:
 *  - `started_at: "2026-01-05"` — date-only, as the wizard / audit edit write it
 *    (useAuditSubmission.ts:140-142).
 *  - `closed_at: "2026-03-14T18:22:05.000Z"` — a full ISO timestamp, as the
 *    detection path writes it (electron/services/transactionService/
 *    transactionService.ts:958, `toISOString(detected.dateRange?.end)`).
 * `submission_status` values are the `SubmissionStatus` union
 * (electron/types/models.ts); the blocked set is imported from the service's
 * canonical list, as blockedStatusCopy-2868 does. The confidence chips have no
 * producer in the repo, so nothing here asserts on them.
 *
 * RUNNER: npx jest src/components/transactionDetailsModule/components/modals/__tests__/SubmitForReviewModal.dateStep-3498.test.tsx
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import type { SubmitProgress } from "../SubmitForReviewModal";
import { BLOCKED_SUBMISSION_STATUSES } from "../../../../../../electron/services/submissionStatusMessages";
import type { Transaction } from "@/types";

const updateMock = window.api.transactions.update as jest.Mock;

const TX = "txn-3498";

const datedTransaction = {
  id: TX,
  user_id: "user-3498",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

/** The payload the prefill above saves: date parts, empty Closing Date as null. */
const PREFILL_PAYLOAD = {
  started_at: "2026-01-05",
  closing_deadline: null,
  closed_at: "2026-03-14",
  closing_date_verified: 1,
};

const FAILED: SubmitProgress = {
  stage: "failed",
  stageProgress: 0,
  overallProgress: 0,
  currentItem: "Network unreachable",
};

type ModalProps = React.ComponentProps<typeof SubmitForReviewModal>;

function baseProps(overrides: Partial<ModalProps> = {}): ModalProps {
  return {
    transaction: datedTransaction,
    emailCount: 4,
    textThreadCount: 2,
    attachmentCount: 3,
    emailAttachmentCount: 1,
    totalSizeBytes: 2048,
    isSubmitting: false,
    progress: null,
    error: null,
    onCancel: jest.fn(),
    onSubmit: jest.fn(),
    onExport: jest.fn(),
    onDatesSaved: jest.fn(),
    ...overrides,
  };
}

function renderModal(overrides: Partial<ModalProps> = {}) {
  const props = baseProps(overrides);
  const utils = render(<SubmitForReviewModal {...props} />);
  return { ...utils, props };
}

function withStatus(status: string | undefined): Transaction {
  return (
    status === undefined
      ? datedTransaction
      : { ...datedTransaction, submission_status: status }
  ) as Transaction;
}

/** [Start Date, Closing Date, End Date], in render order. */
function dateInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
}

function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

async function press(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  updateMock.mockResolvedValue({ success: true });
});

describe("BACKLOG-3498 C1a — the date step comes first for a deal that can be submitted", () => {
  test.each([
    ["no status", undefined],
    ["not_submitted", "not_submitted"],
    ["needs_changes", "needs_changes"],
  ])("at %s: Export Step 1's fields, labels and helper text, and no summary yet", (_label, status) => {
    renderModal({ transaction: withStatus(status) });

    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Communications will be filtered to only include those between Start Date and End Date.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Start Date *")).toBeInTheDocument();
    expect(screen.getByText("Closing Date")).toBeInTheDocument();
    expect(screen.getByText("End Date *")).toBeInTheDocument();
    expect(
      screen.getByText("When did you sign the representation agreement with the client?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Scheduled closing date (optional)")).toBeInTheDocument();
    expect(
      screen.getByText("When did the transaction end? (Used to filter communications)"),
    ).toBeInTheDocument();

    // Prefilled from the row, timestamps cut to their date part.
    expect(dateInputs().map((i) => i.value)).toEqual(["2026-01-05", "", "2026-03-14"]);

    // Screen 1 is the date step ONLY: no summary, no lead, no Submit.
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit-review-lead")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit-review-submit")).not.toBeInTheDocument();
    expect(screen.getByTestId("submit-review-next")).toBeEnabled();
  });

  it("Next leads to the lead and the Submission Summary, which no longer show the date fields", async () => {
    renderModal();
    await press("submit-review-next");

    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
    expect(screen.getByTestId("submit-review-lead")).toHaveTextContent(
      "You are about to submit this transaction for broker review. The following data will be sent to your broker:",
    );
    expect(screen.getByTestId("submit-review-submit")).toBeEnabled();
    expect(dateInputs()).toHaveLength(0);
    expect(screen.queryByText("Verify Transaction Dates")).not.toBeInTheDocument();
  });

  it("Back returns to the date step with what was typed, and saves nothing", async () => {
    renderModal();
    type(dateInputs()[0], "2026-02-02");
    await press("submit-review-next");
    await press("submit-review-back");

    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(dateInputs().map((i) => i.value)).toEqual(["2026-02-02", "", "2026-03-14"]);
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3498 C1b — the date step enforces Export's rule", () => {
  it("Next is disabled until both Start Date and End Date are filled", () => {
    renderModal({
      transaction: { ...datedTransaction, started_at: undefined, closed_at: undefined } as unknown as Transaction,
    });
    const [start, , end] = dateInputs();

    expect(screen.getByTestId("submit-review-next")).toBeDisabled();
    type(start, "2026-01-05");
    expect(screen.getByTestId("submit-review-next")).toBeDisabled();
    type(start, "");
    type(end, "2026-03-14");
    expect(screen.getByTestId("submit-review-next")).toBeDisabled();
    type(start, "2026-01-05");
    expect(screen.getByTestId("submit-review-next")).toBeEnabled();
  });

  it.each([
    ["one day before, mid-month", "2026-03-10", "2026-03-09"],
    ["across a month boundary", "2026-02-01", "2026-01-31"],
    ["across a year boundary", "2026-01-01", "2025-12-31"],
  ])("refuses End Date %s Start Date and stays on the date step", async (_label, startValue, endValue) => {
    renderModal();
    const [start, , end] = dateInputs();
    type(start, startValue);
    type(end, endValue);

    await press("submit-review-next");

    expect(screen.getByTestId("submit-review-dates-error")).toHaveTextContent(
      "End Date must be after Start Date",
    );
    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
  });

  it("accepts End Date EQUAL to Start Date", async () => {
    renderModal();
    const [start, , end] = dateInputs();
    type(start, "2026-03-10");
    type(end, "2026-03-10");

    await press("submit-review-next");

    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
    expect(screen.queryByTestId("submit-review-dates-error")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3498 C2 — Submit saves the confirmed dates first", () => {
  it("C2a: saves the TYPED dates with Export's exact payload, then submits", async () => {
    const { props } = renderModal();
    const [start, closing, end] = dateInputs();
    // Every value differs from the prefill, so a save built from the row
    // instead of the form fails here.
    type(start, "2026-02-02");
    type(closing, "2026-04-20");
    type(end, "2026-04-25");

    await press("submit-review-next");
    await press("submit-review-submit");

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]).toEqual([
      TX,
      {
        started_at: "2026-02-02",
        closing_deadline: "2026-04-20",
        closed_at: "2026-04-25",
        closing_date_verified: 1,
      },
    ]);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.invocationCallOrder[0]).toBeLessThan(
      (props.onSubmit as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("C2b: does not submit while the save is pending; submits once when it lands", async () => {
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValue(save.promise);
    const { props } = renderModal();

    await press("submit-review-next");
    await press("submit-review-submit");

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onDatesSaved).not.toHaveBeenCalled();

    await act(async () => {
      save.resolve({ success: true });
    });

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("tells the parent the dates were saved, before it submits", async () => {
    const { props } = renderModal();
    await press("submit-review-next");
    await press("submit-review-submit");

    expect(props.onDatesSaved).toHaveBeenCalledTimes(1);
    expect((props.onDatesSaved as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (props.onSubmit as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("C2c: a failed save returns to the date step with the error, and does not submit", async () => {
    updateMock.mockResolvedValue({ success: false, error: "disk full" });
    const { props } = renderModal();

    await press("submit-review-next");
    await press("submit-review-submit");

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onDatesSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId("submit-review-dates-error")).toHaveTextContent(
      "Failed to save dates: disk full",
    );
    // On the date step, fields still editable — not under a submission failure.
    expect(dateInputs()).toHaveLength(3);
    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(screen.queryByText("Submission Failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
  });

  it("C2c: a failed save on a RETRY after a failed submit shows the date step, not the stale 'Submission Failed'", async () => {
    const props = baseProps();
    const { rerender } = render(<SubmitForReviewModal {...props} />);
    await press("submit-review-next");
    await press("submit-review-submit");
    expect(props.onSubmit).toHaveBeenCalledTimes(1);

    // What useSubmitForReview leaves behind after the submit fails.
    rerender(<SubmitForReviewModal {...props} progress={FAILED} error="Network unreachable" />);
    expect(screen.getByText("Submission Failed")).toBeInTheDocument();

    // Retry, and this time the date save fails.
    updateMock.mockResolvedValue({ success: false, error: "disk full" });
    await press("submit-review-submit");

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("submit-review-dates-error")).toHaveTextContent(
      "Failed to save dates: disk full",
    );
    expect(dateInputs()).toHaveLength(3);
    expect(screen.queryByText("Submission Failed")).not.toBeInTheDocument();
  });

  it("C2d: Next then close saves nothing and submits nothing", async () => {
    const { props } = renderModal();
    await press("submit-review-next");
    await press("submit-review-close");

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("C2e: a second press while the save is pending does not save or submit twice", async () => {
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValue(save.promise);
    const { props } = renderModal();

    await press("submit-review-next");
    await press("submit-review-submit");
    expect(screen.getByTestId("submit-review-submit")).toBeDisabled();
    await press("submit-review-submit");

    await act(async () => {
      save.resolve({ success: true });
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("C2f: closing with the X while the save is pending does not submit", async () => {
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValue(save.promise);
    const { props } = renderModal();

    await press("submit-review-next");
    await press("submit-review-submit");
    await press("submit-review-close");
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      save.resolve({ success: true });
    });

    expect(props.onSubmit).not.toHaveBeenCalled();
    // The save did land, so the parent still re-reads the row.
    expect(props.onDatesSaved).toHaveBeenCalledTimes(1);
  });

  it("C2f: unmounting while the save is pending does not submit", async () => {
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValue(save.promise);
    const { props, unmount } = renderModal();

    await press("submit-review-next");
    await press("submit-review-submit");
    unmount();

    await act(async () => {
      save.resolve({ success: true });
    });

    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3498 C3 — which statuses get the date step", () => {
  const ALL_STATUSES: Array<string | undefined> = [
    undefined,
    "not_submitted",
    "submitted",
    "under_review",
    "needs_changes",
    "resubmitted",
    "approved",
    "rejected",
  ];
  const BLOCKED = new Set<string>(BLOCKED_SUBMISSION_STATUSES);

  test.each(ALL_STATUSES.map((s) => [String(s), s]))(
    "C3a: at %s the date step shows if and only if the status is not blocked",
    (_label, status) => {
      renderModal({ transaction: withStatus(status) });
      const blocked = status !== undefined && BLOCKED.has(status);

      if (blocked) {
        expect(dateInputs()).toHaveLength(0);
        expect(screen.queryByText("Verify Transaction Dates")).not.toBeInTheDocument();
        expect(screen.queryByTestId("submit-review-next")).not.toBeInTheDocument();
        // The blocked screen is today's screen: lead + summary, and no Back.
        expect(screen.getByTestId("submit-review-lead")).toBeInTheDocument();
        expect(screen.getByText("Submission Summary")).toBeInTheDocument();
        expect(screen.queryByTestId("submit-review-back")).not.toBeInTheDocument();
      } else {
        expect(dateInputs()).toHaveLength(3);
        expect(screen.getByTestId("submit-review-next")).toBeInTheDocument();
      }
    },
  );

  it("C3a: the blocked set this suite uses is the service's five statuses", () => {
    expect(BLOCKED).toEqual(
      new Set(["submitted", "under_review", "resubmitted", "approved", "rejected"]),
    );
  });

  it("C3b: a needs_changes deal is prefilled from the row and resubmits the confirmed dates", async () => {
    const { props } = renderModal({ transaction: withStatus("needs_changes") });

    expect(dateInputs().map((i) => i.value)).toEqual(["2026-01-05", "", "2026-03-14"]);
    await press("submit-review-next");
    expect(screen.getByTestId("submit-review-submit")).toHaveTextContent("Resubmit");
    await press("submit-review-submit");

    expect(updateMock.mock.calls[0]).toEqual([TX, PREFILL_PAYLOAD]);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.invocationCallOrder[0]).toBeLessThan(
      (props.onSubmit as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});

describe("BACKLOG-3498 C4 — Export PDF stays on both screens", () => {
  it("on the date step it is present and exports without saving or submitting", async () => {
    const { props } = renderModal();
    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();

    await press("submit-review-export");

    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("on the summary screen it is present and exports without saving or submitting", async () => {
    const { props } = renderModal();
    await press("submit-review-next");
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();

    await press("submit-review-export");

    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
