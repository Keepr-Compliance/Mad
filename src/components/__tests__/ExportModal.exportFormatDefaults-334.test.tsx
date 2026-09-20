/**
 * BACKLOG-334 — the export format is set once, not on every export.
 *
 * With saved export defaults, "Verify Transaction Dates" says what this export
 * will use and its primary button runs the export directly; the options step is
 * reachable only through the "Export format" button, and what you change there
 * applies to this export alone unless the save checkbox is ticked.
 *
 * The preference fixture is transcribed from the producer rather than invented:
 * `settingsService.getPreferences` (src/services/settingsService.ts:108-118)
 * returns `result.preferences` as `data`, so the IPC mock resolves
 * `{ success: true, preferences: { export: {...} } }`.
 */

import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const prefsGetMock = window.api.preferences.get as jest.Mock;
const prefsUpdateMock = window.api.preferences.update as jest.Mock;

// Not present in tests/setup.js (only exportEnhanced is), and the folder fixture
// below needs both. Installed once for this file.
const exportFolderMock = jest.fn();
(window.api.transactions as unknown as { exportFolder: jest.Mock }).exportFolder = exportFolderMock;
(window.api as unknown as { onExportFolderProgress: jest.Mock }).onExportFolderProgress = jest.fn(
  () => () => {},
);

const TX = "tx-334";
const USER = "user-334";

/** Dates pre-set, so step 1 can advance without typing. */
const transaction = {
  id: TX,
  user_id: USER,
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

/** Same transaction with no end date — the primary is disabled in this state. */
const transactionNoEndDate = {
  ...transaction,
  closed_at: null,
} as unknown as Transaction;

/**
 * Seeded defaults. `folder` (NOT the "combined-pdf" initial state) so that a
 * mutation resetting the format to "combined-pdf" is a visible change and not a
 * no-op; `texts` drops the threading segment from the summary by design.
 */
const SAVED_DEFAULTS = {
  defaultFormat: "folder",
  emailExportMode: "individual",
  contentType: "texts",
  attachmentType: "none",
};

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportFolderMock.mockResolvedValue({ success: true, path: "/out/audit" });
  exportEnhancedMock.mockResolvedValue({ success: true, filePath: "/out/audit.pdf" });
  prefsUpdateMock.mockResolvedValue({ success: true });
  prefsGetMock.mockResolvedValue({ success: true, preferences: { export: SAVED_DEFAULTS } });
});

function renderModal(tx: Transaction = transaction) {
  return render(
    <ExportModal transaction={tx} userId={USER} onClose={jest.fn()} onExportComplete={jest.fn()} />,
  );
}

/** The step-1/step-2 primary. "Export format" is excluded by the anchored regex. */
function primaryButton(): HTMLElement {
  return screen.getAllByRole("button", { name: /^export$/i })[0];
}

/** The prefs load is async; clicking before it resolves is a false red. */
async function waitForDefaults(): Promise<HTMLElement> {
  return screen.findByTestId("export-format-summary");
}

async function waitForPrefsLoad(): Promise<void> {
  await waitFor(() => expect(prefsGetMock).toHaveBeenCalled());
  await act(async () => {});
}

it("C1: with saved defaults, the primary exports and the options step is never rendered", async () => {
  renderModal();
  await waitForDefaults();

  // Its label changed with its action.
  expect(primaryButton()).toHaveTextContent(/^Export$/);
  expect(screen.queryByText("Export Options")).toBeNull();

  await act(async () => {
    fireEvent.click(primaryButton());
  });

  await waitFor(() => expect(exportFolderMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Export Options")).toBeNull();
});

it("C2: with no saved format, the options step renders and nothing is exported", async () => {
  prefsGetMock.mockResolvedValue({ success: true, preferences: { export: {} } });
  renderModal();
  await waitForPrefsLoad();

  // No summary row, and the primary still promises a next screen.
  expect(screen.queryByTestId("export-format-summary")).toBeNull();
  const next = screen.getAllByRole("button", { name: /^next/i })[0];

  await act(async () => {
    fireEvent.click(next);
  });

  expect(await screen.findByText("Export Options")).toBeInTheDocument();
  expect(exportFolderMock).not.toHaveBeenCalled();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("C3: the summary reads back the saved values, in words", async () => {
  renderModal();
  // Exact text, not toHaveTextContent: that matcher is a SUBSTRING match, so an
  // extra trailing segment (threading appended to a texts-only export) would
  // still pass. Mutation M10 was a 0-red until this line changed.
  expect((await waitForDefaults()).textContent).toBe(
    "Export format: Audit Package · Texts only · No attachments",
  );
});

it("C3b: a One-PDF record reads back its own values, threading included", async () => {
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
  renderModal();
  expect((await waitForDefaults()).textContent).toBe(
    "Export format: One PDF · Texts and emails · All attachments · Threaded emails",
  );
});

it("C4a: \"Export format\" opens the options step with the saved format selected", async () => {
  renderModal();
  await waitForDefaults();

  await act(async () => {
    fireEvent.click(screen.getByTestId("export-format-button"));
  });

  expect(await screen.findByText("Export Options")).toBeInTheDocument();
  // Selected format buttons carry the filled purple style.
  expect(screen.getByRole("button", { name: /Audit Package/ }).className).toContain("bg-purple-500");
  expect(screen.getByRole("button", { name: /One PDF/ }).className).not.toContain("bg-purple-500");
});

it("C4b: a change made there applies to this export only, with the box unticked", async () => {
  renderModal();
  await waitForDefaults();

  await act(async () => {
    fireEvent.click(screen.getByTestId("export-format-button"));
  });
  await screen.findByText("Export Options");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /One PDF/ }));
  });
  await act(async () => {
    fireEvent.click(primaryButton());
  });

  // The changed format reached the IPC ("combined-pdf" exports through
  // exportEnhanced with summaryOnly false), and the saved record was untouched.
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(exportEnhancedMock).toHaveBeenCalledWith(
    TX,
    expect.objectContaining({ exportFormat: "pdf", summaryOnly: false, contentType: "texts" }),
  );
  expect(exportFolderMock).not.toHaveBeenCalled();
  expect(prefsUpdateMock).not.toHaveBeenCalled();
});

it("C5: ticking the box saves the options as the new defaults", async () => {
  renderModal();
  await waitForDefaults();

  await act(async () => {
    fireEvent.click(screen.getByTestId("export-format-button"));
  });
  await screen.findByText("Export Options");
  await act(async () => {
    fireEvent.click(screen.getByRole("checkbox"));
  });
  await act(async () => {
    fireEvent.click(primaryButton());
  });

  await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledTimes(1));
  expect(prefsUpdateMock).toHaveBeenCalledWith(USER, {
    export: {
      defaultFormat: "folder",
      emailExportMode: "individual",
      contentType: "texts",
      attachmentType: "none",
    },
  });
});

it("C6: \"Export format\" cannot reach the export with the dates unfilled", async () => {
  renderModal(transactionNoEndDate);
  await waitForDefaults();

  await act(async () => {
    fireEvent.click(screen.getByTestId("export-format-button"));
  });

  expect(
    await screen.findByText("Please provide Start Date and End Date to continue"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Export Options")).toBeNull();
  expect(exportFolderMock).not.toHaveBeenCalled();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});
