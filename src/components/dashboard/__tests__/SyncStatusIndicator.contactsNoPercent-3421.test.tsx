/**
 * BACKLOG-3421 — the dashboard shows no percentage for a running contacts sync.
 *
 * The founder: "i honestly thing we we even don't do a % for the contacts its
 * fine since they are alwasy so fast". The orchestrator's contacts leg now
 * flags itself as having no honest percentage, and this file pins the surface
 * half of that — that the existing BACKLOG-3128 gate is what suppresses it, so
 * no renderer change was needed and none can be quietly undone.
 *
 * The distinguishing input is the last test: a running contacts item WITHOUT
 * the flag still shows its number, so a green result here cannot be an
 * indicator that has simply stopped rendering percentages.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
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
  extra: Partial<SyncItem> = {}
): SyncItem => ({
  type,
  status,
  progress: status === "complete" ? 100 : 0,
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

describe("BACKLOG-3421 — no percentage for contacts", () => {
  it("renders the pill and no number while contacts is running", () => {
    // The state the leg now publishes from its very first tick.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("contacts", "running", { progress: 0, indeterminate: true })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    // Silence would be its own dishonesty — the sync IS running.
    expect(screen.getByTestId("sync-pill-contacts")).toHaveTextContent("Contacts");
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
  });

  it("renders no number at the end of the leg either", () => {
    // The leg's last report is 100 with the flag still set. Read as a number it
    // would flash "100%" on an item that is still running.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [syncItem("contacts", "running", { progress: 100, indeterminate: true })],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("keeps the green tick when the leg finishes", () => {
    // No number is not the same as no outcome.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState(
        [
          syncItem("contacts", "complete", { indeterminate: true }),
          syncItem("emails", "running", { progress: 34, phase: "outlook-inbox" }),
        ],
        true
      )
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByTestId("sync-pill-contacts")).toHaveTextContent("Contacts");
    expect(screen.getByTestId("sync-pill-contacts").querySelector("svg")).toBeInTheDocument();
    // And the leg that DOES have a measured number still shows it.
    expect(screen.getByText("34%")).toBeInTheDocument();
  });

  it("CONTROL: a contacts item without the flag still renders its number", () => {
    // If the indicator had simply stopped rendering percentages for contacts,
    // every assertion above would pass for the wrong reason.
    mockUseSyncOrchestrator.mockReturnValue(
      orchestratorState([syncItem("contacts", "running", { progress: 50 })], true)
    );

    render(<SyncStatusIndicator />);

    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});
