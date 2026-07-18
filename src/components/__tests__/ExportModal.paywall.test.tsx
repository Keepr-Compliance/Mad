/**
 * Integration tests for ExportModal's export-unlock prompt wiring (BACKLOG-2075).
 *
 * Proves the interception at handleExport: a PAYWALL_LOCKED export result opens
 * the ExportUnlockPrompt (not a raw error), and a successful unlock re-runs the
 * export into the normal success path.
 */

import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const unlockMock = window.api.entitlement.unlockWithCredit as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;

const TX = "tx-locked-1";

// A transaction with dates pre-set so step 1 (date verification) can advance.
const transaction = {
  id: TX,
  user_id: "user-1",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

const PAYWALL = "PAYWALL_LOCKED: This transaction is locked. Unlock it to export.";

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  getStatusMock.mockResolvedValue({
    localTransactionId: TX,
    status: "locked",
    lockReason: "no_unlock",
    fromCache: false,
    quote: { nextUnitIndex: 1, unitPriceCents: 1300, currency: "USD", pricingTierId: "t1" },
    creditBalance: 1, // grant path available
  });
});

/** Advance the modal from step 1 (dates) to step 2, then trigger Export. */
async function driveToExport(): Promise<void> {
  // Step 1 → Step 2 (the Next button; dates are pre-filled from the transaction).
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  // Step 2 → export (the Export button).
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

it("locked export ⇒ opens the unlock prompt instead of a raw error", async () => {
  exportEnhancedMock.mockResolvedValue({ success: false, error: PAYWALL });
  render(
    <ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
  await driveToExport();

  // The unlock prompt appears; the raw PAYWALL_LOCKED string is NOT shown as an error.
  expect(await screen.findByTestId("export-unlock-prompt")).toBeInTheDocument();
  expect(screen.queryByText(/PAYWALL_LOCKED/)).toBeNull();

  // The unlock step fills and centers within the fixed-height modal frame
  // (MODAL_PANEL.lg), so the modal keeps a constant size across steps.
  const step = screen.getByTestId("export-unlock-step");
  expect(step.className).toContain("min-h-full");
  expect(step.className).toContain("items-center");
});

it("after a grant unlock, the export re-runs and reaches the success path", async () => {
  // First export attempt: locked. After unlock, the retry succeeds.
  exportEnhancedMock
    .mockResolvedValueOnce({ success: false, error: PAYWALL })
    .mockResolvedValueOnce({ success: true, path: "/out/audit" });
  unlockMock.mockResolvedValue({ success: true, status: "unlocked" });

  render(
    <ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
  await driveToExport();

  const useCredit = await screen.findByTestId("unlock-with-credit");
  await act(async () => {
    fireEvent.click(useCredit);
  });

  // Export was re-invoked (2 calls) and the modal advanced to the close/success flow.
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByTestId("export-unlock-prompt")).toBeNull(),
  );
});
