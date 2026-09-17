/**
 * BACKLOG-3421 — the emails pill names the download round, and never its
 * identifier.
 *
 * The emails leg now forwards the pre-cache producer's `stage` as the queue
 * item's `phase`: "outlook-inbox", "gmail-labels" and so on. Those are internal
 * identifiers, not copy. `renderPill`'s pre-existing `?? phase` fallback would
 * have put "Emails - outlook-inbox" on the dashboard — the same defect
 * BACKLOG-3128 fixed for "Messages - querying" — so the emails branch resolves
 * through `emailPrecacheStageDisplay` with NO raw fallback.
 *
 * "No phase" is the ordinary case here, not the exception: the boundary events,
 * the backfill sweep and both non-fetch phases (`repairing`, `swapping`) carry
 * no stage at all, and the percentage beside the pill keeps moving through them.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncStatusIndicator } from "../SyncStatusIndicator";
import type { SyncItem, SyncType } from "../../../services/SyncOrchestratorService";
// Derived from the published map, not hand-written: a round added later is
// exercised here without anyone remembering to add it.
import { EMAIL_PRECACHE_STAGE_DISPLAY } from "../../../utils/emailPrecacheStageDisplay";
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

describe("BACKLOG-3421 — the emails pill names the round", () => {
  it.each(
    Object.entries(EMAIL_PRECACHE_STAGE_DISPLAY).map(
      ([stage, display]) => [stage, `Emails - ${display.pill}`] as const
    )
  )("renders %s as its label", (stage, expected) => {
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("emails", "running", { phase: stage, progress: 21 })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-emails")).toHaveTextContent(expected);
    // The number is the point of the change; the label must not cost it.
    expect(screen.getByText("21%")).toBeInTheDocument();
  });

  it("renders no phase at all for a stage it has no copy for", () => {
    // CONTROL. The mutation this file exists for: restore `?? phase` to the
    // emails branch and this goes red with the raw identifier on screen. An
    // unknown stage reaches here from a newer main process; the pill must fall
    // back to nothing, never to another round's label.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("emails", "running", { phase: "outlook-drafts", progress: 60 })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    const pill = screen.getByTestId("sync-pill-emails");
    expect(pill).toHaveTextContent("Emails");
    expect(pill).not.toHaveTextContent("outlook-drafts");
    expect(pill).not.toHaveTextContent("-");
  });

  it("renders the bare label while the run is repairing or swapping", () => {
    // Those phases carry no stage, and the percent is what carries the progress
    // through them (5 for the repair pass, 95 for the swap).
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("emails", "running", { progress: 5 })], true)
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-emails")).toHaveTextContent("Emails");
    expect(screen.getByText("5%")).toBeInTheDocument();
  });

  it("does not borrow the emails vocabulary for another type", () => {
    // The distinguishing input: the branch is chosen by type, so a messages
    // item must still resolve through the messages map.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("messages", "running", { phase: "querying", indeterminate: true })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-messages")).toHaveTextContent(
      `Messages - ${IMPORT_PHASE_DISPLAY.querying.pill}`
    );
  });
});
