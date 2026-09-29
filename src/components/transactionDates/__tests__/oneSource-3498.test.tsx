/**
 * BACKLOG-3498 — ONE date step and ONE writer, used by both routes.
 *
 * Export (individual) and Submit (brokerage) both ask the agent to confirm the
 * transaction's dates. They must render the SAME fields component and save
 * through the SAME writer — by identity, not by matching text or payload:
 *
 *  - C1c: a copy of the fields pasted into SubmitForReviewModal would render
 *    identical labels and pass any text-parity check. Here the shared component
 *    is wrapped in a spy, so only a render of THAT component counts.
 *  - C1d: a second inline writer of `closing_date_verified: 1` would send the
 *    identical payload and pass the payload controls. Here the shared writer is
 *    mocked, so a press that reaches `window.api.transactions.update` directly
 *    — instead of through the writer — shows up as a direct call.
 *
 * RUNNER: npx jest src/components/transactionDates/__tests__/oneSource-3498.test.tsx
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Transaction } from "@/types";

jest.mock("../TransactionDatesFields", () => {
  const actual = jest.requireActual("../TransactionDatesFields");
  return { ...actual, TransactionDatesFields: jest.fn(actual.TransactionDatesFields) };
});
jest.mock("../saveConfirmedTransactionDates", () => ({
  saveConfirmedTransactionDates: jest.fn(),
}));

import { TransactionDatesFields } from "../TransactionDatesFields";
import { saveConfirmedTransactionDates } from "../saveConfirmedTransactionDates";
import ExportModal from "../../ExportModal";
import { SubmitForReviewModal } from "../../transactionDetailsModule/components/modals/SubmitForReviewModal";

const fieldsSpy = TransactionDatesFields as unknown as jest.Mock;
const writerMock = saveConfirmedTransactionDates as jest.Mock;
const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "txn-3498-one";
/** Date-only start (wizard) and an ISO-timestamp end (detection path). */
const transaction = {
  id: TX,
  user_id: "user-3498",
  status: "active",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

const CONFIRMED = { startDate: "2026-01-05", closingDate: "", endDate: "2026-03-14" };

beforeEach(() => {
  jest.clearAllMocks();
  writerMock.mockResolvedValue({ success: true });
  updateMock.mockResolvedValue({ success: true });
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
});

function renderExport() {
  return render(
    <ExportModal transaction={transaction} userId="user-3498" onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
}

function renderSubmit(onSubmit = jest.fn()) {
  render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={4}
      textThreadCount={2}
      attachmentCount={3}
      emailAttachmentCount={1}
      totalSizeBytes={2048}
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

describe("BACKLOG-3498 C1c — both routes render the one shared fields component", () => {
  it("Export Step 1 renders it", async () => {
    renderExport();
    expect(await screen.findByText("Verify Transaction Details")).toBeInTheDocument();
    expect(fieldsSpy).toHaveBeenCalled();
  });

  it("the Submit date step renders it", () => {
    renderSubmit();
    // BACKLOG-3498 (e): on this screen the text is the dialog's title (the
    // block's heading is hidden), so the field labels are the anchor that the
    // block rendered.
    expect(screen.getByText("Verify Transaction Details")).toBeInTheDocument();
    expect(screen.getByText("Start Date *")).toBeInTheDocument();
    expect(fieldsSpy).toHaveBeenCalled();
  });
});

describe("BACKLOG-3498 C1d — both presses save through the one shared writer", () => {
  it("the Export press calls the writer, and nothing else writes the dates", async () => {
    renderExport();
    const next = await screen.findAllByRole("button", { name: /next/i });
    await click(next[0]);
    const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
    await click(exportButtons[0]);

    expect(writerMock).toHaveBeenCalledTimes(1);
    expect(writerMock).toHaveBeenCalledWith(TX, CONFIRMED);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("the Submit press calls the writer, and nothing else writes the dates", async () => {
    const { onSubmit } = renderSubmit();
    await click(screen.getByTestId("submit-review-next"));
    await click(screen.getByTestId("submit-review-submit"));

    expect(writerMock).toHaveBeenCalledTimes(1);
    expect(writerMock).toHaveBeenCalledWith(TX, CONFIRMED);
    expect(updateMock).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
