/**
 * BACKLOG-2794 — the three things the dashboard said wrongly about an import.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DASHBOARD IS TESTED AT ALL FOR THE COUNT
 * ---------------------------------------------------------------------------
 * The Settings panel does not render the orchestrator's cap sentence — it
 * DELETES it (`stripStaleCapClause`), because the founder removed that sentence
 * from that surface (`fa2112c8`). The dashboard has no such strip: it renders
 * `item.warning` raw. That asymmetry is why the wrong figure survived PR #2345
 * and stayed on screen, and it is why the arithmetic has to be pinned at the
 * producer AND observed here, on the surface that actually shows it.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER TWO
 * ---------------------------------------------------------------------------
 * A leg cancelled while pending arrives `status: 'skipped'`, and a leg that met
 * an import already running arrives `complete` + `coalesced`. Neither is an
 * error, and the second must NOT be silent about the rest of the run: a
 * collision in the messages leg cannot suppress the card that reports contacts
 * and emails.
 *
 * Every suppression assertion is paired with the same transition minus the new
 * flag, which must still produce its old card — otherwise "no error card" would
 * be equally true of a component that had stopped rendering cards.
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
): SyncItem => ({ type, status, progress: status === "running" ? 50 : 100, ...extra });

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
  markCancelRequested: jest.fn(),
  getQueueItem: jest.fn(),
});

/** Drive the real running -> finished transition the completion card lives in. */
function finishSyncWith(finished: SyncItem[], running: SyncItem[]) {
  mockUseSyncOrchestrator.mockReturnValue(orchestratorState(running, true));
  const { rerender } = render(<SyncStatusIndicator onOpenSettings={jest.fn()} />);

  mockUseSyncOrchestrator.mockReturnValue(orchestratorState(finished, false));
  act(() => {
    rerender(<SyncStatusIndicator onOpenSettings={jest.fn()} />);
  });
}

/** The founder's restore, as the fixed orchestrator now words it. */
const RIGHT_SENTENCE = "645,576 messages excluded by import limit. Adjust in Settings.";
/** What it said before — window minus imported-this-run. */
const WRONG_FIGURE = "659,619";

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
  mockUseSyncOrchestrator.mockReturnValue(orchestratorState([], false));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2794 — the cap warning the dashboard renders", () => {
  it("shows the corrected figure, and not the one the founder was shown", () => {
    finishSyncWith(
      [syncItem("messages", "complete", { importedCount: 48_781, warning: RIGHT_SENTENCE })],
      [syncItem("messages", "running")],
    );

    const card = screen.getByTestId("sync-status-complete");
    expect(card).toHaveTextContent("645,576 messages excluded by import limit");
    // Named, because the dashboard renders `warning` verbatim: this assertion
    // is what ties this surface to the producer's arithmetic rather than to any
    // number that happens to arrive.
    expect(card).not.toHaveTextContent(WRONG_FIGURE);
  });

  it("shows no cap block at all when the orchestrator sent no warning", () => {
    // The zero line, at the surface: a run that excluded nothing says nothing.
    finishSyncWith(
      [syncItem("messages", "complete", { importedCount: 48_781 })],
      [syncItem("messages", "running")],
    );

    expect(screen.getByTestId("sync-status-complete")).not.toHaveTextContent(
      "excluded by import limit",
    );
  });
});

describe("BACKLOG-2794 — a leg cancelled while pending", () => {
  it("renders a skipped pill, not a green tick and not an error", () => {
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [
          syncItem("contacts", "running"),
          syncItem("messages", "skipped", { cancelled: true }),
        ],
        true,
      ),
    );
    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-messages")).toHaveTextContent("Messages - Skipped");
    // The header goes red on `hasError`; a skip is not a failure.
    expect(screen.queryByText("Sync Error:")).not.toBeInTheDocument();
  });

  it("gets no completion card — a cancel is a cancel whenever it was pressed", () => {
    finishSyncWith(
      [syncItem("contacts", "complete"), syncItem("messages", "skipped", { cancelled: true })],
      [syncItem("contacts", "running"), syncItem("messages", "pending")],
    );

    expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
  });

  it("CONTROL: the same run without the skip still shows the green card", () => {
    finishSyncWith(
      [syncItem("contacts", "complete"), syncItem("messages", "complete")],
      [syncItem("contacts", "running"), syncItem("messages", "pending")],
    );

    expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    expect(screen.getByText("Sync Complete")).toBeInTheDocument();
  });

  it("resolves the run when the skipped leg is the ONLY leg", () => {
    // 'skipped' has to be in the terminal set the transition tests, or a
    // single-leg run never finishes and the indicator holds a stale row.
    finishSyncWith(
      [syncItem("messages", "skipped", { cancelled: true })],
      [syncItem("messages", "pending")],
    );

    // Resolved AND silent: the cancel gate dismisses it rather than carding it.
    expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-status-indicator")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2794 — a leg that joined an import already running", () => {
  it("says so on the pill instead of claiming a green finish", () => {
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("emails", "running"), syncItem("messages", "complete", { coalesced: true })],
        true,
      ),
    );
    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-messages")).toHaveTextContent(
      "Messages - Already importing",
    );
    expect(screen.queryByText("Sync Error:")).not.toBeInTheDocument();
  });

  it("does not turn the run into 'Sync Completed with Errors'", () => {
    // The defect exactly: one collision escalated the whole run and offered a
    // support ticket for a sync in which everything worked.
    finishSyncWith(
      [
        syncItem("contacts", "complete"),
        syncItem("emails", "complete"),
        syncItem("messages", "complete", { coalesced: true }),
      ],
      [
        syncItem("contacts", "complete"),
        syncItem("emails", "running"),
        syncItem("messages", "pending"),
      ],
    );

    expect(screen.getByText("Sync Complete")).toBeInTheDocument();
    expect(screen.queryByText("Sync Completed with Errors")).not.toBeInTheDocument();
    expect(screen.queryByText(/submit a support ticket/)).not.toBeInTheDocument();
  });

  it("CONTROL: the same collision as a plain error still escalates", () => {
    // What the code did before, and what a genuine failure must still do — or
    // "no error card" would be a passing implementation of never reporting one.
    finishSyncWith(
      [
        syncItem("contacts", "complete"),
        syncItem("emails", "complete"),
        syncItem("messages", "error", { error: "Import already in progress" }),
      ],
      [
        syncItem("contacts", "complete"),
        syncItem("emails", "running"),
        syncItem("messages", "pending"),
      ],
    );

    expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
    expect(screen.getByText(/submit a support ticket/)).toBeInTheDocument();
  });

  it("still reports the legs that DID run — a collision is not a cancel", () => {
    // `cancelled` would suppress this card entirely (BACKLOG-2330/2748). The
    // contacts and emails legs really synced, and the user is entitled to know.
    finishSyncWith(
      [
        syncItem("contacts", "complete"),
        syncItem("messages", "complete", { coalesced: true }),
      ],
      [syncItem("contacts", "running"), syncItem("messages", "pending")],
    );

    expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    expect(screen.getByText("All data synced successfully")).toBeInTheDocument();
  });
});
