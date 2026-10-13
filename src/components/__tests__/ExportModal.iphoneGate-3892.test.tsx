/**
 * BACKLOG-3892 S2 (SR D3b) — the export completeness gate for an iPhone user.
 *
 *  - completeness is asked with the user's own source ("iphone");
 *  - an iPhone gap opens the gate with the Sync iPhone path and NO "Update now"
 *    (the Mac import cannot fill it, so it would loop);
 *  - after a sync reads the deal's chats back (iphoneGap false, complete) the export
 *    goes straight through, even though the global oldest-text floor is after the
 *    deal start.
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

const TX = "tx-iphone-3892";
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
  jest.mocked(window.api.preferences.get).mockResolvedValue({ success: true, preferences: { messages: { source: "iphone-sync" } } } as never);
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

const gapResult = {
  success: true,
  complete: false,
  needsMessagesImport: true,
  messagesImporterAvailable: true,
  auditStartISO: "2026-01-01T00:00:00.000Z",
  messagesFloorISO: "2026-08-25T00:00:00.000Z",
  expansionStale: false,
  iphoneGap: true,
  iphoneCoveredSince: "2026-08-25T00:00:00.000Z",
};

it("an iPhone gap opens the gate with the Sync iPhone path and no Update now", async () => {
  completenessMock.mockResolvedValue(gapResult);
  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await driveToExport();
  expect(await screen.findByTestId("export-completeness-gate")).toBeInTheDocument();
  expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone");
  expect(screen.getByTestId("export-gate-iphone")).toHaveTextContent(/click Sync iPhone/);
  expect(screen.queryByTestId("export-gate-update-now")).toBeNull();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
  // "Export anyway" stays the explicit way out.
  await act(async () => {
    fireEvent.click(screen.getByTestId("export-gate-export-anyway"));
  });
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
});

it("after the widened sync the iPhone rows clear it: exports straight through despite the global floor", async () => {
  completenessMock.mockResolvedValue({ ...gapResult, complete: true, iphoneGap: false, iphoneCoveredSince: "2025-12-31T00:00:00.000Z" });
  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await driveToExport();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("export-completeness-gate")).toBeNull();
});

// BACKLOG-3892 R1 (SR): the export check resolves the source through the SAME rule as sync
// detection and the create prompt (importSourcePolicy chosenImportSource) — phone type counts
// when nothing is stored. Fixture shapes: `preferences:get` returns the Supabase `preferences`
// jsonb (carries `phone_type`, `messages` absent when nothing was chosen); `user:get-phone-type`
// returns `{ success, phoneType }` from users_local (as in Settings.test.tsx, BACKLOG-3418).
describe("R1: no stored source — the phone type decides (Windows)", () => {
  const sys = window.api.system as unknown as { platform: string };
  let platformBefore: string;
  const getPhoneTypeMock = window.api.user.getPhoneType as jest.Mock;
  beforeEach(() => {
    platformBefore = sys.platform;
    sys.platform = "win32";
    completenessMock.mockResolvedValue(gapResult);
  });
  afterEach(() => {
    sys.platform = platformBefore;
    getPhoneTypeMock.mockResolvedValue({ success: true, phoneType: null });
  });

  async function exportOnce(): Promise<void> {
    render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
    await driveToExport();
    await waitFor(() => expect(completenessMock).toHaveBeenCalled());
  }

  it("local phone type iphone, nothing stored -> completeness asked with iphone", async () => {
    jest.mocked(window.api.preferences.get).mockResolvedValue({ success: true, preferences: {} } as never);
    getPhoneTypeMock.mockResolvedValue({ success: true, phoneType: "iphone" });
    await exportOnce();
    expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone");
    expect(await screen.findByTestId("export-gate-iphone")).toBeInTheDocument();
  });

  it("cloud phone_type iphone only (local not recovered), nothing stored -> iphone", async () => {
    jest.mocked(window.api.preferences.get).mockResolvedValue({ success: true, preferences: { phone_type: "iphone" } } as never);
    getPhoneTypeMock.mockResolvedValue({ success: true, phoneType: null });
    await exportOnce();
    expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone");
  });

  it("preferences unreadable (offline): the local phone type still gives iphone", async () => {
    jest.mocked(window.api.preferences.get).mockResolvedValue({ success: false, error: "offline" } as never);
    getPhoneTypeMock.mockResolvedValue({ success: true, phoneType: "iphone" });
    await exportOnce();
    expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone");
    expect(await screen.findByTestId("export-gate-iphone")).toBeInTheDocument();
  });

  it("preferences read throws: the local phone type still gives iphone", async () => {
    jest.mocked(window.api.preferences.get).mockRejectedValue(new Error("network down"));
    getPhoneTypeMock.mockResolvedValue({ success: true, phoneType: "iphone" });
    await exportOnce();
    expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone");
  });
});
