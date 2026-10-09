/**
 * BACKLOG-3828 — the export-finished screen says exported files are not
 * encrypted, for every export format that writes to disk (One PDF, Audit
 * Package, Summary PDF). Not shown while exporting or after a failure.
 */
import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
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

const TITLE = "Exported files aren't encrypted";
// Founder-approved body, verbatim (BACKLOG-3828 pm_comments). Literal on purpose: not imported
// from the component, so a copy drift in the component fails here.
const BODY =
  "Your audit was saved as regular files so you can open it. Keepr's encryption protects your data inside Keepr only \u2014 it doesn't apply to exported files. We recommend keeping your records in Keepr rather than storing exported copies on this computer. You're responsible for how exported files are stored, shared and deleted.";

const transaction = {
  id: "tx-3828",
  user_id: "user-3828",
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportFolderMock.mockResolvedValue({ success: true, path: "/out/audit" });
  exportEnhancedMock.mockResolvedValue({ success: true, filePath: "/out/audit.pdf" });
});

async function runExport(defaultFormat: string) {
  prefsGetMock.mockResolvedValue({
    success: true,
    preferences: {
      export: { defaultFormat, emailExportMode: "individual", contentType: "both", attachmentType: "none" },
    },
  });
  render(
    <ExportModal transaction={transaction} userId="user-3828" onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
  await screen.findByTestId("export-format-button");
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: /^export$/i })[0]);
  });
}

it.each([
  ["folder", "Audit Package"],
  ["combined-pdf", "One PDF"],
  ["pdf", "Summary PDF"],
])("%s export complete screen shows the unencrypted notice (%s)", async (format) => {
  await runExport(format);
  await screen.findByRole("button", { name: /open audit/i });
  expect(screen.getByText(TITLE)).toBeInTheDocument();
  expect(screen.getByTestId("export-unencrypted-notice")).toHaveTextContent(BODY);
});

it("is not shown on a failed export", async () => {
  exportFolderMock.mockResolvedValue({ success: false, error: "disk full" });
  await runExport("folder");
  await waitFor(() => expect(exportFolderMock).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /open audit/i })).toBeNull();
  expect(screen.queryByText(TITLE)).toBeNull();
});

it("is not shown before the export completes", async () => {
  let release: (v: unknown) => void = () => {};
  exportFolderMock.mockReturnValue(new Promise((r) => (release = r)));
  await runExport("folder");
  expect(screen.queryByText(TITLE)).toBeNull();
  await act(async () => {
    release({ success: true, path: "/out/audit" });
  });
  expect(await screen.findByText(TITLE)).toBeInTheDocument();
});
