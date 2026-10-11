/**
 * BACKLOG-3673 C19 — the dashboard tour never opens over the terms screen.
 *
 * Row 16 of the routing table: a finished account, on a computer that has never
 * shown the tour, whose accepted terms are outdated. It lands on the dashboard
 * (setup finished) with the terms screen over it. The Joyride tour sits above
 * the terms screen (z-index 10000 vs z-50), so it must not start until the terms
 * are accepted -- then it starts.
 *
 * Real `useTour` (localStorage + its 500 ms start timer) and the real
 * AuthContext object; only Joyride itself is replaced, to read its `run` prop.
 *
 * BACKLOG-3674: the tour now starts only after an async server read
 * (window.api.user.getTourState, "not-dismissed" by default in tests/setup.js),
 * so each timer advance runs in an async act to let that read resolve.
 */

import React from "react";
import { render, act } from "@testing-library/react";
import Dashboard from "../Dashboard";
import AuthContext from "../../contexts/AuthContext";

const mockJoyrideRuns: boolean[] = [];
jest.mock("react-joyride", () => ({
  __esModule: true,
  default: (props: { run: boolean }) => {
    mockJoyrideRuns.push(props.run);
    return null;
  },
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
jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () => [],
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: {},
}));

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
};

function authValue(needsTermsAcceptance: boolean) {
  return { needsTermsAcceptance } as unknown as React.ContextType<typeof AuthContext>;
}

function tree(needsTermsAcceptance: boolean) {
  return (
    <AuthContext.Provider value={authValue(needsTermsAcceptance)}>
      <Dashboard {...baseProps} />
    </AuthContext.Provider>
  );
}

describe("C19 — dashboard tour waits for the terms screen (BACKLOG-3673)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear(); // a computer that has never shown the tour
    mockJoyrideRuns.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("terms outdated: the tour does not start while the terms screen is up", async () => {
    render(tree(true));
    await act(async () => {
      // async: lets the server read resolve between timer steps
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockJoyrideRuns.length).toBeGreaterThan(0);
    expect(mockJoyrideRuns.every((run) => run === false)).toBe(true);
  });

  it("terms accepted in the same run: the tour starts after acceptance", async () => {
    const { rerender } = render(tree(true));
    await act(async () => {
      // async: lets the server read resolve between timer steps
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockJoyrideRuns[mockJoyrideRuns.length - 1]).toBe(false);

    rerender(tree(false));
    await act(async () => {
      // async: lets the server read resolve between timer steps
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockJoyrideRuns[mockJoyrideRuns.length - 1]).toBe(true);
  });

  it("terms current: the tour starts as before", async () => {
    render(tree(false));
    await act(async () => {
      // async: lets the server read resolve between timer steps
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(mockJoyrideRuns[mockJoyrideRuns.length - 1]).toBe(true);
  });
});
