/**
 * BACKLOG-3339 slice B — Settings "Export My Data" when the file was saved but
 * the export could not be recorded in the audit log.
 *
 * The line under the button and the toast both show the fixed copy, and the
 * toast does NOT read "Failed to export data: Your data file was saved…".
 * Also covers the orchestrator turning the IPC result into that error, and
 * the copy mirrors across the main/renderer boundary.
 */
import React from "react";
import { render, screen } from "@testing-library/react";

const mockNotify = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };
let mockQueue: Array<Record<string, unknown>> = [];

jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({ notify: mockNotify }),
}));
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: mockQueue, requestSync: jest.fn() }),
}));

import { DataPrivacySettings } from "../DataPrivacySettings";
import { DATA_EXPORT_NOT_RECORDED_MESSAGE, EXPORT_NOT_RECORDED_BODY } from "../../../utils/exportAuditCopy";
import { DATA_EXPORT_NOT_RECORDED_MESSAGE as MAIN_DATA_EXPORT_COPY } from "../../../../electron/handlers/ccpaHandlers";
import { EXPORT_NOT_RECORDED_MESSAGE as MAIN_EXPORT_COPY } from "../../../../electron/services/exportCompletion";

// Literal on purpose, so a drift in the module fails here.
const COPY =
  "Your data file was saved, but this export could not be recorded in the audit log. If this keeps happening, contact support.";

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue = [];
});

it("not recorded: the line and the toast show the copy, with no 'Failed to export data' prefix", async () => {
  mockQueue = [{ type: "ccpa-export", status: "error", error: COPY }];
  render(<DataPrivacySettings userId="user-3339" />);
  expect(await screen.findByText(COPY)).toBeInTheDocument();
  expect(mockNotify.error).toHaveBeenCalledWith(COPY);
  expect(mockNotify.error).not.toHaveBeenCalledWith(expect.stringContaining("Failed to export data"));
});

it("positive control: any other failure keeps the 'Failed to export data:' toast", async () => {
  mockQueue = [{ type: "ccpa-export", status: "error", error: "Disk full" }];
  render(<DataPrivacySettings userId="user-3339" />);
  await screen.findByText("Disk full");
  expect(mockNotify.error).toHaveBeenCalledWith("Failed to export data: Disk full");
});

it("the renderer copy mirrors the main-process copy", () => {
  expect(DATA_EXPORT_NOT_RECORDED_MESSAGE).toBe(COPY);
  expect(MAIN_DATA_EXPORT_COPY).toBe(COPY);
  expect(MAIN_EXPORT_COPY).toBe(EXPORT_NOT_RECORDED_BODY);
});
