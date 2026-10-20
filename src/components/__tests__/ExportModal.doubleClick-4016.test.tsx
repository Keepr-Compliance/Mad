/**
 * BACKLOG-4016 — one click starts one export.
 *
 * Before the fix, a second click on Export during the pre-export checks (date
 * save, text-source read, completeness check) started a second export, and so
 * did "Export anyway" or a second "Update now" while the gate's re-check was
 * pending. ExportModal now holds a ref (the authority, so two clicks in one task
 * are caught before any render) and a state (Export and the gate buttons are
 * disabled from the first click). Both are released in finally on every exit.
 *
 * The gate also cannot be dismissed by its backdrop while that work is running
 * (SR-C): before, dismissing it during the re-check still exported afterwards.
 *
 * Fixtures:
 * - checkExportCompleteness results follow the shape the existing gate suites
 *   (ExportModal.completeness / coverageW-3892) use.
 * - ensureMessagesCoverage result `{ success, importRan, ran }` follows the
 *   hook's mapping in useAuditCoverageCheck.ts.
 * - Saved defaults: `{ success: true, preferences: { export: {...} } }`, as in
 *   ExportModal.exportFormatDefaults-334 (transcribed from settingsService).
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const completenessMock = window.api.transactions.checkExportCompleteness as jest.Mock;
const coverageMock = window.api.transactions.ensureMessagesCoverage as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const prefsGetMock = window.api.preferences.get as jest.Mock;

const TX = "tx-4016";
const USER = "user-4016";
const transaction = {
  id: TX,
  user_id: USER,
  status: "active",
  property_address: "1 Test Way",
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
const INCOMPLETE = {
  ...COMPLETE,
  complete: false,
  needsMessagesImport: true,
  messagesFloorISO: "2026-05-01T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  completenessMock.mockResolvedValue(COMPLETE);
  getStatusMock.mockResolvedValue({ localTransactionId: TX, status: "unlocked", fromCache: false });
});

function renderModal() {
  return render(
    <ExportModal transaction={transaction} userId={USER} onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
}
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function toStep2() {
  const n = await screen.findAllByRole("button", { name: /next/i });
  await click(n[0]);
}
async function exportButton(): Promise<HTMLElement> {
  return (await screen.findAllByRole("button", { name: /^export$/i }))[0];
}
/** The gate's backdrop: the nearest `fixed` ancestor of the gate's content. */
function gateBackdrop(): HTMLElement {
  let el: HTMLElement | null = screen.getByTestId("export-completeness-gate");
  while (el && !String(el.className).includes("fixed")) el = el.parentElement;
  expect(el).not.toBeNull();
  return el as HTMLElement;
}
/** Open the gate: Export with an incomplete result, Update now offered. */
async function openGate() {
  completenessMock.mockResolvedValue(INCOMPLETE);
  coverageMock.mockResolvedValue({ success: true, importRan: true, ran: true });
  renderModal();
  await toStep2();
  await click(await exportButton());
  await screen.findByTestId("export-gate-update-now");
}

