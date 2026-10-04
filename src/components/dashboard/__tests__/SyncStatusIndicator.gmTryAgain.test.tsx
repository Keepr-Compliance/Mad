/**
 * Founder (2026-10-04): a failed Google Messages Sync gets "Try again" on the
 * dashboard's sync bubble — the same retry as the page's (only after a failed
 * Sync; the chats it saved are skipped; Keepr opens Messages for the job).
 *
 * Mutations (each turns a test red): the button shown for another source's
 * error, or missing for Google Messages; the click not calling the retry; a
 * refused retry not said.
 */
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncStatusIndicator } from "../SyncStatusIndicator";
import type { SyncItem, SyncType } from "../../../services/SyncOrchestratorService";

jest.mock("../../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true, features: {}, loading: false, refresh: jest.fn() }),
}));

const mockUseSyncOrchestrator = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => mockUseSyncOrchestrator(),
}));

const mockRetry = jest.fn();
jest.mock("../../../services/rcsImportService", () => ({
  rcsImportService: { retryCacheJob: () => mockRetry() },
}));

const item = (type: SyncType, status: SyncItem["status"], extra: Partial<SyncItem> = {}): SyncItem => ({
  type, status, progress: status === "running" ? 50 : 100, ...extra,
});
const state = (queue: SyncItem[], isRunning: boolean) => ({
  state: { isRunning, queue, currentSync: null, overallProgress: 0, pendingRequest: null, externalCancelCount: 0 },
  isRunning, queue, currentSync: null, overallProgress: 0, pendingRequest: null, externalCancelCount: 0,
  requestSync: jest.fn(), forceSync: jest.fn(), acceptPending: jest.fn(), rejectPending: jest.fn(),
  cancel: jest.fn(), markCancelRequested: jest.fn(), getQueueItem: jest.fn(),
});

function finish(type: SyncType, error: string) {
  mockUseSyncOrchestrator.mockReturnValue(state([item(type, "running")], true));
  const { rerender } = render(<SyncStatusIndicator />);
  mockUseSyncOrchestrator.mockReturnValue(state([item(type, "error", { error })], false));
  act(() => {
    rerender(<SyncStatusIndicator />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe("the sync bubble's Try again (Google Messages)", () => {
  it("a failed Google Messages Sync: Try again starts the retry, the bubble closes", async () => {
    mockRetry.mockResolvedValue({ success: true, data: { jobId: "job-2" } });
    finish("google-messages", "Keepr closed or restarted.");
    expect(screen.getByTestId("sync-status-complete")).toHaveTextContent("Keepr closed or restarted.");
    fireEvent.click(screen.getByTestId("sync-gm-try-again"));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("sync-status-complete")).toBeNull();
  });

  it("a refused retry says why", async () => {
    mockRetry.mockResolvedValue({ success: false, error: "There is no failed Sync to try again." });
    finish("google-messages", "Keepr closed or restarted.");
    fireEvent.click(screen.getByTestId("sync-gm-try-again"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("sync-gm-retry-error")).toHaveTextContent("There is no failed Sync to try again.");
  });

  it("another source's error: no Try again", () => {
    finish("emails", "Outlook connection expired");
    expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-gm-try-again")).toBeNull();
  });
});
