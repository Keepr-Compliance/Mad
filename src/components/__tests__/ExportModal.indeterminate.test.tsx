/**
 * BACKLOG-2309 — ExportModal completeness-gate progress consumes the
 * BACKLOG-2305 audit-coverage `indeterminate` flag.
 *
 * Gap fixed: the export completeness gate rendered a determinate 0→100 bar off
 * `coverageProgress.percent`, so a MULTI-PASS audit-coverage import (which resets
 * per pass) could still visibly loop 100%→0% here — the exact regression 2305
 * fixed on the AuditCoveragePrompt popup. The gate must now consume the SAME
 * `indeterminate` flag from `useAuditCoverageCheck` and switch to an
 * indeterminate "Updating…" bar; a single determinate pass still shows the
 * numeric bar.
 *
 * The hook is mocked so the flag is driven directly (the real per-pass reset
 * detection is covered by the hook / AuditCoveragePrompt tests).
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";
import * as coverageHook from "../../hooks/useAuditCoverageCheck";
import type { UseAuditCoverageCheckResult } from "../../hooks/useAuditCoverageCheck";

jest.mock("../../hooks/useAuditCoverageCheck");

const useAuditCoverageCheckMock = coverageHook.useAuditCoverageCheck as jest.Mock;

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "tx-indeterminate-1";
const transaction = {
  id: TX,
  user_id: "user-1",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

// The audit start predates the imported message history ⇒ handleExport opens the
// completeness gate (and does not export straight through).
const INCOMPLETE = {
  success: true,
  complete: false,
  needsMessagesImport: true,
  messagesImporterAvailable: true,
  auditStartISO: "2026-01-01T00:00:00.000Z",
  messagesFloorISO: "2026-05-01T00:00:00.000Z",
  expansionStale: false,
};

function mockHook(overrides: Partial<UseAuditCoverageCheckResult>): void {
  useAuditCoverageCheckMock.mockReturnValue({
    checkCoverage: jest.fn().mockResolvedValue(null),
    checkExportCompleteness: jest.fn().mockResolvedValue(INCOMPLETE),
    runMessagesImport: jest
      .fn()
      .mockResolvedValue({ ran: false, importRan: false, floorISO: null }),
    importing: false,
    progress: null,
    indeterminate: false,
    ...overrides,
  } as UseAuditCoverageCheckResult);
}

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

async function driveToGate(): Promise<void> {
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

describe("ExportModal completeness gate — BACKLOG-2309 indeterminate flag", () => {
  it("indeterminate flag set ⇒ indeterminate bar, NO looping percentage", async () => {
    mockHook({
      importing: true,
      indeterminate: true,
      // A percent is present, but a multi-pass op must NOT render it (would loop).
      progress: { phase: "importing", current: 100, total: 100, percent: 100 },
    });

    render(
      <ExportModal
        transaction={transaction}
        userId="user-1"
        onClose={jest.fn()}
        onExportComplete={jest.fn()}
      />,
    );
    await driveToGate();

    expect(await screen.findByTestId("export-completeness-gate")).toBeInTheDocument();
    expect(screen.getByTestId("export-gate-progress-indeterminate")).toBeInTheDocument();
    // No percentage anywhere while indeterminate.
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(exportEnhancedMock).not.toHaveBeenCalled();
  });

  it("determinate progress (flag NOT set) ⇒ numeric bar, no indeterminate bar", async () => {
    mockHook({
      importing: true,
      indeterminate: false,
      progress: { phase: "importing", current: 40, total: 100, percent: 40 },
    });

    render(
      <ExportModal
        transaction={transaction}
        userId="user-1"
        onClose={jest.fn()}
        onExportComplete={jest.fn()}
      />,
    );
    await driveToGate();

    expect(await screen.findByTestId("export-completeness-gate")).toBeInTheDocument();
    expect(screen.getByTestId("export-gate-progress")).toBeInTheDocument();
    expect(screen.queryByTestId("export-gate-progress-indeterminate")).toBeNull();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });
});