describe("BACKLOG-4016: one click, one export", () => {
  it("P1 Export double-click while the date save is pending -> disabled, 1 export", async () => {
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValueOnce(save.promise);
    renderModal();
    await toStep2();
    const b = await exportButton();
    await click(b);
    expect(b).toBeDisabled();
    await click(b);
    await act(async () => {
      save.resolve({ success: true });
    });
    await waitFor(() => expect(exportEnhancedMock.mock.calls.length).toBeGreaterThan(0));
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("P2 Export double-click while the completeness check is pending -> disabled, 1 export", async () => {
    const chk = deferred<typeof COMPLETE>();
    completenessMock.mockReturnValueOnce(chk.promise);
    renderModal();
    await toStep2();
    const b = await exportButton();
    await click(b);
    expect(b).toBeDisabled();
    await click(b);
    await act(async () => {
      chk.resolve(COMPLETE);
    });
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("P3 a click after the export screen shows does nothing (button gone)", async () => {
    const run = deferred<{ success: boolean; path: string }>();
    exportEnhancedMock.mockReturnValueOnce(run.promise);
    renderModal();
    await toStep2();
    const b = await exportButton();
    await click(b);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
    expect(b.isConnected).toBe(false);
    await click(b);
    await act(async () => {
      run.resolve({ success: true, path: "/out/a" });
    });
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("P4 gate: 'Export anyway' double-click -> 1 export", async () => {
    completenessMock.mockResolvedValue(INCOMPLETE);
    renderModal();
    await toStep2();
    await click(await exportButton());
    const a = await screen.findByTestId("export-gate-export-anyway");
    await click(a);
    await click(a);
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("P5 gate: 'Export anyway' during the 'Update now' re-check -> disabled, 1 export", async () => {
    await openGate();
    const recheck = deferred<typeof COMPLETE>();
    completenessMock.mockReturnValueOnce(recheck.promise);
    await click(screen.getByTestId("export-gate-update-now"));
    await settle(50);
    // The import has finished (importing is false); only the re-check is pending.
    expect(coverageMock).toHaveBeenCalledTimes(1);
    const a = screen.getByTestId("export-gate-export-anyway");
    expect(a).toBeDisabled();
    expect(screen.getByTestId("export-gate-update-now")).toBeDisabled();
    await click(a);
    await act(async () => {
      recheck.resolve(COMPLETE);
    });
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("P6 a failed export releases the guard: Export again runs a second export", async () => {
    exportEnhancedMock.mockResolvedValueOnce({ success: false, error: "disk full" });
    renderModal();
    await toStep2();
    await click(await exportButton());
    await screen.findByText(/disk full/);
    const b = await exportButton();
    expect(b).not.toBeDisabled();
    await click(b);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(2));
  });

  it("P7 a dismissed gate releases the guard: Export from options runs", async () => {
    completenessMock.mockResolvedValueOnce(INCOMPLETE);
    renderModal();
    await toStep2();
    await click(await exportButton());
    await screen.findByTestId("export-completeness-gate");
    await click(gateBackdrop());
    expect(screen.queryByTestId("export-completeness-gate")).toBeNull();
    await toStep2();
    const b = await exportButton();
    expect(b).not.toBeDisabled();
    await click(b);
    await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  });

  it("P8 two Export clicks in one task (no render between) -> 1 export", async () => {
    renderModal();
    await toStep2();
    const b = await exportButton();
    await act(async () => {
      fireEvent.click(b);
      fireEvent.click(b);
    });
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("SR-C the gate cannot be dismissed during the re-check; it exports once when the re-check settles", async () => {
    await openGate();
    const recheck = deferred<typeof COMPLETE>();
    completenessMock.mockReturnValueOnce(recheck.promise);
    await click(screen.getByTestId("export-gate-update-now"));
    await settle(50);
    expect(coverageMock).toHaveBeenCalledTimes(1);
    await click(gateBackdrop());
    // Still up, nothing exported yet.
    expect(screen.getByTestId("export-completeness-gate")).toBeInTheDocument();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(0);
    await act(async () => {
      recheck.resolve(COMPLETE);
    });
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("SR-D 'Update now' double-click in one task -> 1 import, 1 export", async () => {
    await openGate();
    completenessMock.mockResolvedValue(COMPLETE);
    const u = screen.getByTestId("export-gate-update-now");
    await act(async () => {
      fireEvent.click(u);
      fireEvent.click(u);
    });
    await settle(50);
    expect(coverageMock).toHaveBeenCalledTimes(1);
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  });

  it("S1 saved defaults: the step-1 Export double-click while the date save is pending -> 1 export", async () => {
    prefsGetMock.mockResolvedValue({
      success: true,
      preferences: {
        export: {
          defaultFormat: "combined-pdf",
          emailExportMode: "thread",
          contentType: "both",
          attachmentType: "all",
        },
      },
    });
    const save = deferred<{ success: boolean }>();
    updateMock.mockReturnValueOnce(save.promise);
    renderModal();
    // The prefs load is async; "Export format" appears once defaults are applied.
    await screen.findByTestId("export-format-button");
    const b = await exportButton();
    await click(b);
    expect(b).toBeDisabled();
    await click(b);
    await act(async () => {
      save.resolve({ success: true });
    });
    await waitFor(() => expect(exportEnhancedMock.mock.calls.length).toBeGreaterThan(0));
    await settle();
    expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
