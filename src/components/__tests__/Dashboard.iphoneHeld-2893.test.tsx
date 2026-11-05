/**
 * BACKLOG-2893: the same dashboard banner shows when the iPhone sync provider's
 * own preferences read failed (useIPhoneSyncEnabled `readFailed`), on every
 * platform, and its Retry / the New Transaction modal's sync re-read both.
 * Mocks copied from Dashboard.messagesHeld-2890.test.tsx; the provider is
 * mocked here (its own behaviour is iphoneSyncFailedRead-2893.test.tsx).
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

jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
}));

let mockModalProps: { onSync?: () => void } = {};
jest.mock("../StartNewAuditModal", () => ({
  __esModule: true,
  default: (p: { onSync?: () => void }) => {
    mockModalProps = p;
    return <div data-testid="start-new-audit-modal" />;
  },
}));

const mockRetryRead = jest.fn().mockResolvedValue(undefined);
let mockIphoneReadFailed = false;
jest.mock("../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncEnabled: () => ({
    enabled: false,
    setIphoneSyncEnabled: jest.fn(),
    applyImportSource: jest.fn(),
    readFailed: mockIphoneReadFailed,
    retryRead: mockRetryRead,
  }),
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

const COPY =
  "Keepr couldn't read your messages settings, so syncing is paused. Check your connection, then Retry.";

describe("Dashboard sync-held banner, iPhone read (BACKLOG-2893)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIphoneReadFailed = false;
    mockModalProps = {};
  });

  it("D1 the iPhone read alone is held (Mac Messages not held) -> the banner, with the new copy", () => {
    mockIphoneReadFailed = true;
    render(<Dashboard {...baseProps} messagesSyncHeld={false} onTriggerRefresh={jest.fn()} />);
    const banner = screen.getByTestId("messages-held-banner");
    expect(banner).toHaveTextContent("Messages sync paused");
    expect(banner).toHaveTextContent(COPY);
    expect(banner.querySelectorAll("button")).toHaveLength(1);
  });

  it("D2 both held -> one banner", () => {
    mockIphoneReadFailed = true;
    render(<Dashboard {...baseProps} messagesSyncHeld onTriggerRefresh={jest.fn()} />);
    expect(screen.getAllByTestId("messages-held-banner")).toHaveLength(1);
  });

  it("D3 neither held -> no banner", () => {
    render(<Dashboard {...baseProps} messagesSyncHeld={false} onTriggerRefresh={jest.fn()} />);
    expect(screen.queryByTestId("messages-held-banner")).toBeNull();
  });

  it("D4 Retry re-reads the iPhone preferences AND runs the refresh", () => {
    mockIphoneReadFailed = true;
    const onTriggerRefresh = jest.fn();
    render(<Dashboard {...baseProps} onTriggerRefresh={onTriggerRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRetryRead).toHaveBeenCalledTimes(1);
    expect(onTriggerRefresh).toHaveBeenCalledTimes(1);
  });

  it("D5 the New Transaction modal's sync re-reads the iPhone preferences AND runs the refresh", () => {
    const onTriggerRefresh = jest.fn();
    render(<Dashboard {...baseProps} onTriggerRefresh={onTriggerRefresh} />);
    fireEvent.click(screen.getByTestId("nav-new-audit"));
    expect(screen.getByTestId("start-new-audit-modal")).toBeInTheDocument();
    mockModalProps.onSync!();
    expect(mockRetryRead).toHaveBeenCalledTimes(1);
    expect(onTriggerRefresh).toHaveBeenCalledTimes(1);
  });

  it("D6 no onTriggerRefresh -> the modal gets no sync action (as before)", () => {
    render(<Dashboard {...baseProps} />);
    fireEvent.click(screen.getByTestId("nav-new-audit"));
    expect(mockModalProps.onSync).toBeUndefined();
  });
});
