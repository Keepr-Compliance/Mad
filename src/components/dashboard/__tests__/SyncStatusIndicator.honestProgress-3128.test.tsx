/**
 * BACKLOG-3128 — the dashboard must not invent a number for the macOS Messages
 * import, and must not publish raw internal phase identifiers.
 *
 * TWO defects on this surface.
 *
 *   1. THE PILL. `renderPill`'s phase record lists iPhone phases only
 *      (`backing_up`, `preparing`, `extracting`, `storing`, `complete`), and
 *      falls back to `?? phase`. Every macOS Messages phase missed it, so the
 *      dashboard rendered the internal string — "Messages - querying".
 *
 *   2. THE PERCENT — and this is the one that needed care. The messages item is
 *      now `indeterminate`, and the plan's first form of it carried
 *      `progress: 0`. The indicator read:
 *
 *          const activeProgress = runningInternalItem?.progress ?? null;
 *
 *      `??` catches only null/undefined. `0 ?? null` is `0`, so the
 *      `activeProgress !== null` guard passes and the indicator renders
 *      `{Math.round(0)}%` — a hard "0%" pinned on the dashboard for the entire
 *      import. That is strictly worse than the composite it replaced, because
 *      it does not even move, and it is precisely the fabricated known value
 *      BACKLOG-2886 forbids. The fix gates on the FLAG, never on the number.
 *
 * CONTROL for defect 2: restore `SyncStatusIndicator.tsx` to
 * `runningInternalItem?.progress ?? null` and "renders no percentage while the
 * messages import is running" goes red with "0%" on screen. That mutation is
 * the whole reason this file exists — an assertion that cannot be made to fail
 * is not a control.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncStatusIndicator } from "../SyncStatusIndicator";
import type { SyncItem, SyncType } from "../../../services/SyncOrchestratorService";
// BACKLOG-3132: derived from the published tuple, not hand-written — a new
// phase must be exercised here without anyone remembering to add it.
import { IMPORT_PHASES } from "../../../../electron/types/ipc/importPhase";
import { IMPORT_PHASE_DISPLAY } from "../../../utils/importPhaseDisplay";

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
  extra: Partial<SyncItem> = {}
): SyncItem => ({
  type,
  status,
  progress: status === "complete" ? 100 : 50,
  ...extra,
});

const orchestratorState = (queue: SyncItem[], isRunning: boolean) => ({
  state: {
    isRunning,
    queue,
    currentSync: queue.find((i) => i.status === "running")?.type ?? null,
    overallProgress: 0,
    pendingRequest: null,
    externalCancelCount: 0,
  },
  isRunning,
  queue,
  currentSync: queue.find((i) => i.status === "running")?.type ?? null,
  overallProgress: 0,
  pendingRequest: null,
  externalCancelCount: 0,
  requestSync: jest.fn(),
  forceSync: jest.fn(),
  acceptPending: jest.fn(),
  rejectPending: jest.fn(),
  cancel: jest.fn(),
  markCancelRequested: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAllowed.mockReturnValue(true);
});

describe("BACKLOG-3128 — no fabricated percentage for the messages import", () => {
  /**
   * CONTROL (e). The mutation: `?? null` instead of the indeterminate gate.
   * Because the item carries `progress: 0`, that mutation renders "0%" here.
   */
  it("renders no percentage while the messages import is running", () => {
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [
          syncItem("messages", "running", {
            phase: "querying",
            progress: 0,
            indeterminate: true,
          }),
        ],
        true
      )
    );

    render(<SyncStatusIndicator />);

    // The pill itself must still render — removing the number must not remove
    // the row. Silence would be its own dishonesty: the import IS running.
    expect(screen.getByTestId("sync-pill-messages")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
  });

  it("renders no percentage for the item the listener ACTUALLY emits mid-import", () => {
    // TRANSCRIBED FROM THE PRODUCER, not invented — and this is the assertion
    // whose absence let a "0%" ship.
    //
    // Every other fixture in this file passes `indeterminate: true`, a state the
    // orchestrator's listener reached at most once per run (the first querying
    // event, before any total was known). So the whole suite described a state
    // the producer barely produces. During a counted phase the listener's first
    // form emitted `indeterminate: false` with real counts, `activeProgress`
    // resolved to `progress` — 0 — and the dashboard pinned a hard "0%".
    //
    // This item is what `macOSMessagesImportService.ts:1756` (per-batch importing
    // progress) becomes by the time it reaches the queue.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [
          syncItem("messages", "running", {
            phase: "importing",
            progress: 0,
            current: 4120,
            total: 33637,
            indeterminate: true,
          }),
        ],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-messages")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("still shows a percentage for a sync that HAS an honest one", () => {
    // The distinguishing input. Without this, the assertion above would pass on
    // an indicator that had simply stopped rendering percentages for everyone.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("emails", "running", { progress: 42 })], true)
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("shows no percentage even when the indeterminate item carries a stale number", () => {
    // `progress` is not cleared, only ignored. A consumer that read the number
    // rather than the flag would render "73%" here.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [
          syncItem("messages", "running", {
            phase: "importing",
            progress: 73,
            indeterminate: true,
          }),
        ],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.queryByText("73%")).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3128 — the pill names the phase, not its identifier", () => {
  it.each(
    IMPORT_PHASES.map(
      (p) => [p, `Messages - ${IMPORT_PHASE_DISPLAY[p].pill}`] as const
    )
  )("renders %s as its label", (phase, expected) => {
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("messages", "running", { phase, indeterminate: true })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-messages")).toHaveTextContent(expected);
    // The raw identifier must not survive anywhere in the pill.
    expect(screen.getByTestId("sync-pill-messages")).not.toHaveTextContent(
      `Messages - ${phase}`
    );
  });

  it("leaves the iPhone vocabulary alone — two unions, two maps", () => {
    // The map is chosen by item type. Merging the two vocabularies into one
    // string-keyed record would recreate exactly the untyped lookup this item
    // replaced, so the iPhone phases must keep resolving through their own.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("iphone", "running", { phase: "extracting", external: true })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-iphone")).toHaveTextContent(
      "iPhone - Reading messages"
    );
  });
});
