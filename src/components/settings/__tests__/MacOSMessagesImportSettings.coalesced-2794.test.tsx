/**
 * BACKLOG-2794 — what the Settings panel says when the import it asked for was
 * already running.
 *
 * `macOSMessagesImportService` serializes to one import at a time. The second
 * caller is refused, and since PR #2343 promoted the transaction trigger, the
 * second caller is routinely the user: create a deal, then press Import (or
 * Sync from the dashboard) while the trigger's run is still going.
 *
 * The queue item comes back `complete` with `coalesced: true` and an imported
 * count of zero — because this request imported nothing; the run that owns the
 * service is doing the work. Routed through the success branch, that would read
 * "Successfully imported 0 new messages", which is the sentence a user gets for
 * an import that found nothing new. Two very different facts, one sentence.
 *
 * The recommended answer from the plan (OQ-3, non-blocking, unanswered by the
 * founder at time of writing): say that the request joined a run in flight.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2794";

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

describe("BACKLOG-2794 — a request that joined an import already running", () => {
  it("says the request joined a run, not that it imported nothing", async () => {
    mockQueue = [
      { type: "messages", status: "complete", progress: 100, coalesced: true } as SyncItem,
    ];

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("An import is already running");
    // The sentence the success branch would have produced. Named, because the
    // coalesced branch has to sit AHEAD of it: the item carries success-shaped
    // fields and would otherwise fall straight through.
    expect(result).not.toHaveTextContent("Successfully imported");
    expect(result).not.toHaveTextContent("Import failed");
    expect(result).not.toHaveTextContent("Import cancelled");
  });

  it("promises no coverage for a run that did not happen", async () => {
    // `lastCoverage` describes what the run was CONSENTED to. A coalesced
    // request ran nothing, so "Your store now covers N for this period" would
    // be a claim about a different run's outcome.
    mockQueue = [
      { type: "messages", status: "complete", progress: 100, coalesced: true } as SyncItem,
    ];

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await screen.findByTestId("import-result");
    expect(screen.queryByTestId("import-coverage")).not.toBeInTheDocument();
  });

  it("CONTROL: the same completion without the flag still reads as a success", async () => {
    // The distinguishing input. Without it, "not Successfully imported" would be
    // just as true of a panel that had stopped reporting successes.
    mockQueue = [
      {
        type: "messages",
        status: "complete",
        progress: 100,
        importedCount: 1_204,
      } as SyncItem,
    ];

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Successfully imported");
    expect(result).toHaveTextContent("1,204");
    expect(result).not.toHaveTextContent("An import is already running");
  });

  it("re-enables the controls — this panel is not the one importing", async () => {
    // A coalesced item is terminal, so the panel must not sit disabled behind a
    // run it is not driving.
    mockQueue = [
      { type: "messages", status: "complete", progress: 100, coalesced: true } as SyncItem,
    ];

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import Messages" })).toBeEnabled()
    );
  });
});
