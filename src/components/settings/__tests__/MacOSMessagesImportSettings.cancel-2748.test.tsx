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

/**
 * BACKLOG-2776: subscribers to the fake orchestrator.
 *
 * The panel no longer keeps "cancelling" in component state — it reads
 * `cancelRequested` off the queue item, because the dashboard indicator renders
 * the same item and the two surfaces must not disagree. So the fake has to
 * behave like the real store: `markCancelRequested` sets the flag on the item
 * and notifies, exactly as `SyncOrchestratorService.markCancelRequested` does
 * (pinned against the real implementation in
 * `SyncOrchestratorService.cancel-2748.test.ts`). A fake that only recorded the
 * call would leave every assertion below about the label and the disabled state
 * passing over a component that never re-rendered.
 */
const queueListeners = new Set<() => void>();
const notifyQueueListeners = () => queueListeners.forEach((listener) => listener());

/**
 * BACKLOG-2794 kept this fake honest against the real method, which now has TWO
 * branches and a return value the panel routes on: a press on a RUNNING item is
 * an acknowledgement the caller must follow with the cancel IPC, and a press on
 * a PENDING one registers a skip and must NOT send it (there is nothing
 * importing, and `requestCancellation()` would arm a cancel for the next run to
 * start — BACKLOG-2776). A fake that returned nothing would make the panel's
 * branch untestable here. Pinned against the real implementation in
 * `SyncOrchestratorService.pendingCancel-2794.test.ts`.
 */
const mockMarkCancelRequested = jest.fn((type: string): 'running' | 'skipped' | 'none' => {
  const item = mockQueue.find((queued) => queued.type === type);
  if (!item || item.cancelRequested) return 'none';
  if (item.status !== "running" && item.status !== "pending") return 'none';
  mockQueue = mockQueue.map((queued) =>
    queued.type === type ? { ...queued, cancelRequested: true } : queued
  );
  notifyQueueListeners();
  return item.status === "pending" ? 'skipped' : 'running';
});

/**
 * BACKLOG-2794: the panel reads the item from LIVE orchestrator state to decide
 * whether the press meets a running import, because its own `queue` copy is one
 * render behind at the pending→running boundary. `mockQueue` IS the live store
 * in this fake, so reading it here is the same read.
 */
