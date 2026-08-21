/**
 * BACKLOG-2748 — the Cancel control on the import progress surface.
 *
 * The defect was an absence: `MacOSMessagesImportSettings` rendered a progress
 * bar and nothing else while an import ran, so the founder's only exit from a
 * 707,842-message run was to kill the app. `window.api.messages.cancelImport`
 * had existed since TASK-1710 with zero callers.
 *
 * What these tests hold:
 *
 *   - The button exists WHILE the import runs and at no other time. It lives
 *     inside the `isImporting` block, so this is structural, but "structural"
 *     is a claim about code and this is the assertion about behaviour.
 *   - Pressing it reaches the main process — and does NOT cancel the
 *     orchestrator queue, which would abandon the in-flight import while the UI
 *     went idle and the main process kept importing.
 *   - The result copy after a cancelled run reports the PARTIAL count the
 *     import actually kept, not the number it was aiming at.
 *
 * Rendered in StrictMode, matching the app and the rest of this suite.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import type { SyncItem } from "../../../services/SyncOrchestratorService";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

const mockRequestSync = jest.fn();
let mockQueue: SyncItem[] = [];
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: mockQueue, requestSync: mockRequestSync })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2748";

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/** A queue holding one macOS-messages item in the given state. */
function messagesQueue(item: Partial<SyncItem>): SyncItem[] {
  return [{ type: "messages", status: "running", progress: 0, ...item } as SyncItem];
}

const cancelButton = () => screen.queryByTestId("cancel-import");

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue = [];
  mockRequestSync.mockReset();
  mockUpdatePreferences.mockResolvedValue({ success: true });
  mockGetPreferences.mockResolvedValue({
    success: true,
    data: { messageImport: { filters: { lookbackMonths: 3, maxMessages: 50000 } } },
  });
});

describe("BACKLOG-2748 — the Cancel control's lifecycle", () => {
  it("renders while the import is running", async () => {
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    expect(cancelButton()).toHaveTextContent("Cancel import");
  });

  it("renders while the import is still pending in the queue", async () => {
    // 'pending' also reads as importing to this panel (the run is committed;
    // it just has not reached the front of the queue), so the escape hatch has
    // to be there too — otherwise there is a window with no way out.
    mockQueue = messagesQueue({ status: "pending", progress: 0 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
  });

  it("renders during a force re-import's delete phase — the other entry button's run", async () => {
    // "Import Messages" and "Force Re-import" are two buttons but ONE queue
    // item, so the control is shared by construction. The force path is still
    // worth its own row because it has a phase the plain import never shows,
    // and the phase drives the progress block the button lives in.
    //
    // Honest limit, documented rather than papered over: the main-side delete
    // loop (`clearMacOSMessages`) has no abort check, so a cancel pressed here
    // takes effect at the query-phase check that follows the delete rather than
    // immediately. The button is present and says "Cancelling..." throughout.
    mockQueue = messagesQueue({ status: "running", progress: 15, phase: "deleting" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    expect(screen.getByText(/Clearing existing messages/i)).toBeInTheDocument();
  });

  it("renders during the attachment phase — the expensive one", async () => {
    // The phase the founder was stuck in, and the one where cancelling actually
    // saves disk: the service honours the abort between individual file copies
    // (pinned main-side by macOSMessagesImportService.cancel-2748.test.ts).
    mockQueue = messagesQueue({ status: "running", progress: 80, phase: "attachments" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    expect(screen.getByText(/Processing attachments/i)).toBeInTheDocument();
  });

  it("does NOT render when no import is running", async () => {
    mockQueue = [];

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("macos-messages-import")).toBeInTheDocument());
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it("does NOT render once the import has completed", async () => {
    mockQueue = messagesQueue({ status: "complete", progress: 100, importedCount: 500 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("import-result")).toBeInTheDocument());
    expect(cancelButton()).not.toBeInTheDocument();
  });

  it("does NOT render after an import error", async () => {
    mockQueue = messagesQueue({ status: "error", progress: 20, error: "Import failed" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("import-result")).toBeInTheDocument());
    expect(cancelButton()).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2748 — pressing Cancel", () => {
  it("sends the cancel to the main process and reports that it is cancelling", async () => {
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(window.api.messages.cancelImport).toHaveBeenCalledTimes(1);

    // The main process honours the cancel at the next batch/attachment boundary,
    // so there IS a wait. The button says so instead of appearing dead, and
    // cannot be pressed a second time.
    await waitFor(() => expect(cancelButton()).toHaveTextContent("Cancelling..."));
    expect(cancelButton()).toBeDisabled();
  });

  it("does not abandon the in-flight import by cancelling the orchestrator queue", async () => {
    // `syncOrchestrator.cancel()` empties the queue and drops the awaited
    // import on the floor: the UI would go idle while the main process kept
    // importing — the exact failure the founder could not distinguish from a
    // working cancel. Only the main-process IPC may be sent from here.
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(window.api.messages.cancelImport).toHaveBeenCalledTimes(1);
    expect(mockRequestSync).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-2748 — what the user is told afterwards", () => {
  it("reports the cancel with the PARTIAL count that was actually kept", async () => {
    // The orchestrator lands a cancelled run in 'complete' (a cancel is not an
    // error) carrying the real count from the main process.
    mockQueue = messagesQueue({
      status: "complete",
      progress: 100,
      importedCount: 12_431,
      cancelled: true,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Import cancelled");
    expect(result).toHaveTextContent("12,431");
    // Not the success wording — a stopped import is not a finished one.
    expect(result).not.toHaveTextContent("Successfully imported");
  });

  it("CONTROL: the same completion WITHOUT the cancel flag reads as a success", async () => {
    // Distinguishing input for the test above: if `cancelled` were dropped
    // anywhere between the service and this component, both tests would render
    // this same success copy and only this one would stay green.
    mockQueue = messagesQueue({
      status: "complete",
      progress: 100,
      importedCount: 12_431,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Successfully imported");
    expect(result).toHaveTextContent("12,431");
    expect(result).not.toHaveTextContent("Import cancelled");
  });

  it("a fresh import does not inherit the previous run's 'Cancelling...' state", async () => {
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    const { rerender } = renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    await user.click(cancelButton()!);
    await waitFor(() => expect(cancelButton()).toHaveTextContent("Cancelling..."));

    // The cancelled run finishes...
    mockQueue = messagesQueue({
      status: "complete",
      progress: 100,
      importedCount: 100,
      cancelled: true,
    });
    await act(async () => {
      rerender(
        <React.StrictMode>
          <MacOSMessagesImportSettings userId={USER_ID} />
        </React.StrictMode>
      );
    });

    // ...and the user starts another one.
    mockQueue = messagesQueue({ status: "running", progress: 5, phase: "importing" });
    await act(async () => {
      rerender(
        <React.StrictMode>
          <MacOSMessagesImportSettings userId={USER_ID} />
        </React.StrictMode>
      );
    });

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    expect(cancelButton()).toHaveTextContent("Cancel import");
    expect(cancelButton()).toBeEnabled();
  });
});
