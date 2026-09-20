/**
 * BACKLOG-334 — the export format is set once, not on every export.
 *
 * With saved export defaults, "Verify Transaction Dates" carries an "Export
 * format" button in its heading row (title left, button right) and its primary
 * button runs the export directly; the options step is reachable only through
 * that button, and what you change there applies to this export alone unless
 * the save checkbox is ticked.
 *
 * BACKLOG-334 founder QA 2026-09-19: the explanation card that used to state the
 * saved options in words is gone. C3 and C3b now hold the layout it was replaced
 * by — the row, and the card's absence.
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
  return screen.findByTestId("export-format-button");
}

/** The step-1 heading row: the element the heading and the button must share. */
function headingRow(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Verify Transaction Dates" });
  const row = heading.parentElement as HTMLElement | null;
  expect(row).not.toBeNull();
  return row as HTMLElement;
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

  // No "Export format" button, and the primary still promises a next screen.
  expect(screen.queryByTestId("export-format-button")).toBeNull();
  const next = screen.getAllByRole("button", { name: /^next/i })[0];

  await act(async () => {
    fireEvent.click(next);
  });

  expect(await screen.findByText("Export Options")).toBeInTheDocument();
  expect(exportFolderMock).not.toHaveBeenCalled();
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("C3: the heading and the \"Export format\" button share one row, title left and button right", async () => {
  renderModal();
  const button = await waitForDefaults();

  // Same row container as the heading — the emails/texts tab idiom
  // (TransactionEmailsTab.tsx:667). A button rendered anywhere else on step 1
  // fails here even though it is still clickable.
  const row = headingRow();
  expect(row).toContainElement(button);

  // Co-location is not the founder's ask: the row must also push the two apart.
  // Without this, `justify-start` (heading and button adjacent on the left)
  // would pass.
  expect(row.className).toContain("justify-between");
  expect(row.className).toContain("items-center");
});

it("C3b: the saved-options explanation card is gone", async () => {
  renderModal();
  await waitForDefaults();

  // Both spellings: the testid the card carried, AND its literal text. The
  // testid alone is vacuous once the card is deleted — it would pass against a
  // restored card that used any other testid. The colon excludes the button,
  // whose own label is "Export format" with nothing after it.
  expect(screen.queryByTestId("export-format-summary")).toBeNull();
  expect(screen.queryByText(/^Export format:/)).toBeNull();
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
