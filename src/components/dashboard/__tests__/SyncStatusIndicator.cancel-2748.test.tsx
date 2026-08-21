/**
 * BACKLOG-2748 — the dashboard must not congratulate the user on a run they
 * cancelled.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The import Cancel button made INTERNAL syncs cancellable for the first time.
 * A cancelled import does not empty the queue and is not an error — it lands
 * `status: 'complete'` carrying `cancelled: true` — so `completionVariant`,
 * which is derived from `hasError`/`hasPending` alone, resolved to 'success'
 * and rendered the green "Sync Complete / All data synced successfully" card.
 *
 * That is reachable in the founder's exact flow. Settings is a modal over a
 * live Dashboard, so `SyncStatusIndicator` is mounted throughout the import: he
 * presses Cancel, reads the honest "Import cancelled. N messages were imported
 * before cancellation." in the panel, closes the modal — and the card behind it
 * says the sync succeeded. Two surfaces, two answers, for one action.
 *
 * ---------------------------------------------------------------------------
 * WHAT RENDERS INSTEAD: NOTHING
 * ---------------------------------------------------------------------------
 * A user-initiated cancel gets no card. That is the established answer here for
 * external syncs (BACKLOG-2330/2333 — "Cancel = no card, no screen") and it is
 * the right one for the import: the panel the user pressed Cancel in already
 * reports the outcome WITH the real partial count, and a dashboard card could
 * only repeat it with less information — or contradict it.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 * Every test drives the real running -> finished transition by re-rendering
 * with a new orchestrator state, because the suppression lives in that
 * transition effect and a component rendered directly into the finished state
 * would never exercise it. Each suppression assertion is paired with the SAME
 * transition minus the `cancelled` flag, which must still produce the green
 * card — otherwise "no card" would be equally green for a component that had
 * stopped rendering completion cards at all.
 */

import { render, screen, act } from "@testing-library/react";
import { SyncStatusIndicator } from "../SyncStatusIndicator";
import type { SyncItem, SyncType } from "../../../services/SyncOrchestratorService";

const mockIsAllowed = jest.fn();
jest.mock("../../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));

const mockUseSyncOrchestrator = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => mockUseSyncOrchestrator(),
}));

const syncItem = (
  type: SyncType,
  status: SyncItem["status"],
  extra: Partial<SyncItem> = {},
): SyncItem => ({ type, status, progress: status === "complete" ? 100 : 50, ...extra });

const orchestratorState = (queue: SyncItem[], isRunning: boolean, externalCancelCount = 0) => ({
  state: {
    isRunning,
    queue,
    currentSync: queue.find((i) => i.status === "running")?.type ?? null,
    overallProgress: 0,
    pendingRequest: null,
    externalCancelCount,
  },
  isRunning,
  queue,
  currentSync: queue.find((i) => i.status === "running")?.type ?? null,
  overallProgress: 0,
  pendingRequest: null,
  externalCancelCount,
  requestSync: jest.fn(),
  forceSync: jest.fn(),
  acceptPending: jest.fn(),
  rejectPending: jest.fn(),
  cancel: jest.fn(),
});

/**
 * Run the real running -> finished transition and return whether the
 * completion card rendered.
 */
function finishSyncWith(finished: SyncItem[], running: SyncItem[]): boolean {
  mockUseSyncOrchestrator.mockReturnValue(orchestratorState(running, true));
  const { rerender } = render(<SyncStatusIndicator />);

  mockUseSyncOrchestrator.mockReturnValue(orchestratorState(finished, false));
  act(() => {
    rerender(<SyncStatusIndicator />);
  });

  return screen.queryByTestId("sync-status-complete") !== null;
}

