/**
 * BACKLOG-4115 N1 — the action row uses the panels' grid constant itself.
 *
 * PANELS_GRID_TWO is replaced by a sentinel string in this file only. The
 * action row must carry the sentinel: a copied literal of the same classes
 * (which looks identical in the DOM and in every other test) reds here.
 * The runtime half of the rule (tile edges = Recent/Todo edges) is measured
 * by e2e/tests/dashboard-3965.spec.ts H1.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";

jest.mock("../dashboard/panels/DashboardPanels", () => ({
  ...jest.requireActual("../dashboard/panels/DashboardPanels"),
  PANELS_GRID_TWO: "qa-sentinel-grid",
}));

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
jest.mock("../../hooks/useReconnectionSummary", () => ({ useReconnectionSummary: () => {} }));
jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
}));
jest.mock("../StartNewAuditModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../common/AlertBanner", () => ({ AlertBanner: () => null, AlertIcons: { email: null, warning: null } }));
jest.mock("../common/TransactionLimitModal", () => ({ TransactionLimitModal: () => null }));
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({ canCreateTransaction: true, transactionCount: 0, transactionLimit: 100 }),
}));
jest.mock("../../hooks/useFeatureGate", () => ({ useFeatureGate: () => ({ isAllowed: () => true }) }));

describe("BACKLOG-4115 N1 — action row grid", () => {
  it("the action row's classes are the imported PANELS_GRID_TWO, not a copy", () => {
    render(
      <Dashboard onAuditNew={jest.fn()} onViewTransactions={jest.fn()} onManageContacts={jest.fn()} />,
    );
    const row = screen.getByTestId("dashboard-action-row");
    expect(row.className.split(/\s+/)).toContain("qa-sentinel-grid");
    expect(row).toContainElement(screen.getByTestId("nav-new-audit"));
  });
});
