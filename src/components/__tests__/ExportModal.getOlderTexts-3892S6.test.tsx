/**
 * BACKLOG-3892 S6 — "Get older texts" in the export gate (iPhone start gap).
 *
 *  - offered only when S5's availability is `available`;
 *  - after a successful run completeness is re-checked WITH the gate's source ("iphone")
 *    and, complete with no newer gap, the export goes through (as "Update now" does);
 *  - still a gap -> the gate stays with the re-read line.
 * Completeness fixtures copied from ExportModal.iphoneGate-3892.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";
import type { BackfillAvailability, BackfillResult } from "../../../electron/types/iphoneBackfill";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;

const backfillAvailability = jest.fn<Promise<BackfillAvailability>, [string]>();
const backfillOlder = jest.fn<Promise<BackfillResult>, [string]>();
const cancelBackfill = jest.fn(async () => ({ success: true }));

const TX = "tx-iphone-3892-s6";
const transaction = {
  id: TX,
  user_id: "user-1",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

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

const apiWithSync = window.api as unknown as { sync?: unknown };
let syncBefore: unknown;

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  jest.mocked(window.api.preferences.get).mockResolvedValue({ success: true, preferences: { messages: { source: "iphone-sync" } } } as never);
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
  backfillAvailability.mockResolvedValue({ available: true, cappedByPhone: false });
  syncBefore = apiWithSync.sync;
  apiWithSync.sync = {
    backfillAvailability,
    backfillOlder,
    cancelBackfill,
    onBackfillProgress: () => () => undefined,
  };
});

afterEach(() => {
  apiWithSync.sync = syncBefore;
});

async function openGate(): Promise<void> {
  render(<ExportModal transaction={transaction} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
  await screen.findByTestId("export-completeness-gate");
}

it("offered when available; success re-checks with iphone and exports", async () => {
  completenessMock.mockResolvedValueOnce(gapResult);
  backfillOlder.mockResolvedValue({ success: true, messagesStored: 40, coverageRecorded: true, coveredSinceAfter: "2025-12-31T00:00:00.000Z", cappedByPhone: false });
  await openGate();
  await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
  completenessMock.mockClear();
  completenessMock.mockResolvedValue({ ...gapResult, complete: true, iphoneGap: false, iphoneCoveredSince: "2025-12-31T00:00:00.000Z" });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
  });
  await waitFor(() => expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone"));
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("export-completeness-gate")).toBeNull();
});

it("not available (locked) -> no button; the sync path stays", async () => {
  completenessMock.mockResolvedValue(gapResult);
  backfillAvailability.mockResolvedValue({ available: false, reason: "locked" });
  await openGate();
  await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
  await act(async () => {});
  expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
  expect(screen.getByTestId("export-gate-iphone")).toHaveTextContent(/click Sync iPhone/);
});

it("still a gap after the run -> the gate stays with the re-read line, no export", async () => {
  completenessMock.mockResolvedValueOnce(gapResult);
  backfillOlder.mockResolvedValue({ success: true, messagesStored: 3, coverageRecorded: true, coveredSinceAfter: "2026-05-01T00:00:00.000Z", cappedByPhone: true });
  await openGate();
  completenessMock.mockResolvedValue({ ...gapResult, iphoneCoveredSince: "2026-05-01T12:00:00.000Z" });
  await act(async () => {
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
  });
  await waitFor(() => expect(completenessMock).toHaveBeenLastCalledWith(TX, "user-1", "iphone"));
  expect(await screen.findByTestId("get-older-texts-result")).toHaveTextContent("Added 3 older texts from your saved iPhone backup.");
  expect(screen.getByTestId("export-gate-iphone")).toHaveTextContent(/from May 1\./);
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

// ---- fix round (SR review 4335711f): the paths that must NOT export -------------------

const okRun: BackfillResult = {
  success: true,
  messagesStored: 40,
  coverageRecorded: true,
  coveredSinceAfter: "2025-12-31T00:00:00.000Z",
  cappedByPhone: false,
};

async function runBackfillWith(recheckResult: unknown): Promise<void> {
  completenessMock.mockResolvedValueOnce(gapResult);
  backfillOlder.mockResolvedValue(okRun);
  await openGate();
  await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
  completenessMock.mockClear();
  completenessMock.mockResolvedValue(recheckResult);
  await act(async () => {
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
  });
  await waitFor(() => expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone"));
}

it("R1: start gap closed but a NEWER-texts gap remains -> no export, the newer line is shown", async () => {
  // Shape transcribed from auditCoverageService.ts:668-693 (complete from iphone.gap only;
  // textEndGap set independently from iphone.endGap).
  await runBackfillWith({
    ...gapResult,
    complete: true,
    iphoneGap: false,
    iphoneCoveredSince: "2025-12-31T00:00:00.000Z",
    textEndGap: { source: "iphone", kind: "newer", coveredSince: "2025-12-31T00:00:00.000Z", approximate: false, lastSyncAt: "2026-01-10T00:00:00.000Z", requiredEndISO: "2026-03-01T00:00:00.000Z" },
  });
  expect(await screen.findByTestId("export-gate-end")).toBeInTheDocument();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("S-a: the re-check fails (null) -> no export, the gate stays", async () => {
  await runBackfillWith(null);
  await act(async () => {});
  expect(exportEnhancedMock).not.toHaveBeenCalled();
  expect(screen.getByTestId("export-completeness-gate")).toBeInTheDocument();
});

it("S-c: stale expansion (not complete, no iPhone gap, no newer gap) -> gate re-rendered, no export", async () => {
  // The shape handleExport falls through on (expansionStale true, iphoneGap false).
  await runBackfillWith({
    ...gapResult,
    complete: false,
    iphoneGap: false,
    expansionStale: true,
    iphoneCoveredSince: "2025-12-31T00:00:00.000Z",
  });
  await act(async () => {});
  expect(exportEnhancedMock).not.toHaveBeenCalled();
  expect(screen.getByTestId("export-completeness-gate")).toBeInTheDocument();
  // re-rendered from the fresh result: the stale iPhone start line is gone
  expect(screen.queryByTestId("export-gate-iphone")).toBeNull();
});

it("S-b: the gate closes mid-run (Export anyway) -> the finished run does not export a second time", async () => {
  completenessMock.mockResolvedValueOnce(gapResult);
  let finish: (r: BackfillResult) => void = () => undefined;
  backfillOlder.mockImplementation(() => new Promise<BackfillResult>((res) => (finish = res)));
  await openGate();
  await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
  });
  await screen.findByTestId("get-older-texts-progress");
  await act(async () => {
    fireEvent.click(screen.getByTestId("export-gate-export-anyway"));
  });
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  completenessMock.mockClear();
  completenessMock.mockResolvedValue({ ...gapResult, complete: true, iphoneGap: false });
  await act(async () => finish(okRun));
  await act(async () => {});
  expect(completenessMock).not.toHaveBeenCalled();
  expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
});

it.each(["locked", "no-gap", "nothing-older"] as const)(
  "run refused as %s -> no sentence, no export, coverage re-checked, no button",
  async (reason) => {
    completenessMock.mockResolvedValueOnce(gapResult);
    backfillOlder.mockResolvedValue({ success: false, reason, messagesStored: 0, coverageRecorded: false });
    await openGate();
    await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
    completenessMock.mockClear();
    // coverage still shows the start gap (e.g. locked): the gate re-renders, never exports
    completenessMock.mockResolvedValue(gapResult);
    // availability, re-asked, still says available — the button must go because of the refusal
    await act(async () => {
      fireEvent.click(await screen.findByTestId("get-older-texts-button"));
    });
    await waitFor(() => expect(completenessMock).toHaveBeenCalledWith(TX, "user-1", "iphone"));
    await act(async () => {});
    expect(exportEnhancedMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Try again later/)).toBeNull();
    expect(screen.queryByTestId("get-older-texts-result")).toBeNull();
    expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
  },
);

// ---- every path to exportEnhanced is behind the gate (security review, 2026-10-12) -----
// BACKLOG-3910d: a refused date save (locked) must NOT skip the coverage gate.
describe("locked deal: the coverage gate still runs", () => {
  const REFUSAL = {
    success: false,
    error: "This deal is with your broker for review, so it can't be changed until it's returned to you.",
    dealLocked: "submitted",
    refusedEdit: "edit-deal-details",
  };

  async function goToExport(tx: Transaction): Promise<void> {
    render(<ExportModal transaction={tx} userId="user-1" onClose={jest.fn()} onExportComplete={jest.fn()} />);
    const nextButtons = await screen.findAllByRole("button", { name: /next/i });
    await act(async () => {
      fireEvent.click(nextButtons[0]);
    });
    const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
    await act(async () => {
      fireEvent.click(exportButtons[0]);
    });
  }

  it("the save is refused as locked at run time + an iPhone start gap -> gate shown, no export", async () => {
    updateMock.mockResolvedValue(REFUSAL);
    completenessMock.mockResolvedValue(gapResult);
    await goToExport(transaction);
    await screen.findByTestId("export-completeness-gate");
    expect(exportEnhancedMock).not.toHaveBeenCalled();
  });

  it("the deal reads locked from the start (save skipped) + a gap -> gate shown, no export", async () => {
    completenessMock.mockResolvedValue(gapResult);
    await goToExport({ ...transaction, submission_status: "submitted" } as unknown as Transaction);
    await screen.findByTestId("export-completeness-gate");
    expect(updateMock).not.toHaveBeenCalled();
    expect(exportEnhancedMock).not.toHaveBeenCalled();
  });
});
