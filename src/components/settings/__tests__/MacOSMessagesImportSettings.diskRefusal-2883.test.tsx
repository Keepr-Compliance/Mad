/**
 * BACKLOG-2883 — a disk-space REFUSAL is not shown as "Import failed".
 *
 * The guard exists to stop BEFORE a mid-write failure. Showing its refusal as
 * "Import failed" tells the user the thing it prevented has just happened. The
 * queue item's `errorKind` is set by the orchestrator from the main process's
 * typed `refusedForDiskSpace.phase` (see SyncOrchestratorService
 * .diskRefusal-2883.test.ts); these cases pin what the card does with it, and
 * that a genuine failure still says "failed".
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import type { SyncItem } from "../../../services/SyncOrchestratorService";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

let mockQueue: SyncItem[] = [];
const mockRequestSync = jest.fn();

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: mockQueue,
    requestSync: mockRequestSync,
    markCancelRequested: jest.fn(),
    getQueueItem: (type: string) => mockQueue.find((item) => item.type === type),
  })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  /**
   * BACKLOG-3208: the panel now asks whether Full Disk Access is usable before
   * it offers an import, through the same service abstraction it already uses
   * for preferences. Granted is this suite's premise — every case here is about
   * what the import does once Keepr CAN read Messages. The denied path has its
   * own suite (`MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`).
   */
  systemService: {
    checkMessagesPermission: jest
      .fn()
      .mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest
      .fn()
      .mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2883";

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue = [];
  mockUpdatePreferences.mockResolvedValue({ success: true });
  mockGetPreferences.mockResolvedValue({
    success: true,
    data: { messageImport: { filters: { lookbackMonths: 3, maxMessages: 50000 } } },
  });
});

const REFUSAL =
  "Keepr needs about 3 GB of free disk space to import your messages, but only 1.2 GB is actually available.";

function errored(extra: Partial<SyncItem>, error = REFUSAL): SyncItem[] {
  return [{ type: "messages", status: "error", progress: 0, error, ...extra } as SyncItem];
}

describe("BACKLOG-2883 — the settings card for a disk-space refusal", () => {
  it("does not say failed, says it did not start, and that nothing changed", async () => {
    mockQueue = errored({ errorKind: "disk_space_refused" });
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const result = await screen.findByTestId("import-result");
    expect(result).not.toHaveTextContent(/fail/i);
    expect(result).toHaveTextContent("Import did not start.");
    expect(result).toHaveTextContent(REFUSAL);
    expect(result).toHaveTextContent("Nothing was imported and nothing was changed.");
    expect(result.className).not.toMatch(/bg-red/);
  });

  it("classifies on errorKind, not the message: changed text is still a refusal", async () => {
    mockQueue = errored({ errorKind: "disk_space_refused" }, "Some other sentence entirely.");
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Import did not start.");
    expect(result).not.toHaveTextContent(/fail/i);
  });

  it("CONTROL: the same refusal sentence WITHOUT the kind still reads as a failure", async () => {
    // Proves the text alone never decides it — and that the failure branch is live.
    mockQueue = errored({});
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent(`Import failed: ${REFUSAL}`);
    expect(result).not.toHaveTextContent("Nothing was imported and nothing was changed.");
  });

  it("a genuine failure still says failed", async () => {
    mockQueue = errored({}, "database is locked");
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Import failed: database is locked");
    expect(result.className).toMatch(/bg-red/);
  });
});
