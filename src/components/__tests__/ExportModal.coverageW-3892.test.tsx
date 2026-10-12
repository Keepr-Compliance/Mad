/**
 * BACKLOG-3892 W — the export gate's start and end lines.
 *
 *  - an iPhone start gap names the least covered person (approved start line);
 *  - an END gap ("newer texts may be missing") opens the gate by itself, for any
 *    source, without changing `complete` (founder f240c29a: tell the user at export);
 *  - "Update now" rechecks for the SAME source the gate was opened for (W2);
 *  - off a Mac, a stored Mac source names no source (W5).
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";
import type { SourceCoverageGap } from "../../../electron/types/auditCoverage";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const ensureMock = window.api.transactions.ensureMessagesCoverage as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const TX = "tx-3892-w";
const transaction = {
  id: TX,
  user_id: "user-1",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-05T12:00:00Z",
  closed_at: "2026-03-01T12:00:00Z",
} as unknown as Transaction;

const at = (y: number, m: number, d: number): string => new Date(y, m - 1, d, 12).toISOString();
const startGap: SourceCoverageGap = { source: "iphone", coveredSince: at(2026, 8, 25), approximate: false, kind: "later", who: "Dana Reyes" };
const endGap = (source: SourceCoverageGap["source"]): SourceCoverageGap => ({
  source,
  coveredSince: at(2025, 1, 1),
  approximate: false,
  kind: "newer",
  lastSyncAt: at(2026, 2, 20),
  requiredEndISO: at(2026, 3, 1),
});

const covered = {
  success: true,
  complete: true,
  needsMessagesImport: false,
  messagesImporterAvailable: true,
  auditStartISO: at(2026, 1, 5),
  messagesFloorISO: at(2025, 1, 1),
  expansionStale: false,
};

function setSource(source: string): void {
  jest.mocked(window.api.preferences.get).mockResolvedValue({ success: true, preferences: { messages: { source } } } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
  setSource("iphone-sync");
});

async function driveToExport(): Promise<void> {
  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

it("iPhone start + end: the approved lines, the person named, both in the gate", async () => {
  completenessMock.mockResolvedValue({
    ...covered,
    complete: false,
    iphoneGap: true,
    iphoneCoveredSince: startGap.coveredSince,
    textStartGap: startGap,
    textEndGap: endGap("iphone"),
  });
  await driveToExport();
  expect(await screen.findByTestId("export-gate-iphone")).toHaveTextContent(
    "Keepr only has texts with Dana Reyes from Aug 25, but this deal starts Jan 5. Older texts may be missing. Connect your iPhone and click Sync iPhone",
  );
  expect(screen.getByTestId("export-gate-end")).toHaveTextContent(
    "Newer texts may be missing: your iPhone was last synced Feb 20, and this deal runs to Mar 1. Sync iPhone to get them.",
  );
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("an END gap alone opens the gate (complete is true); Export anyway exports", async () => {
  setSource("android-messages-web");
  completenessMock.mockResolvedValue({ ...covered, textEndGap: endGap("google_messages") });
  await driveToExport();
  expect(await screen.findByTestId("export-gate-end")).toHaveTextContent("Google Messages was last synced Feb 20");
  expect(screen.getByTestId("export-completeness-gate")).toHaveTextContent("Some texts may be missing for this transaction’s dates");
  expect(screen.queryByTestId("export-gate-iphone")).toBeNull();
  expect(screen.queryByTestId("export-gate-update-now")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByTestId("export-gate-export-anyway"));
  });
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
});

it("no gap at all: straight through", async () => {
  completenessMock.mockResolvedValue(covered);
  await driveToExport();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("export-completeness-gate")).toBeNull();
});

it("Mac end gap: Update now runs the import and rechecks for the Mac source (W2), then exports", async () => {
  setSource("macos-native");
  completenessMock.mockResolvedValueOnce({ ...covered, textEndGap: endGap("mac") }).mockResolvedValue(covered);
  ensureMock.mockResolvedValue({ success: true, ran: true, importRan: true, reason: "ok", imported: 3, messagesFloorISO: at(2025, 1, 1) });
  await driveToExport();
  expect(await screen.findByTestId("export-gate-end")).toHaveTextContent("Mac Messages were last imported Feb 20");
  await act(async () => {
    fireEvent.click(screen.getByTestId("export-gate-update-now"));
  });
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(completenessMock).toHaveBeenNthCalledWith(1, TX, "user-1", "mac");
  expect(completenessMock).toHaveBeenNthCalledWith(2, TX, "user-1", "mac");
});

it("Mac end gap: Update now that did not run re-surfaces the gate, never a silent export", async () => {
  setSource("macos-native");
  completenessMock.mockResolvedValue({ ...covered, textEndGap: endGap("mac") });
  ensureMock.mockResolvedValue({ success: true, ran: false, importRan: false, reason: "already-running", imported: 0, messagesFloorISO: at(2025, 1, 1) });
  await driveToExport();
  await screen.findByTestId("export-gate-end");
  await act(async () => {
    fireEvent.click(screen.getByTestId("export-gate-update-now"));
  });
  await waitFor(() => expect(completenessMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByTestId("export-gate-end")).toHaveTextContent("Mac Messages were last imported Feb 20");
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

describe("W5: Windows", () => {
  const sys = window.api.system as unknown as { platform: string };
  let before: string;
  beforeEach(() => {
    before = sys.platform;
    sys.platform = "win32";
  });
  afterEach(() => {
    sys.platform = before;
  });

  it("a stored Mac source names no source off a Mac", async () => {
    setSource("macos-native");
    completenessMock.mockResolvedValue(covered);
    await driveToExport();
    await waitFor(() => expect(completenessMock).toHaveBeenCalled());
    expect(completenessMock).toHaveBeenCalledWith(TX, "user-1");
  });
});
