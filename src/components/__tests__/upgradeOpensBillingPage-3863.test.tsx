/**
 * BACKLOG-3863 (founder, pm_comments ec6ef23b): every desktop "Upgrade" action
 * that opened the stale www.keeprcompliance.com/beta page now opens the portal
 * Billing page through `billing:open-portal` — no URL from the renderer.
 *
 *   TransactionLimitModal  "Upgrade Plan"      (was shell.openExternal /beta)
 *   Dashboard              limit banner        (was window.open /beta)
 *   StartNewAuditModal     limit banner        (was window.open /beta)
 *   UpgradeScreen          "Upgrade Now"-style (was shell.openPopup /beta)
 *
 * Each case asserts the billing channel is called once AND that no other
 * opener ran, so a revert to /beta — or calling both — is red.
 */

import React from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionLimitModal } from "../common/TransactionLimitModal";
import { UpgradeScreen } from "../license/UpgradeScreen";
import Dashboard from "../Dashboard";
import StartNewAuditModal from "../StartNewAuditModal";

jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
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
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () => [],
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: {},
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));
jest.mock("../../contexts/AuthContext", () => {
  const actual = jest.requireActual("../../contexts/AuthContext");
  return {
    ...actual,
    useAuth: () => ({ currentUser: { id: "test-user-123" }, isAuthenticated: true }),
  };
});
// At the plan's limit: the only state in which the banners render.
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    canCreateTransaction: false,
    transactionCount: 5,
    transactionLimit: 5,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

const openPortal = () => jest.mocked(window.api.billing.openPortal);

let windowOpen: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  windowOpen = jest.spyOn(window, "open").mockImplementation(() => null);
  jest.mocked(window.api.transactions.getAll).mockResolvedValue({
    success: true,
    transactions: [],
  });
});

afterEach(() => {
  windowOpen.mockRestore();
});

/** The billing channel ran exactly once, with no argument, and nothing else opened a page. */
function expectBillingPageOnly(): void {
  expect(openPortal()).toHaveBeenCalledTimes(1);
  expect(openPortal().mock.calls[0]).toEqual([]);
  expect(windowOpen).not.toHaveBeenCalled();
  expect(window.api.shell.openExternal).not.toHaveBeenCalled();
  const popup = (window.api.shell as unknown as { openPopup?: jest.Mock }).openPopup;
  if (popup) expect(popup).not.toHaveBeenCalled();
}

describe("BACKLOG-3863 — Upgrade actions open the portal Billing page", () => {
  it("TransactionLimitModal: Upgrade Plan", async () => {
    render(<TransactionLimitModal transactionCount={5} transactionLimit={5} onClose={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Upgrade Plan" }));
    expectBillingPageOnly();
  });

  it("Dashboard: the transaction-limit banner's Upgrade", async () => {
    render(
      <Dashboard onAuditNew={jest.fn()} onViewTransactions={jest.fn()} onManageContacts={jest.fn()} />,
    );
    const banner = screen.getByTestId("transaction-limit-banner");
    await userEvent.click(within(banner).getByRole("button", { name: "Upgrade" }));
    expectBillingPageOnly();
  });

  it("StartNewAuditModal: the transaction-limit banner's Upgrade", async () => {
    render(
      <StartNewAuditModal
        onSelectPendingTransaction={jest.fn()}
        onViewActiveTransactions={jest.fn()}
        onCreateManually={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    const banner = await waitFor(() => screen.getByTestId("modal-transaction-limit-banner"));
    await userEvent.click(within(banner).getByRole("button", { name: "Upgrade" }));
    expectBillingPageOnly();
  });

  it("UpgradeScreen: Manage billing on the website (BACKLOG-4038 wording)", async () => {
    // The popup opener exists in the app's preload; give it a spy so a revert is visible.
    (window.api.shell as unknown as { openPopup?: jest.Mock }).openPopup = jest.fn();
    render(<UpgradeScreen reason="unknown" onLogout={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Manage billing on the website" }));
    expectBillingPageOnly();
  });
});
