/**
 * BACKLOG-3910 (slice d, founder 2026-10-12): a locked deal is read-only, and
 * the main process refuses `transactions:update` on it. Export still works on
 * a locked deal (approved deals are the ones exported): the date and
 * commission fields are disabled with the lock's tooltip, the confirmed-dates
 * save is skipped, and the "mark as closed?" prompt is not offered. On an open
 * deal the save and the prompt are as before.
 *
 * Harness copied from ExportModal.dateSave-3498.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";
import { DEAL_LOCK_EDIT_TOOLTIP } from "../../utils/dealLock";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "tx-3910d-export";

function txn(submissionStatus: string): Transaction {
  return {
    id: TX,
    user_id: "user-3910d",
    status: "active",
    property_address: "123 Main St",
    started_at: "2026-01-05",
    closed_at: "2026-03-14T18:22:05.000Z",
    submission_status: submissionStatus,
  } as unknown as Transaction;
}

const CASES: Array<[string, "submitted" | "sealed" | null]> = [
  ["not_submitted", null],
  ["submitted", "submitted"],
  ["under_review", "submitted"],
  ["needs_changes", null],
  ["resubmitted", "submitted"],
  ["approved", "sealed"],
  ["rejected", null],
];

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  completenessMock.mockResolvedValue({
    success: true,
    complete: true,
    needsMessagesImport: false,
    messagesImporterAvailable: true,
    auditStartISO: "2026-01-05T00:00:00.000Z",
    messagesFloorISO: "2025-01-01T00:00:00.000Z",
    expansionStale: false,
  });
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
});

async function click(name: RegExp): Promise<void> {
  const buttons = await screen.findAllByRole("button", { name });
  await act(async () => {
    fireEvent.click(buttons[0]);
  });
}

describe("BACKLOG-3910 slice d: Export on a locked deal saves nothing and still exports", () => {
  it.each(CASES)("%s -> %s", async (status, reason) => {
    const onExportComplete = jest.fn();
    const { container } = render(
      <ExportModal
        transaction={txn(status)}
        userId="user-3910d"
        onClose={jest.fn()}
        onExportComplete={onExportComplete}
      />,
    );

    const dateInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(dateInputs).toHaveLength(3);
    for (const input of dateInputs) {
      if (reason) {
        expect(input).toBeDisabled();
        expect(input).toHaveAttribute("title", DEAL_LOCK_EDIT_TOOLTIP[reason]);
      } else {
        expect(input).toBeEnabled();
      }
    }

    // The commission figures save with the dates, so they are locked with them.
    const commissionInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-testid="commission-rates-row"] input'),
    );
    expect(commissionInputs.length).toBeGreaterThan(0);
    for (const input of commissionInputs) {
      if (reason) expect(input).toBeDisabled();
      else expect(input).toBeEnabled();
    }

    await click(/next/i);
    await click(/^export$/i);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));

    if (reason) {
      expect(updateMock).not.toHaveBeenCalled();
    } else {
      expect(updateMock).toHaveBeenCalledTimes(1);
    }

    await click(/^done$/i);
    if (reason === "submitted") {
      expect(screen.queryByText(/mark this transaction as closed/i)).toBeNull();
      expect(onExportComplete).toHaveBeenCalledWith({ success: true, path: "/out/audit" });
    } else {
      // Open deals and approved (sealed) deals can be closed (founder 2026-10-12).
      expect(await screen.findByText(/mark this transaction as closed/i)).toBeInTheDocument();
    }
  });
});

// R1 (SR review, PR 2978): the `transaction` prop can still read "open" after a
// submit on the same screen. Main then refuses the date save. The refusal below
// is transcribed from the handler's refuseIfDealLocked
// (electron/services/dealLockState.ts): { success:false, error, dealLocked, refusedEdit }.
describe("BACKLOG-3910 R1: the prop says open, main says locked", () => {
  const REFUSAL = {
    success: false,
    error: "This deal is with your broker for review, so it can't be changed until it's returned to you.",
    dealLocked: "submitted",
    refusedEdit: "edit-deal-details",
  };

  it("still exports with the saved dates and offers no close prompt", async () => {
    updateMock.mockResolvedValue(REFUSAL);
    const onExportComplete = jest.fn();
    render(
      <ExportModal
        transaction={txn("not_submitted")}
        userId="user-3910d"
        onClose={jest.fn()}
        onExportComplete={onExportComplete}
      />,
    );
    await click(/next/i);
    await click(/^export$/i);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/failed to save dates/i)).toBeNull();
    expect(screen.getByText(/used the dates already saved/i)).toBeInTheDocument();

    await click(/^done$/i);
    expect(screen.queryByText(/mark this transaction as closed/i)).toBeNull();
    expect(onExportComplete).toHaveBeenCalledWith({ success: true, path: "/out/audit" });
  });

  it("a plain save failure (no dealLocked) still stops the export", async () => {
    updateMock.mockResolvedValue({ success: false, error: "disk full" });
    render(
      <ExportModal
        transaction={txn("not_submitted")}
        userId="user-3910d"
        onClose={jest.fn()}
        onExportComplete={jest.fn()}
      />,
    );
    await click(/next/i);
    await click(/^export$/i);
    expect(await screen.findByText(/failed to save dates: disk full/i)).toBeInTheDocument();
    expect(exportEnhancedMock).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3910 close prompt: approved only", () => {
  it("prop open, main refuses as sealed (approved): export runs and the close prompt is offered", async () => {
    updateMock.mockResolvedValue({
      success: false,
      error: "This deal is sealed, so it can't be changed.",
      dealLocked: "sealed",
      refusedEdit: "edit-deal-details",
    });
    render(
      <ExportModal
        transaction={txn("not_submitted")}
        userId="user-3910d"
        onClose={jest.fn()}
        onExportComplete={jest.fn()}
      />,
    );
    await click(/next/i);
    await click(/^export$/i);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
    await click(/^done$/i);
    expect(await screen.findByText(/mark this transaction as closed/i)).toBeInTheDocument();
  });
});
