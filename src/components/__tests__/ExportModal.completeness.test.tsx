/**
 * BACKLOG-2292 (Layer 3) — ExportModal completeness-gate wiring test.
 *
 * Proves the interception at handleExport (which now runs AFTER the date save,
 * fixing the prior update→export race):
 *   - an incomplete audit (audit start predates the imported message history)
 *     opens the gate and does NOT export;
 *   - "Export anyway" makes the explicit decision and proceeds to export;
 *   - a complete audit exports straight through with no gate.
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

const TX = "tx-complete-1";
const transaction = {
  id: TX,
  user_id: "user-1",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  getStatusMock.mockResolvedValue({
    localTransactionId: TX,
    status: "unlocked",
    fromCache: false,
  });
});

async function driveToExport(): Promise<void> {
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

it("incomplete audit ⇒ opens the completeness gate and does NOT export", async () => {
  completenessMock.mockResolvedValue({
    success: true,
    complete: false,
    needsMessagesImport: true,
    messagesImporterAvailable: true,
    auditStartISO: "2026-01-01T00:00:00.000Z",
    messagesFloorISO: "2026-05-01T00:00:00.000Z",
    expansionStale: false,
  });

  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await driveToExport();

  expect(await screen.findByTestId("export-completeness-gate")).toBeInTheDocument();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("'Export anyway' proceeds to export (explicit decision)", async () => {
  completenessMock.mockResolvedValue({
    success: true,
    complete: false,
    needsMessagesImport: true,
    messagesImporterAvailable: true,
    auditStartISO: "2026-01-01T00:00:00.000Z",
    messagesFloorISO: "2026-05-01T00:00:00.000Z",
    expansionStale: false,
  });

  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await driveToExport();

  const exportAnyway = await screen.findByTestId("export-gate-export-anyway");
  await act(async () => {
    fireEvent.click(exportAnyway);
  });

  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
});

it("complete audit ⇒ exports straight through with no gate", async () => {
  completenessMock.mockResolvedValue({
    success: true,
    complete: true,
    needsMessagesImport: false,
    messagesImporterAvailable: true,
    auditStartISO: "2026-01-01T00:00:00.000Z",
    messagesFloorISO: "2025-01-01T00:00:00.000Z",
    expansionStale: false,
  });

  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await driveToExport();

  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("export-completeness-gate")).toBeNull();
});
