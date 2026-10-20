/**
 * BACKLOG-3339 slice B — the Export window when the file was saved but the
 * export could not be recorded in the audit log.
 *
 * The main process answers `{ success:false, notRecorded:true, path, error }`.
 * The finished screen then shows the founder-approved warning (amber icon),
 * keeps Open Audit and Done, and Done skips the "mark as closed?" prompt.
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const prefsGetMock = window.api.preferences.get as jest.Mock;

const exportFolderMock = jest.fn();
(window.api.transactions as unknown as { exportFolder: jest.Mock }).exportFolder = exportFolderMock;
(window.api as unknown as { onExportFolderProgress: jest.Mock }).onExportFolderProgress = jest.fn(
  () => () => {},
);

// Founder-approved copy, verbatim (pm_comments b002a154). Literal on purpose:
// not imported from the component, so a drift fails here.
const HEADING = "Export saved, but not recorded";
const BODY =
  "Your file was saved, but this export could not be recorded in the audit log. Export it again before you send it. If this keeps happening, contact support.";
const CLOSE_PROMPT = /would you like to mark this transaction as closed/i;

const transaction = {
  id: "tx-3339",
  user_id: "user-3339",
  status: "active",
  property_address: "1 Fixture Way",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

let onExportComplete: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  onExportComplete = jest.fn();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  prefsGetMock.mockResolvedValue({
    success: true,
    preferences: {
      export: { defaultFormat: "folder", emailExportMode: "individual", contentType: "both", attachmentType: "none" },
    },
  });
});

async function runExport() {
  render(
    <ExportModal transaction={transaction} userId="user-3339" onClose={jest.fn()} onExportComplete={onExportComplete} />,
  );
  await screen.findByTestId("export-format-button");
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: /^export$/i })[0]);
  });
}

it("not recorded: the warning screen with the exact copy, Open Audit and Done", async () => {
  exportFolderMock.mockResolvedValue({ success: false, notRecorded: true, path: "/out/audit", error: BODY });
  await runExport();
  expect(await screen.findByText(HEADING)).toBeInTheDocument();
  expect(screen.getByText(BODY)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /open audit/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^done$/i })).toBeInTheDocument();
  expect(screen.queryByText("Export Complete!")).toBeNull();
});

it("not recorded: Done finishes without the close prompt and reports not-recorded", async () => {
  exportFolderMock.mockResolvedValue({ success: false, notRecorded: true, path: "/out/audit", error: BODY });
  await runExport();
  await screen.findByText(HEADING);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
  });
  expect(screen.queryByText(CLOSE_PROMPT)).toBeNull();
  expect(onExportComplete).toHaveBeenCalledWith({ success: false, notRecorded: true, path: "/out/audit" });
});

it("positive control: a recorded export's Done DOES offer the close prompt for this deal", async () => {
  exportFolderMock.mockResolvedValue({ success: true, path: "/out/audit" });
  await runExport();
  await screen.findByText("Export Complete!");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
  });
  expect(screen.getByText(CLOSE_PROMPT)).toBeInTheDocument();
  expect(screen.queryByText(HEADING)).toBeNull();
});

it("enhanced (single file) not recorded: same warning screen", async () => {
  prefsGetMock.mockResolvedValue({
    success: true,
    preferences: {
      export: { defaultFormat: "combined-pdf", emailExportMode: "individual", contentType: "both", attachmentType: "none" },
    },
  });
  exportEnhancedMock.mockResolvedValue({ success: false, notRecorded: true, path: "/out/audit.pdf", error: BODY });
  await runExport();
  expect(await screen.findByText(HEADING)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /open audit/i })).toBeInTheDocument();
});
