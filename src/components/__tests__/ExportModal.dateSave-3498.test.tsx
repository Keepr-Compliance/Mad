/**
 * BACKLOG-3498 — Export's date save, pinned before it moves.
 *
 * ExportModal Step 1 ("Verify Transaction Dates") is about to be extracted into
 * a shared module that the Submit dialog also uses. Before this file, nothing
 * watched Export's date save: deleting `closing_date_verified: 1`, skipping the
 * `transactionService.update` call, or letting End equal Start fail left every
 * Export suite green (Step 0 mutations A2a / A2b / A1v, 0 of 15 red). An
 * extraction that changed the payload would have shipped unseen.
 *
 * So this file is written against the UNEXTRACTED ExportModal and must stay
 * green, unedited, across the extraction commit.
 *
 * FIXTURE PROVENANCE — the two date shapes the row can hold today:
 *  - `started_at: "2026-01-05"` — date-only, as the new-transaction wizard and
 *    the audit edit write it (useAuditSubmission.ts:140-142).
 *  - `closed_at: "2026-03-14T18:22:05.000Z"` — a full ISO timestamp, as the
 *    detection path writes it: `closed_at: toISOString(detected.dateRange?.end)`
 *    (electron/services/transactionService/transactionService.ts:958, helper at
 *    :930-936 returns `Date#toISOString()`).
 *  - `closing_deadline` absent — no producer sets it on detection.
 * The expected payload is transcribed from ExportModal.handleExport as it stands
 * at develop 5177d9bed (ExportModal.tsx:323-328).
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "tx-3498-export";
const transaction = {
  id: TX,
  user_id: "user-3498",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

const COMPLETE = {
  success: true,
  complete: true,
  needsMessagesImport: false,
  messagesImporterAvailable: true,
  auditStartISO: "2026-01-05T00:00:00.000Z",
  messagesFloorISO: "2025-01-01T00:00:00.000Z",
  expansionStale: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  completenessMock.mockResolvedValue(COMPLETE);
  getStatusMock.mockResolvedValue({
    localTransactionId: TX,
    status: "unlocked",
    fromCache: false,
  });
});

function renderModal() {
  return render(
    <ExportModal
      transaction={transaction}
      userId="user-3498"
      onClose={jest.fn()}
      onExportComplete={jest.fn()}
    />,
  );
}

/** [Start Date, Closing Date, End Date], in the order Step 1 renders them. */
function dateInputs(container: HTMLElement): HTMLInputElement[] {
  const inputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
  );
  expect(inputs).toHaveLength(3);
  return inputs;
}

function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

async function pressNext(): Promise<void> {
  const next = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(next[0]);
  });
}

async function pressExport(): Promise<void> {
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

describe("BACKLOG-3498 — Export saves the confirmed dates", () => {
  it("saves the prefill exactly: ISO closed_at as its date part, empty Closing Date as null", async () => {
    renderModal();
    await pressNext();
    await pressExport();

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]).toEqual([
      TX,
      {
        started_at: "2026-01-05",
        closing_deadline: null,
        closed_at: "2026-03-14",
        closing_date_verified: 1,
      },
    ]);
  });

  it("saves what was typed, not the prefill", async () => {
    const { container } = renderModal();
    const [start, closing, end] = dateInputs(container);
    type(start, "2026-02-02");
    type(closing, "2026-04-20");
    type(end, "2026-04-25");

    await pressNext();
    await pressExport();

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]).toEqual([
      TX,
      {
        started_at: "2026-02-02",
        closing_deadline: "2026-04-20",
        closed_at: "2026-04-25",
        closing_date_verified: 1,
      },
    ]);
  });

  it("saves BEFORE the completeness check, so the check reads the confirmed window", async () => {
    renderModal();
    await pressNext();
    await pressExport();

    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(completenessMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.invocationCallOrder[0]).toBeLessThan(
      completenessMock.mock.invocationCallOrder[0],
    );
  });

  it("a failed save returns to the date step with the error, and exports nothing", async () => {
    updateMock.mockResolvedValue({ success: false, error: "disk full" });
    const { container } = renderModal();
    await pressNext();
    await pressExport();

    expect(await screen.findByText("Failed to save dates: disk full")).toBeInTheDocument();
    // Back on Step 1, with the fields still editable.
    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(dateInputs(container)).toHaveLength(3);
    expect(completenessMock).not.toHaveBeenCalled();
    expect(exportEnhancedMock).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3498 — Export's End-before-Start rule, at the boundary", () => {
  it("accepts End Date EQUAL to Start Date (the rule is 'not before', not 'after')", async () => {
    const { container } = renderModal();
    const [start, , end] = dateInputs(container);
    type(start, "2026-03-10");
    type(end, "2026-03-10");

    await pressNext();

    expect(await screen.findByText("Export Options")).toBeInTheDocument();
    expect(screen.queryByText("End Date must be after Start Date")).not.toBeInTheDocument();
  });

  it.each([
    ["one day before, mid-month", "2026-03-10", "2026-03-09"],
    ["across a month boundary", "2026-02-01", "2026-01-31"],
    ["across a year boundary", "2026-01-01", "2025-12-31"],
  ])("refuses End Date %s Start Date and stays on the date step", async (_label, startValue, endValue) => {
    const { container } = renderModal();
    const [start, , end] = dateInputs(container);
    type(start, startValue);
    type(end, endValue);

    await pressNext();

    expect(await screen.findByText("End Date must be after Start Date")).toBeInTheDocument();
    expect(screen.getByText("Verify Transaction Dates")).toBeInTheDocument();
    expect(screen.queryByText("Export Options")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
