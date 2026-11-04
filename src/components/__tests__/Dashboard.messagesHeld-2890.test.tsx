/**
 * BACKLOG-2890: the dashboard warns when Mac Messages auto-sync is held after a
 * failed preferences read (useAutoRefresh `messagesSyncHeld`, passed through
 * AppRouter). Uses the real ./common/AlertBanner, the component the two banners
 * beside it use.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";

// --- Mocks for heavy / irrelevant dependencies ---------------------------

jest.mock("react-joyride", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));

jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: 0 }),
}));

jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));

jest.mock("../../hooks/useReconnectionSummary", () => ({
  useReconnectionSummary: () => {},
}));

let mockIndicatorProps: { onViewSyncDetails?: (type: string) => void } = {};
jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: (p: { onViewSyncDetails?: (type: string) => void }) => {
    mockIndicatorProps = p;
    return <div data-testid="sync-status-indicator" />;
  },
}));

jest.mock("../StartNewAuditModal", () => ({
  __esModule: true,
  default: () => <div data-testid="start-new-audit-modal" />,
}));

jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../common/TransactionLimitModal", () => ({
  TransactionLimitModal: () => null,
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
  }),
}));

jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true }),
}));

jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () => [],
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: {},
}));

// --- Tests ---------------------------------------------------------------

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
};

describe("Dashboard Messages-held banner (BACKLOG-2890)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the warning banner with its copy when Messages sync is held", () => {
    render(<Dashboard {...baseProps} messagesSyncHeld onTriggerRefresh={jest.fn()} />);
    const banner = screen.getByTestId("messages-held-banner");
    expect(banner).toHaveTextContent("Messages sync paused");
    expect(banner).toHaveTextContent(
      "Keepr couldn't read your messages settings, so Messages were not synced. It retries on the next sync.",
    );
    // Not dismissible: the only button is Retry.
    expect(banner.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it.each([
    ["false", { messagesSyncHeld: false }],
    ["not passed", {}],
  ])("no banner when messagesSyncHeld is %s", (_n, extra) => {
    render(<Dashboard {...baseProps} {...extra} onTriggerRefresh={jest.fn()} />);
    expect(screen.queryByTestId("messages-held-banner")).toBeNull();
    expect(screen.queryByText("Messages sync paused")).toBeNull();
  });

  it("Retry triggers a refresh", () => {
    const onTriggerRefresh = jest.fn();
    render(<Dashboard {...baseProps} messagesSyncHeld onTriggerRefresh={onTriggerRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onTriggerRefresh).toHaveBeenCalledTimes(1);
  });
});