/** The exact queue item PR #2332 produces for a cancelled import. */
const CANCELLED_MESSAGES = syncItem("messages", "complete", {
  importedCount: 12_431,
  cancelled: true,
});
/** The same item for an import that ran to the end. */
const FINISHED_MESSAGES = syncItem("messages", "complete", { importedCount: 12_431 });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
  mockUseSyncOrchestrator.mockReturnValue(orchestratorState([], false));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2748 — a cancelled import gets no completion card", () => {
  it("renders NO card when the messages import was cancelled", () => {
    const shown = finishSyncWith([CANCELLED_MESSAGES], [syncItem("messages", "running")]);

    expect(shown).toBe(false);
    expect(screen.queryByText("Sync Complete")).not.toBeInTheDocument();
    expect(screen.queryByText("All data synced successfully")).not.toBeInTheDocument();
  });

  it("CONTROL: the SAME transition without the cancel flag still shows the green card", () => {
    // The distinguishing input. Without this, "no card" would be just as green
    // for a component that had stopped rendering completion cards entirely.
    const shown = finishSyncWith([FINISHED_MESSAGES], [syncItem("messages", "running")]);

    expect(shown).toBe(true);
    expect(screen.getByText("Sync Complete")).toBeInTheDocument();
    expect(screen.getByText("All data synced successfully")).toBeInTheDocument();
  });

  it("suppresses the card when a cancelled import finishes alongside other syncs", () => {
    // The founder's dashboard path: a full sync of contacts + emails + messages
    // where he cancels the messages leg. The other legs genuinely succeeded, but
    // the run as a whole is not something to congratulate him on — and the
    // cancel is visible on the queue while the others are still running, which
    // is the case the ref has to catch mid-sync rather than at the transition.
    const shown = finishSyncWith(
      [syncItem("contacts", "complete"), syncItem("emails", "complete"), CANCELLED_MESSAGES],
      [syncItem("contacts", "complete"), syncItem("emails", "running"), CANCELLED_MESSAGES],
    );

    expect(shown).toBe(false);
  });

  it("CONTROL: the same multi-sync run with no cancel shows the card", () => {
    const shown = finishSyncWith(
      [syncItem("contacts", "complete"), syncItem("emails", "complete"), FINISHED_MESSAGES],
      [syncItem("contacts", "complete"), syncItem("emails", "running"), FINISHED_MESSAGES],
    );

    expect(shown).toBe(true);
  });

  it("an error in the same run still shows the amber card — a cancel must not mask a failure", () => {
    // The suppression is keyed on `cancelled` alone, so it could plausibly
    // swallow a real failure that happened in the same run. A cancelled import
    // beside a failed email sync must still tell the user email failed.
    //
    // This row FAILED on the first cut of the fix and was the reason for its
    // second half. The suppression originally returned before the run's errors
    // were scanned, so a cancel silenced the error card too: the user cancelled
    // an import and lost the notice that his email connection had expired,
    // along with the "Reconnect" CTA (BACKLOG-2127). The queue is now scanned
    // once BEFORE the gate, and the gate refuses to fire over an error.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("emails", "running"), syncItem("messages", "running")], true),
    );
    const { rerender } = render(<SyncStatusIndicator />);

    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("emails", "error", { error: "Outlook connection expired" }), CANCELLED_MESSAGES],
        false,
      ),
    );
    act(() => {
      rerender(<SyncStatusIndicator />);
    });

    expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
  });

  it("an EXTERNAL cancel does not mask a failure either (2330 path, behaviour changed by 2748)", () => {
    // Written by SR review of PR #2332 and added verbatim in shape.
    //
    // The "never suppress over an error" condition was applied to the 2330
    // EXTERNAL-cancel path as well as the new internal one — a deliberate change
    // to pre-existing behaviour, ratified on measurement: before it, an external
    // cancel during a run whose emails leg had failed produced SILENCE; now it
    // renders "Sync Completed with Errors / Outlook connection expired".
    //
    // That half was unpinned. Row 165 above is an INTERNAL cancel, and the four
    // pre-existing 2330 rows are external cancels with NO error, so dropping the
    // error guard redded only via the internal row — a future edit to the shared
    // gate could have silently reverted the external behaviour with nothing going
    // red. The external shape is genuinely distinct: the queue is EMPTIED by
    // removeExternalSync and the counter is bumped, so the error is recorded in
    // the syncing branch rather than by the completion scan.
    const err = syncItem("emails", "error", {
      progress: 0,
      error: "Outlook connection expired",
      reconnectProvider: "microsoft",
    });
    const iphone = syncItem("iphone", "running", { progress: 10, external: true });

    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("emails", "running"), iphone], true, 0),
    );
    const { rerender } = render(<SyncStatusIndicator />);

    // emails fails while the external sync is still going
    mockUseSyncOrchestrator.mockReturnValue(orchestratorState([err, iphone], true, 0));
    act(() => {
      rerender(<SyncStatusIndicator />);
    });

    // user cancels the external sync: item removed, counter bumped, run ends
    mockUseSyncOrchestrator.mockReturnValue(orchestratorState([err], false, 1));
    act(() => {
      rerender(<SyncStatusIndicator />);
    });

    expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
    expect(screen.getByText("Outlook connection expired")).toBeInTheDocument();
  });

  it("a cancel does not suppress the NEXT run's completion card", () => {
    // The flag belongs to the run it stopped. If it leaked, one cancelled
    // import would silence the dashboard for the rest of the session.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("messages", "running")], true),
    );
    const { rerender } = render(<SyncStatusIndicator />);

    // Run 1: cancelled -> no card.
    mockUseSyncOrchestrator.mockReturnValue(orchestratorState([CANCELLED_MESSAGES], false));
    act(() => {
      rerender(<SyncStatusIndicator />);
    });
    expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();

    // Run 2: a fresh import, started and finished normally.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("messages", "running")], true),
    );
    act(() => {
      rerender(<SyncStatusIndicator />);
    });
    mockUseSyncOrchestrator.mockReturnValue(orchestratorState([FINISHED_MESSAGES], false));
    act(() => {
      rerender(<SyncStatusIndicator />);
    });

    expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    expect(screen.getByText("Sync Complete")).toBeInTheDocument();
  });
});
