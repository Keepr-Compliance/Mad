/**
 * BACKLOG-3767 — "Include checklist items" in the Export window.
 *
 * Shown for One PDF and Summary PDF when the deal has a checklist; ON unless a
 * saved "every export" choice says otherwise; sent to `exportEnhanced` as
 * `includeChecklist`. The checklist read is `window.api.checklists.get`, whose
 * success shape (`{ success, checklists: { checklists, requiredDone,
 * requiredTotal } }`) is the one tests/setup.js and checklistService read.
 */

import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import type { Transaction } from "../../../electron/types/models";

const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;
const prefsGetMock = window.api.preferences.get as jest.Mock;
const prefsUpdateMock = window.api.preferences.update as jest.Mock;
const updateMock = window.api.transactions.update as jest.Mock;
const checklistsGetMock = window.api.checklists.get as jest.Mock;

const exportFolderMock = jest.fn();
(window.api.transactions as unknown as { exportFolder: jest.Mock }).exportFolder = exportFolderMock;
(window.api as unknown as { onExportFolderProgress: jest.Mock }).onExportFolderProgress = jest.fn(
  () => () => {},
);

const TX = "tx-3767";
const USER = "user-3767";

const transaction = {
  id: TX,
  user_id: USER,
  status: "active",
  property_address: "1 Fixture Way",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

/** Saved before this option existed: no includeChecklist key. */
const SAVED = {
  defaultFormat: "combined-pdf",
  emailExportMode: "thread",
  contentType: "both",
  attachmentType: "none",
};

const ONE_CHECKLIST = {
  success: true,
  checklists: {
    checklists: [{ checklist: { id: "cl-1", isPrivate: false }, items: [], linksByItemId: {} }],
    requiredDone: 0,
    requiredTotal: 0,
  },
};
/** BACKLOG-3966: the deal's only checklist is the agent's private My items. */
const ONLY_PRIVATE = {
  success: true,
  checklists: {
    checklists: [{ checklist: { id: "cl-mine", isPrivate: true }, items: [], linksByItemId: {} }],
    requiredDone: 0,
    requiredTotal: 1,
  },
};
/** A template checklist next to the private one. */
const PRIVATE_AND_TEMPLATE = {
  success: true,
  checklists: {
    checklists: [
      { checklist: { id: "cl-mine", isPrivate: true }, items: [], linksByItemId: {} },
      { checklist: { id: "cl-1", isPrivate: false }, items: [], linksByItemId: {} },
    ],
    requiredDone: 0,
    requiredTotal: 1,
  },
};
const NO_CHECKLIST = {
  success: true,
  checklists: { checklists: [], requiredDone: 0, requiredTotal: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  exportFolderMock.mockResolvedValue({ success: true, path: "/out/audit" });
  exportEnhancedMock.mockResolvedValue({ success: true, filePath: "/out/audit.pdf" });
  prefsUpdateMock.mockResolvedValue({ success: true });
  prefsGetMock.mockResolvedValue({ success: true, preferences: { export: SAVED } });
  checklistsGetMock.mockResolvedValue(ONE_CHECKLIST);
});

function primaryButton(): HTMLElement {
  return screen.getAllByRole("button", { name: /^export$/i })[0];
}

async function openOptions(): Promise<void> {
  render(<ExportModal transaction={transaction} userId={USER} onClose={jest.fn()} onExportComplete={jest.fn()} />);
  await waitFor(() => expect(checklistsGetMock).toHaveBeenCalledWith({ transactionId: TX }));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("export-format-button"));
  });
  await screen.findByText("Export Options");
}

const checklistBox = () => screen.queryByRole("checkbox", { name: /Include checklist items/ });

async function exportNow(): Promise<void> {
  await act(async () => {
    fireEvent.click(primaryButton());
  });
}

it("C8a: shown and ON for One PDF when the deal has a checklist and the saved record has no key", async () => {
  await openOptions();
  const box = await screen.findByRole("checkbox", { name: /Include checklist items/ });
  expect(box).toBeChecked();
  await exportNow();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(exportEnhancedMock).toHaveBeenCalledWith(
    TX,
    expect.objectContaining({ exportFormat: "pdf", summaryOnly: false, includeChecklist: true }),
  );
});

it("C8b: a saved OFF choice is honoured and sent", async () => {
  prefsGetMock.mockResolvedValue({ success: true, preferences: { export: { ...SAVED, includeChecklist: false } } });
  await openOptions();
  const box = await screen.findByRole("checkbox", { name: /Include checklist items/ });
  expect(box).not.toBeChecked();
  await exportNow();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(exportEnhancedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ includeChecklist: false }));
});

it("C8c: hidden, and sent as false, when the deal has no checklist", async () => {
  checklistsGetMock.mockResolvedValue(NO_CHECKLIST);
  await openOptions();
  expect(checklistBox()).toBeNull();
  await exportNow();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(exportEnhancedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ includeChecklist: false }));
});

it("C8d: shown for Summary PDF, hidden for Audit Package (which never receives it)", async () => {
  await openOptions();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Summary PDF/ }));
  });
  expect(checklistBox()).not.toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Audit Package/ }));
  });
  expect(checklistBox()).toBeNull();
  await exportNow();
  await waitFor(() => expect(exportFolderMock).toHaveBeenCalledTimes(1));
  expect(exportFolderMock.mock.calls[0][1]).not.toHaveProperty("includeChecklist");
  expect(exportEnhancedMock).not.toHaveBeenCalled();
});

it("C8e: unticked and saved as the default, the choice is stored", async () => {
  await openOptions();
  await act(async () => {
    fireEvent.click(await screen.findByRole("checkbox", { name: /Include checklist items/ }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("checkbox", { name: /Use these options for every export/ }));
  });
  await exportNow();
  await waitFor(() => expect(prefsUpdateMock).toHaveBeenCalledTimes(1));
  expect(prefsUpdateMock).toHaveBeenCalledWith(USER, {
    export: expect.objectContaining({ includeChecklist: false }),
  });
  expect(exportEnhancedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ includeChecklist: false }));
});

it("C8f (BACKLOG-3966): hidden, and sent as false, when the deal's only checklist is private", async () => {
  checklistsGetMock.mockResolvedValue(ONLY_PRIVATE);
  await openOptions();
  expect(checklistBox()).toBeNull();
  await exportNow();
  await waitFor(() => expect(exportEnhancedMock).toHaveBeenCalledTimes(1));
  expect(exportEnhancedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ includeChecklist: false }));
});

it("C8g (BACKLOG-3966): shown when a template checklist sits next to the private one", async () => {
  checklistsGetMock.mockResolvedValue(PRIVATE_AND_TEMPLATE);
  await openOptions();
  expect(await screen.findByRole("checkbox", { name: /Include checklist items/ })).toBeChecked();
});
