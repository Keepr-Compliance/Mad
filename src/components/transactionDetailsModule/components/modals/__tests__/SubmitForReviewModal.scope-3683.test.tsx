/**
 * BACKLOG-3683 (founder decision B, narrowed 2026-10-05) — the submit summary
 * counts only what the dates on the date step include. There is no
 * out-of-window notice: the founder removed it ("i don't think we need this
 * msg just remove it") because it counted every item ever linked through the
 * deal's contacts, ignoring the chat/email selection, and read as noise.
 *
 * C1 — the preview converts the dates with `confirmedDatesUpdate`, the same
 *      function the date save uses (SR condition d0e108ff). The module is
 *      wrapped so the test can make that function return a sentinel; a preview
 *      that converts the dates itself never sees it.
 */
import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Transaction } from "@/types";

jest.mock("../../../../transactionDates/saveConfirmedTransactionDates", () => {
  const actual = jest.requireActual("../../../../transactionDates/saveConfirmedTransactionDates");
  return {
    ...actual,
    confirmedDatesUpdate: jest.fn(actual.confirmedDatesUpdate),
  };
});

import { confirmedDatesUpdate } from "../../../../transactionDates/saveConfirmedTransactionDates";
import { SubmitForReviewModal } from "../SubmitForReviewModal";

const TX = "txn-3683";
const transaction = {
  id: TX,
  user_id: "user-3683",
  status: "active",
  property_address: "7 Fixture Row",
  transaction_type: "purchase",
  started_at: "2026-09-01",
  closed_at: "2026-09-27",
} as unknown as Transaction;

const updateMock = window.api.transactions.update as jest.Mock;
const scopeMock = jest.fn();
const convertMock = confirmedDatesUpdate as jest.Mock;

const READY = {
  success: true,
  inWindow: { emails: 3, texts: 9, textThreads: 2, attachments: 4, emailAttachments: 1, attachmentBytes: 4096 },
};

beforeEach(() => {
  jest.clearAllMocks();
  updateMock.mockResolvedValue({ success: true });
  scopeMock.mockResolvedValue(READY);
  (window.api.transactions as unknown as Record<string, unknown>).getSubmissionScope = scopeMock;
});

function renderSubmit() {
  const onSubmit = jest.fn();
  render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={5}
      textThreadCount={3}
      attachmentCount={6}
      emailAttachmentCount={2}
      totalSizeBytes={8192}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={onSubmit}
      onExport={jest.fn()}
    />,
  );
  return { onSubmit };
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe("BACKLOG-3683 — the summary counts what the dates include", () => {
  it("shows in-window counts, never the all-linked totals passed in", async () => {
    renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    await waitFor(() => expect(screen.getByTestId("submit-review-email-count")).toHaveTextContent("3"));
    expect(screen.getByTestId("submit-review-email-count")).toHaveTextContent("3 (1 attachment)");
    expect(screen.getByTestId("submit-review-text-thread-count")).toHaveTextContent("2");
    expect(screen.getByTestId("submit-review-attachment-count")).toHaveTextContent("4 files");
  });

  /**
   * Founder decision 2026-10-05: no out-of-window notice, ever — regardless
   * of how the scope answer is shaped. Guards against the amber block (and
   * its "and N more" line) coming back.
   */
  it("never shows an out-of-window notice", async () => {
    renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    await waitFor(() => expect(screen.getByTestId("submit-review-email-count")).toHaveTextContent("3"));
    expect(screen.queryByTestId("submit-review-out-of-window")).toBeNull();
    expect(screen.queryByTestId("submit-review-out-of-window-more")).toBeNull();
    expect(screen.queryByText(/won't be sent/)).toBeNull();
  });

  it("a failed count does not fall back to the all-linked totals", async () => {
    scopeMock.mockResolvedValue({ success: false, error: "boom" });
    renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    await screen.findByTestId("submit-review-scope-failed");
    expect(screen.getByTestId("submit-review-email-count")).not.toHaveTextContent("5");
    expect(screen.getByTestId("submit-review-submit")).not.toBeDisabled();
  });

  it("asks with the dates the save will write", async () => {
    renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    await click(screen.getByTestId("submit-review-submit"));
    expect(scopeMock).toHaveBeenCalledTimes(1);
    const [txId, candidate] = scopeMock.mock.calls[0];
    expect(txId).toBe(TX);
    const saved = updateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(candidate).toEqual({ started_at: saved.started_at, closed_at: saved.closed_at });
  });

  /**
   * C1. MUTATION: build `{started_at: dates.startDate, closed_at: dates.endDate}`
   * in the hook instead of calling `confirmedDatesUpdate` → the sentinel never
   * arrives → red.
   */
  it("C1: the preview converts the dates with the save's own function", async () => {
    convertMock.mockImplementationOnce(() => ({
      started_at: "SENTINEL-START",
      closing_deadline: null,
      closed_at: "SENTINEL-END",
      closing_date_verified: 1,
    }));
    renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    expect(scopeMock).toHaveBeenCalledWith(TX, { started_at: "SENTINEL-START", closed_at: "SENTINEL-END" });
  });
});
