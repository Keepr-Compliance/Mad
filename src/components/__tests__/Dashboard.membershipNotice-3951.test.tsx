/**
 * BACKLOG-3951 PR-B2 — the removed-member notice in the REAL Dashboard screen.
 *
 * Real Dashboard, real MembershipNotice, real AlertBanner, real dismissal hook
 * and settingsService. Replaced: the PR-B1 standing (`useLicense`), the
 * preferences bridge (shapes from electron/handlers/preferenceHandlers.ts), and
 * the dashboard's unrelated heavy children (same mocks as the other Dashboard
 * suites, minus AlertBanner, which must render here).
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import Dashboard from "../Dashboard";

jest.mock("react-joyride", () => ({
  __esModule: true,
  default: () => null,
  STATUS: { FINISHED: "finished", SKIPPED: "skipped" },
  ACTIONS: { CLOSE: "close" },
}));
jest.mock("canvas-confetti", () => jest.fn());
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: 0 }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../../hooks/useReconnectionSummary", () => ({
  useReconnectionSummary: () => {},
}));
jest.mock("../dashboard/index", () => ({ SyncStatusIndicator: () => null }));
jest.mock("../StartNewAuditModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../common/TransactionLimitModal", () => ({ TransactionLimitModal: () => null }));
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true }),
}));
jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () => [],
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: {},
}));

type Standing = "licensed" | "unlicensed" | "left_brokerage" | "unknown" | "none" | undefined;
let mockStanding: Standing;
let mockOrgName: string | undefined;
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
    membershipStanding: mockStanding,
    membershipOrgName: mockOrgName,
  }),
}));

const USER_A = "test-user-a";
const BROKERAGE = "Fixture Brokerage";

const prefs = () =>
  (window as unknown as {
    api: { preferences: { get: jest.Mock; update: jest.Mock } };
  }).api.preferences;

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
  user: { id: USER_A },
} as unknown as React.ComponentProps<typeof Dashboard>;

async function renderDashboard() {
  await act(async () => {
    render(<Dashboard {...baseProps} />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStanding = "left_brokerage";
  mockOrgName = BROKERAGE;
  prefs().get.mockResolvedValue({ success: true, preferences: {} });
  prefs().update.mockResolvedValue({ success: true, preferences: {} });
});

describe("BACKLOG-3951 Dashboard mounts the removed-member notice", () => {
  it("removed member: the notice is on the dashboard with the brokerage name", async () => {
    await renderDashboard();
    const notice = screen.getByTestId("membership-notice");
    expect(notice).toHaveTextContent("You're no longer part of Fixture Brokerage.");
    expect(notice).toHaveTextContent(
      "You can keep using Keepr on your own and unlock transactions with a monthly subscription or credits.",
    );
    expect(prefs().get).toHaveBeenCalledWith(USER_A);
  });

  it.each([
    ["unassigned", "unlicensed"],
    ["active", "licensed"],
    ["solo", "none"],
    ["unknown", "unknown"],
    ["loading", undefined],
    ["read error", undefined],
  ] as const)("%s: no notice on the dashboard", async (_label, standing) => {
    mockStanding = standing;
    await renderDashboard();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });

  it("dismiss on the dashboard hides it and saves it for this user", async () => {
    await renderDashboard();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    expect(screen.queryByTestId("membership-notice")).toBeNull();
    expect(prefs().update).toHaveBeenCalledWith(USER_A, {
      notices: { membershipNoticeDismissedFor: BROKERAGE },
    });
  });

  it("previously dismissed for this brokerage: not shown on the dashboard", async () => {
    prefs().get.mockResolvedValue({
      success: true,
      preferences: { notices: { membershipNoticeDismissedFor: BROKERAGE } },
    });
    await renderDashboard();
    expect(screen.queryByTestId("membership-notice")).toBeNull();
  });
});