const mockGetQueueItem = jest.fn((type: string) =>
  mockQueue.find((queued) => queued.type === type)
);

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const react = require("react") as typeof React;
    const [, forceRender] = react.useReducer((n: number) => n + 1, 0);
    react.useEffect(() => {
      queueListeners.add(forceRender);
      return () => {
        queueListeners.delete(forceRender);
      };
    }, []);
    return {
      queue: mockQueue,
      requestSync: mockRequestSync,
      markCancelRequested: mockMarkCancelRequested,
      getQueueItem: mockGetQueueItem,
    };
  }),
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
  queueListeners.clear();
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

  it("renders while the import is only PENDING in the queue (BACKLOG-2794)", async () => {
    // THIS ROW ASSERTED THE OPPOSITE, and the reason it did is worth keeping.
    //
    // BACKLOG-2776 held cancels across the sub-second gap before a run takes
    // hold and deliberately did NOT extend that to 'pending', because a held
    // cancel expires (PENDING_CANCEL_TTL_MS) and this window runs for MINUTES:
    // the button would have sent a cancel that had lapsed by the time the
    // import began — a control the user presses that changes nothing.
    //
    // Both of those reasons are about the held-cancel MECHANISM, and
    // BACKLOG-2794 stops using it here. A pending press never reaches main: it
    // registers a skip on the orchestrator, which drops the leg when the queue
    // reaches it, so nothing can expire and nothing can fire late (the leg is
    // proved never to run in `SyncOrchestratorService.pendingCancel-2794.test.ts`).
    //
    // The window this closes is the founder's: a dashboard sync of
    // ['contacts','emails','messages'] leaves the messages item pending for the
    // whole contacts+emails run, with this panel showing "Preparing import..."
    // and, until now, no way out of it.
    mockQueue = messagesQueue({ status: "pending", progress: 0 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByText(/Preparing import/i)).toBeInTheDocument()
    );
    expect(cancelButton()).toBeInTheDocument();
  });

  it("presses through to a skip WITHOUT sending the cancel IPC (BACKLOG-2794)", async () => {
    // The half that makes the button honest. `requestCancellation()` ARMS a
    // cancel when nothing is importing, and the next run to start consumes it —
    // so sending the IPC from a pending press would leave a live cancel lying in
    // wait for an import the user never asked to stop.
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "pending", progress: 0 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(mockMarkCancelRequested).toHaveBeenCalledWith("messages");
    expect(window.api.messages.cancelImport).not.toHaveBeenCalled();
    // And the queue must not be emptied — that would abandon the whole sync,
    // contacts and emails included, over one leg the user declined.
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("CONTROL: the same press on a RUNNING item DOES send the IPC", async () => {
    // The distinguishing input for the row above: without it, "no IPC" would be
    // just as true of a panel that had stopped dispatching cancels at all.
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(window.api.messages.cancelImport).toHaveBeenCalledTimes(1);
  });

  it("reports a skipped leg as the cancel it was (BACKLOG-2794)", async () => {
    // The leg never ran, so there is no count to report and nothing failed. It
    // reuses the 2748 cancelled copy, which already reads correctly at zero.
    mockQueue = messagesQueue({ status: "skipped", progress: 100, cancelled: true });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Import cancelled");
    expect(result).not.toHaveTextContent("Successfully imported");
    expect(result).not.toHaveTextContent("Import failed");
    // Nothing was imported, so no count clause may appear.
    expect(result).not.toHaveTextContent("messages were imported before cancellation");
  });

  it("renders during a force re-import's delete phase — the other entry button's run", async () => {
    // "Import Messages" and "Force Re-import" are two buttons but ONE queue
    // item, so the control is shared by construction. The force path is still
    // worth its own row because it has a phase the plain import never shows,
    // and the phase drives the progress block the button lives in.
    //
    // BACKLOG-2775 removed this row's honest limit: the delete loop had no abort
    // check, so a cancel pressed here took effect only at the query-phase check
    // AFTER the whole delete had run and committed — 35 seconds and 162,961
    // deleted messages, in the founder's case. The loop now checks between
    // batches and the clear shares a transaction with the re-import, so a cancel
    // pressed in this phase stops it and restores everything.
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

    // BACKLOG-2776: the acknowledgement is renderer-side and lands in the same
    // tick as the click — no `waitFor`, because there is nothing to wait FOR.
    // The main process honours the cancel at the next batch/attachment boundary
    // (a 35-second clear phase, in the founder's case), and a button that stayed
    // "Cancel import" for that long is one the user presses again.
    expect(cancelButton()).toHaveTextContent("Cancelling — finishing current step…");
    expect(cancelButton()).toBeDisabled();
  });

  it("cannot be pressed a second time — one press is now enough", async () => {
    // This test asserted the OPPOSITE under BACKLOG-2748. The button was left
    // clickable because a cancel landing between the queue item turning
    // 'running' and the service setting `isImporting` was DROPPED, and a
    // disabled button would have stranded the user in "Cancelling..." for the
    // rest of a run nobody had cancelled.
    //
    // BACKLOG-2776 closed that gap in the service: a cancel with no run in
    // flight is held and consumed by the run that starts. A second press can
    // therefore add nothing, and offering one implies the first may not have
    // counted — which is what the founder inferred when he pressed twice.
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 2, phase: "querying" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton()!);

    // Still one: the disabled control swallowed the second press.
    expect(window.api.messages.cancelImport).toHaveBeenCalledTimes(1);
  });

  it("marks the queue item so every surface freezes, not just this panel", async () => {
    // The dashboard's SyncStatusIndicator renders the same item's percentage.
    // Keeping "cancelling" in this component's own state left that indicator
    // climbing while this panel said "Cancelling…" — two surfaces disagreeing
    // about whether the user had been heard.
    const user = userEvent.setup();
    mockQueue = messagesQueue({ status: "running", progress: 34, phase: "deleting" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(mockMarkCancelRequested).toHaveBeenCalledWith("messages");
  });

  it("does not claim to be cancelling when the IPC send throws", async () => {
    // The acknowledgement is only honest if something was actually dispatched.
    const user = userEvent.setup();
    (window.api.messages.cancelImport as jest.Mock).mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });
    mockQueue = messagesQueue({ status: "running", progress: 40, phase: "importing" });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());

    await user.click(cancelButton()!);

    expect(mockMarkCancelRequested).not.toHaveBeenCalled();
    expect(cancelButton()).toHaveTextContent("Cancel import");
    expect(cancelButton()).toBeEnabled();
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
    expect(cancelButton()).toHaveTextContent("Cancelling — finishing current step…");

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

describe("BACKLOG-2775 — what a cancelled FORCE re-import is allowed to say", () => {
  it("reports that nothing changed, not a count", async () => {
    // The sentence the founder needed and did not get. His run reported
    // "imported 0" while his 162,961 messages were gone; the force path is now
    // atomic, so a cancelled one really has changed nothing — and has to say so
    // plainly, because "Import cancelled. 0 messages were imported" is exactly
    // what a catastrophic run also looks like.
    mockQueue = messagesQueue({
      status: "complete",
      progress: 100,
      importedCount: 0,
      cancelled: true,
      rolledBack: true,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("Nothing changed");
    expect(result).toHaveTextContent(/existing messages are untouched/i);
    expect(result).not.toHaveTextContent("messages were imported before cancellation");
  });

  it("CONTROL: a cancelled DELTA import still reports its partial count", async () => {
    // The distinguishing input. If the copy keyed off `cancelled` alone, a user
    // who stopped a long delta import would be told nothing changed while 12,431
    // messages had in fact been imported and kept.
    mockQueue = messagesQueue({
      status: "complete",
      progress: 100,
      importedCount: 12_431,
      cancelled: true,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("12,431");
    expect(result).toHaveTextContent("messages were imported before cancellation");
    expect(result).not.toHaveTextContent("Nothing changed");
  });
});

describe("BACKLOG-2776 — the percentage the user is shown while cancelling", () => {
  it("renders the frozen percentage carried by the queue item", async () => {
    // The panel renders whatever `progress` the item holds; the freeze itself is
    // the orchestrator's job (proved in SyncOrchestratorService.cancel-2748.test.ts).
    // This is the other half of that contract: a cancel-requested item's number
    // is displayed as-is, so when the orchestrator stops advancing it the user
    // sees a still number rather than one climbing through their cancel.
    mockQueue = messagesQueue({
      status: "running",
      progress: 34,
      phase: "deleting",
      cancelRequested: true,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByText("34%")).toBeInTheDocument());
    // And the panel is already in its cancelling state without any click here —
    // the flag is the single source both surfaces read.
    expect(cancelButton()).toBeDisabled();
    expect(cancelButton()).toHaveTextContent("Cancelling — finishing current step…");
  });
});
