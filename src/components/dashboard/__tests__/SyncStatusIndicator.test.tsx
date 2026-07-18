/**
 * SyncStatusIndicator Tests
 *
 * TASK-1785: Tests for sync progress indicators on Dashboard
 * TASK-2119: Updated to render iPhone from orchestrator queue (no more iPhone-specific props)
 *
 * Key test cases:
 * 1. Progress shows for ALL users (not gated by license)
 * 2. AI-specific features (pending count, Review Now) only show with ai_detection feature
 * 3. Pills display in queue order
 * 4. Error state shows red pill with tooltip
 * 5. iPhone renders as a standard queue pill
 * 6. "Details" link dispatches via onViewSyncDetails
 */

import { render, screen, fireEvent, act } from "@testing-library/react";
import { SyncStatusIndicator } from "../SyncStatusIndicator";
import type { SyncItem, SyncType } from "../../../services/SyncOrchestratorService";

// Mock the useFeatureGate hook (TASK-2159: migrated from useLicense)
const mockIsAllowed = jest.fn();
jest.mock("../../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));

// Mock the useSyncOrchestrator hook
const mockUseSyncOrchestrator = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => mockUseSyncOrchestrator(),
}));

// Helper to create SyncItem
const createSyncItem = (
  type: SyncType,
  status: 'pending' | 'running' | 'complete' | 'error' = 'pending',
  progress = 0,
  error?: string,
  external?: boolean,
  phase?: string,
): SyncItem => ({
  type,
  status,
  progress,
  error,
  external,
  phase,
});

// Helper to create orchestrator state
const createOrchestratorState = (
  queue: SyncItem[] = [],
  isRunning = false,
  overallProgress = 0
) => ({
  state: {
    isRunning,
    queue,
    currentSync: queue.find(item => item.status === 'running')?.type ?? null,
    overallProgress,
    pendingRequest: null,
  },
  isRunning,
  queue,
  currentSync: queue.find(item => item.status === 'running')?.type ?? null,
  overallProgress,
  pendingRequest: null,
  requestSync: jest.fn(),
  forceSync: jest.fn(),
  acceptPending: jest.fn(),
  rejectPending: jest.fn(),
  cancel: jest.fn(),
});

