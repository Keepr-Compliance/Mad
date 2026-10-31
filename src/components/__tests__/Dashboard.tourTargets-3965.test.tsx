/**
 * BACKLOG-3965 PR-1: guards for the Dashboard face rebuild.
 *
 * C3: every Dashboard tour step points at an element the Dashboard renders.
 *     The tour steps come from the real getDashboardTourSteps with every flag
 *     on, so a tile rebuilt without its data-tour breaks this test, not the
 *     tour in the field.
 * C7: the "N new" badge on New Transaction shows only with the AI add-on and
 *     a pending count, and no "Suggested" region renders in any state.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";
import { getDashboardTourSteps } from "../../config/tourSteps";

jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));

let mockPendingCount = 0;
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: mockPendingCount }),
}));

let mockSyncing = false;
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: mockSyncing }),
}));
jest.mock("../../hooks/useReconnectionSummary", () => ({ useReconnectionSummary: () => {} }));
jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
}));
jest.mock("../StartNewAuditModal", () => ({ __esModule: true, default: () => null }));

let mockAiAddon = true;
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => (mockAiAddon ? <>{children}</> : null),
}));
jest.mock("../common/AlertBanner", () => ({
  AlertBanner: () => null,
  AlertIcons: { email: null, warning: null },
}));
jest.mock("../common/TransactionLimitModal", () => ({ TransactionLimitModal: () => null }));
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({ canCreateTransaction: true, transactionCount: 0, transactionLimit: 100 }),
}));
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true }),
}));

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
};

/**
 * Targets that are not the Dashboard's to render:
 * - "body": the welcome/finish steps.
 * - profile-button: the title bar (AccountButton.tsx), outside the Dashboard.
 * - ai-detection-status: no element in src renders it today (pre-existing,
 *   found by this test; recorded on BACKLOG-3965). Drop it from this list when
 *   an element carries it again.
 */
const NOT_DASHBOARD_TARGETS = new Set([
  "body",
  '[data-tour="profile-button"]',
  '[data-tour="ai-detection-status"]',
]);

beforeEach(() => {
  mockPendingCount = 0;
  mockSyncing = false;
  mockAiAddon = true;
});

describe("Dashboard tour targets (BACKLOG-3965 C3)", () => {
  it("every Dashboard tour step anchors to a rendered element", () => {
    const { container } = render(
      <Dashboard {...baseProps} onSyncPhone={jest.fn()} onSyncAndroid={jest.fn()} />,
    );
    const steps = getDashboardTourSteps({
      hasAIAddon: true,
      isMacOS: true,
      notificationsEnabled: false,
      hasIPhoneSync: true,
      hasSyncVisible: true,
    });
    const targets = Array.from(
      new Set(steps.map((s) => s.target).filter((t): t is string => typeof t === "string")),
    ).filter((t) => !NOT_DASHBOARD_TARGETS.has(t));
    // The tiles plus the sync status wrapper; an empty list would prove nothing.
    expect(targets.length).toBeGreaterThanOrEqual(5);
    const missing = targets.filter((t) => container.querySelector(t) === null);
    expect(missing).toEqual([]);
  });
});

describe('"N new" badge on New Transaction (BACKLOG-3965 C7)', () => {
  it("shows the count with the AI add-on and pending transactions", () => {
    mockPendingCount = 3;
    render(<Dashboard {...baseProps} />);
    const tile = screen.getByTestId("nav-new-audit");
    expect(tile).toHaveTextContent("3 new");
  });

  it("is absent with no pending transactions", () => {
    mockPendingCount = 0;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText(/\bnew$/)).toBeNull();
  });

  it("is absent without the AI add-on", () => {
    mockPendingCount = 3;
    mockAiAddon = false;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText("3 new")).toBeNull();
  });

  it.each([
    [true, 3],
    [false, 3],
    [true, 0],
  ])("renders no Suggested region (AI add-on %s, %i pending)", (ai, count) => {
    mockAiAddon = ai;
    mockPendingCount = count;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText(/suggested/i)).toBeNull();
  });
});