describe("SyncStatusIndicator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Default: no AI add-on (ai_detection not allowed)
    mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
    // Default: empty queue (not running)
    mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("Progress visibility for ALL users", () => {
    it("should render sync progress indicator when syncing (no AI add-on)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Set up orchestrator with messages running
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('messages', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 75));

      render(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
      expect(screen.getByText("Syncing:")).toBeInTheDocument();
      expect(screen.getByText("50%")).toBeInTheDocument();
    });

    it("should render sync progress indicator when syncing (with AI add-on)", () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed including ai_detection
      // Set up orchestrator with messages running
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'complete', 100),
        createSyncItem('messages', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 83));

      render(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
      expect(screen.getByText("Syncing:")).toBeInTheDocument();
    });

    it("should not render when not syncing and queue is empty", () => {
      // Default mock is already empty and not running
      render(<SyncStatusIndicator />);

      expect(screen.queryByTestId("sync-status-indicator")).not.toBeInTheDocument();
    });
  });

  describe("Queue order rendering", () => {
    it("should render pills in queue order", () => {
      // Queue order: messages first, then contacts, then emails
      const queue = [
        createSyncItem('messages', 'running', 30),
        createSyncItem('contacts', 'pending', 0),
        createSyncItem('emails', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 10));

      render(<SyncStatusIndicator />);

      const pills = screen.getAllByText(/Messages|Contacts|Emails/);
      expect(pills[0]).toHaveTextContent("Messages");
      expect(pills[1]).toHaveTextContent("Contacts");
      expect(pills[2]).toHaveTextContent("Emails");
    });

    it("should only show pills for items in queue", () => {
      // Queue only has contacts and messages (no emails)
      const queue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('messages', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 25));

      render(<SyncStatusIndicator />);

      expect(screen.getByText("Contacts")).toBeInTheDocument();
      expect(screen.getByText("Messages")).toBeInTheDocument();
      expect(screen.queryByText("Emails")).not.toBeInTheDocument();
    });
  });

  describe("Status colors", () => {
    it("should show pending pills with gray styling", () => {
      const queue = [
        createSyncItem('contacts', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 0));

      render(<SyncStatusIndicator />);

      const pill = screen.getByText("Contacts");
      expect(pill).toHaveClass("bg-gray-100", "text-gray-500");
    });

    it("should show running pills with blue styling", () => {
      const queue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 50));

      render(<SyncStatusIndicator />);

      const pill = screen.getByText("Contacts");
      expect(pill).toHaveClass("bg-blue-100", "text-blue-700");
    });

    it("should show complete pills with green styling and checkmark", () => {
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('messages', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 75));

      render(<SyncStatusIndicator />);

      const pill = screen.getByText("Contacts").closest("span");
      expect(pill).toHaveClass("bg-green-100", "text-green-700");
      // Should have a checkmark SVG
      const svg = pill?.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    it("should show error pills with red styling and X icon", () => {
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'running', 50),
        createSyncItem('messages', 'error', 0, 'Database connection failed'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 50));

      render(<SyncStatusIndicator />);

      const pill = screen.getByText("Messages").closest("span");
      expect(pill).toHaveClass("bg-red-100", "text-red-700");
      // Should have error tooltip
      expect(pill).toHaveAttribute("title", "Database connection failed");
    });
  });

  describe("Error state", () => {
    it("should show red background when there is an error", () => {
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'running', 50),
        createSyncItem('messages', 'error', 0, 'Import failed'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 50));

      render(<SyncStatusIndicator />);

      const indicator = screen.getByTestId("sync-status-indicator");
      expect(indicator).toHaveClass("bg-red-50", "border-red-200");
    });

    it("should show 'Sync Error:' label when there is an error", () => {
      const queue = [
        createSyncItem('contacts', 'pending', 0),
        createSyncItem('messages', 'error', 0, 'Import failed'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, false, 0));

      render(<SyncStatusIndicator />);

      expect(screen.getByText("Sync Error:")).toBeInTheDocument();
    });
  });

  describe("Completion state", () => {
    it("should show generic completion message for non-AI users", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('messages', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(
        <SyncStatusIndicator pendingCount={5} />
      );

      // Transition to not syncing - update mock to empty queue (complete state)
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator pendingCount={5} />);

      // Should show generic completion, NOT "X transactions found"
      expect(screen.getByText("Sync Complete")).toBeInTheDocument();
      expect(screen.getByText("All data synced successfully")).toBeInTheDocument();
      expect(screen.queryByText(/transactions found/)).not.toBeInTheDocument();
      expect(screen.queryByText("Review Now")).not.toBeInTheDocument();
    });

    it("should show pending transactions for AI add-on users", () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed including ai_detection
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(
        <SyncStatusIndicator pendingCount={5} onViewPending={jest.fn()} />
      );

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator pendingCount={5} onViewPending={jest.fn()} />);

      // Should show "X transactions found" with Review Now button
      expect(screen.getByText("5 transactions found")).toBeInTheDocument();
      expect(screen.getByText("Review Now")).toBeInTheDocument();
    });

    it("should show generic completion for AI users with 0 pending", () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed including ai_detection
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(
        <SyncStatusIndicator pendingCount={0} />
      );

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator pendingCount={0} />);

      // Should show generic completion
      expect(screen.getByText("Sync Complete")).toBeInTheDocument();
      expect(screen.queryByText("Review Now")).not.toBeInTheDocument();
    });

    it("should show amber completion when sync finishes with errors (BACKLOG-1368)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state - contacts error, emails running
      const runningQueue = [
        createSyncItem('contacts', 'error', 0, 'Auth token expired'),
        createSyncItem('emails', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing - contacts still has error, emails complete
      const doneQueue = [
        createSyncItem('contacts', 'error', 0, 'Auth token expired'),
        createSyncItem('emails', 'complete', 100),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(doneQueue, false, 50));
      rerender(<SyncStatusIndicator />);

      // Should show amber "completed with errors", NOT green "Sync Complete".
      // BACKLOG-2127: the subtitle now surfaces the item's error MESSAGE
      // (provider-specific) rather than the generic "Failed: <type>".
      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
      expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
      expect(screen.getByText("Auth token expired")).toBeInTheDocument();
      expect(screen.queryByText("Sync Complete")).not.toBeInTheDocument();
      expect(screen.queryByText("All data synced successfully")).not.toBeInTheDocument();
    });

    it("shows the provider-specific reconnect message for a dead email token (BACKLOG-2127)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      const reconnectMsg = "Outlook connection expired — reconnect to sync email";
      // Emails errors with the reconnect message thrown by SyncOrchestrator.
      const runningQueue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'error', 0, reconnectMsg),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      const doneQueue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'error', 0, reconnectMsg),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(doneQueue, false, 50));
      rerender(<SyncStatusIndicator />);

      // NOT green, and the subtitle names the provider + reconnect action.
      expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
      expect(screen.getByText(reconnectMsg)).toBeInTheDocument();
      expect(screen.queryByText("Sync Complete")).not.toBeInTheDocument();
    });

    it("should show amber completion card styling when errors exist (BACKLOG-1368)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'error', 0, 'Failed'),
        createSyncItem('emails', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing
      const doneQueue = [
        createSyncItem('contacts', 'error', 0, 'Failed'),
        createSyncItem('emails', 'complete', 100),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(doneQueue, false, 50));
      rerender(<SyncStatusIndicator />);

      const card = screen.getByTestId("sync-status-complete");
      expect(card).toHaveClass("bg-amber-50", "border-amber-200");
    });

    it("should show green completion when all items succeed (no errors)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('emails', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing - all complete, no errors
      const doneQueue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('emails', 'complete', 100),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(doneQueue, false, 100));
      rerender(<SyncStatusIndicator />);

      const card = screen.getByTestId("sync-status-complete");
      expect(card).toHaveClass("bg-green-50", "border-green-200");
      expect(screen.getByText("Sync Complete")).toBeInTheDocument();
      expect(screen.getByText("All data synced successfully")).toBeInTheDocument();
    });

    it("should show amber completion even when queue is empty but hasError was true (BACKLOG-1368)", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state - one item errors
      const runningQueue = [
        createSyncItem('contacts', 'error', 0, 'Failed'),
        createSyncItem('emails', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing - queue still has error item
      const doneQueue = [
        createSyncItem('contacts', 'error', 0, 'Failed'),
        createSyncItem('emails', 'complete', 100),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(doneQueue, false, 50));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByText("Sync Completed with Errors")).toBeInTheDocument();
    });

    it("should auto-dismiss completion after 3 seconds", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Advance 2.9s - should still be visible
      act(() => {
        jest.advanceTimersByTime(2900);
      });
      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Advance past 3s total - should auto-dismiss
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });

    it("should allow manual dismiss during auto-dismiss window", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Manually dismiss before the 3s timer fires
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      fireEvent.click(screen.getByLabelText("Dismiss notification"));

      // Should be dismissed immediately
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });

    it("should cancel auto-dismiss when new sync starts during completion window", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing (completion shown)
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // New sync starts within the 3s window
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      const newRunningQueue = [
        createSyncItem('messages', 'running', 20),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(newRunningQueue, true, 20));
      rerender(<SyncStatusIndicator />);

      // Completion should be replaced by sync progress
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();

      // After the original 3s passes, nothing bad happens (timer was cancelled)
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      // Still showing sync progress
      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
    });

    it("should clean up auto-dismiss timer on unmount", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender, unmount } = render(<SyncStatusIndicator />);

      // Transition to not syncing (starts auto-dismiss timer)
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Unmount before timer fires
      unmount();

      // Advance past 3s - should not throw or cause state update on unmounted component
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      // No error means cleanup worked
    });

    it("should auto-dismiss even when queue still has completed items", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('messages', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 25));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing BUT leave completed items in queue
      // (this is what the orchestrator does for internal syncs)
      const completedQueue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('messages', 'complete', 100),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(completedQueue, false, 100));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Advance past 3s - should auto-dismiss even though queue has completed items
      act(() => {
        jest.advanceTimersByTime(3100);
      });
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
      // Should not fall through to progress view with stale green pills
      expect(screen.queryByTestId("sync-status-indicator")).not.toBeInTheDocument();
    });

    it("should allow manual dismiss of completion message", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Click dismiss button
      fireEvent.click(screen.getByLabelText("Dismiss notification"));

      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });
  });

  describe("Review Now button", () => {
    it("should call onViewPending when Review Now is clicked", () => {
      const onViewPending = jest.fn();
      mockIsAllowed.mockReturnValue(true); // All features allowed including ai_detection
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(
        <SyncStatusIndicator pendingCount={3} onViewPending={onViewPending} />
      );

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(
        <SyncStatusIndicator pendingCount={3} onViewPending={onViewPending} />
      );

      fireEvent.click(screen.getByText("Review Now"));

      expect(onViewPending).toHaveBeenCalledTimes(1);
    });
  });

  describe("Progress persistence", () => {
    it("should reset dismissed state when new sync starts", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator />);

      // Dismiss manually
      fireEvent.click(screen.getByLabelText("Dismiss notification"));
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();

      // Start syncing again
      const newRunningQueue = [
        createSyncItem('contacts', 'running', 30),
        createSyncItem('messages', 'pending', 0),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(newRunningQueue, true, 15));
      rerender(<SyncStatusIndicator />);

      // Progress indicator should show again
      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
    });
  });

  describe("Tour-aware auto-dismiss (TASK-2081)", () => {
    it("should NOT auto-dismiss when isTourActive is true", () => {
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator isTourActive={true} />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator isTourActive={true} />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Advance well past 3s - should still be visible because tour is active
      act(() => {
        jest.advanceTimersByTime(10000);
      });
      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();
    });

    it("should auto-dismiss after tour ends (isTourActive transitions false)", () => {
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator isTourActive={true} />);

      // Transition to not syncing (tour still active)
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator isTourActive={true} />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Tour ends
      rerender(<SyncStatusIndicator isTourActive={false} />);

      // Completion should still be visible immediately after tour ends
      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // But should auto-dismiss after 3 seconds
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });

    it("should still allow manual dismiss during tour", () => {
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator isTourActive={true} />);

      // Transition to not syncing (tour still active)
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator isTourActive={true} />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Manual dismiss should still work
      fireEvent.click(screen.getByLabelText("Dismiss notification"));

      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });

    it("should auto-dismiss normally when isTourActive is false (default behavior)", () => {
      // Start with running state
      const runningQueue = [
        createSyncItem('contacts', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(runningQueue, true, 50));

      const { rerender } = render(<SyncStatusIndicator isTourActive={false} />);

      // Transition to not syncing
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState([], false, 0));
      rerender(<SyncStatusIndicator isTourActive={false} />);

      expect(screen.getByTestId("sync-status-complete")).toBeInTheDocument();

      // Should auto-dismiss after 3 seconds (normal behavior)
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(screen.queryByTestId("sync-status-complete")).not.toBeInTheDocument();
    });
  });

  describe("Progress display", () => {
    it("should show progress percentage for running sync", () => {
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('messages', 'running', 65),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 82));

      render(<SyncStatusIndicator />);

      expect(screen.getByText("65%")).toBeInTheDocument();
    });

    it("should not render graphical progress bar (hidden per BACKLOG-824)", () => {
      const queue = [
        createSyncItem('contacts', 'complete', 100),
        createSyncItem('messages', 'running', 50),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 75));

      render(<SyncStatusIndicator />);

      // Progress bar is hidden -- only % text is shown
      const progressBar = screen.getByTestId("sync-status-indicator").querySelector('.bg-blue-500');
      expect(progressBar).toBeNull();
    });
  });

  describe("iPhone sync via orchestrator queue (TASK-2119)", () => {
    it("should show iPhone pill when iPhone is in the queue as running", () => {
      const queue = [
        createSyncItem('iphone', 'running', 30, undefined, true, 'Importing'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 30));

      render(<SyncStatusIndicator />);

      expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
      expect(screen.getByTestId("sync-pill-iphone")).toBeInTheDocument();
      expect(screen.getByText(/iPhone - Importing/)).toBeInTheDocument();
    });

    it("should show iPhone pill with green checkmark when complete", () => {
      const queue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('iphone', 'complete', 100, undefined, true),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 100));

      render(<SyncStatusIndicator />);

      const pill = screen.getByTestId("sync-pill-iphone");
      expect(pill).toHaveClass("bg-green-100", "text-green-700");
    });

    it("should show iPhone pill with red styling when error", () => {
      const queue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('iphone', 'error', 0, 'Device disconnected', true),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 0));

      render(<SyncStatusIndicator />);

      const pill = screen.getByTestId("sync-pill-iphone");
      expect(pill).toHaveClass("bg-red-100", "text-red-700");
      expect(pill).toHaveAttribute("title", "Device disconnected");
    });

    it("should not show iPhone pill when not in queue", () => {
      const queue: SyncItem[] = [];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, false, 0));

      render(<SyncStatusIndicator />);

      expect(screen.queryByTestId("sync-pill-iphone")).not.toBeInTheDocument();
    });

    it("should show Details link when iPhone is active and onViewSyncDetails provided", () => {
      const onViewSyncDetails = jest.fn();
      const queue = [
        createSyncItem('iphone', 'running', 50, undefined, true, 'Reading'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 50));

      render(<SyncStatusIndicator onViewSyncDetails={onViewSyncDetails} />);

      const btn = screen.getByTestId("sync-view-details");
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(onViewSyncDetails).toHaveBeenCalledWith('iphone');
    });

    it("should show iPhone pill alongside email/contacts pills during simultaneous sync", () => {
      const queue = [
        createSyncItem('contacts', 'running', 50),
        createSyncItem('emails', 'pending', 0),
        createSyncItem('iphone', 'running', 70, undefined, true, 'Saving'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 40));

      render(<SyncStatusIndicator />);

      // Both email/contacts and iPhone should be visible
      expect(screen.getByText("Contacts")).toBeInTheDocument();
      expect(screen.getByText("Emails")).toBeInTheDocument();
      expect(screen.getByTestId("sync-pill-iphone")).toBeInTheDocument();
      expect(screen.getByText(/iPhone - Saving/)).toBeInTheDocument();
    });

    it("should use blue background when only iPhone is active", () => {
      const queue = [
        createSyncItem('iphone', 'running', 0, undefined, true, 'Preparing'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 0));

      render(<SyncStatusIndicator />);

      const indicator = screen.getByTestId("sync-status-indicator");
      expect(indicator).toHaveClass("bg-blue-50", "border-blue-200");
    });

    it("should not show iPhone progress percentage (unreliable)", () => {
      const queue = [
        createSyncItem('iphone', 'running', 45, undefined, true, 'Reading'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 45));

      render(<SyncStatusIndicator />);

      // iPhone is external, so its percentage should not show (activeProgress only for non-external)
      expect(screen.queryByText("45%")).not.toBeInTheDocument();
    });

    it("should show spinner for external running pills", () => {
      const queue = [
        createSyncItem('iphone', 'running', 30, undefined, true, 'Importing'),
      ];
      mockUseSyncOrchestrator.mockReturnValue(createOrchestratorState(queue, true, 30));

      render(<SyncStatusIndicator />);

      const pill = screen.getByTestId("sync-pill-iphone");
      // Should contain a spinner div
      const spinner = pill.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });
});
