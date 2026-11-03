/**
 * Tests for Dashboard.tsx — sync entry-point cards.
 *
 * BACKLOG-2320: the Dashboard renders an Android sync card (mirroring the
 * existing iPhone sync card) when the parent passes `onSyncAndroid`. These
 * tests lock in:
 *   - the card only renders when its callback is provided (import-source gated
 *     upstream in AppRouter),
 *   - the founder-specified label/subtitle copy,
 *   - clicking the card invokes the callback (opens the wizard modal),
 *   - the small row renders only when a sync card shows (BACKLOG-4115),
 *   - the iPhone card path is unchanged.
 *
 * Heavy Dashboard dependencies (Joyride, license, sync orchestrator, tour, etc.)
 * are mocked so we isolate the card-rendering logic.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

jest.mock("../common/AlertBanner", () => ({
  AlertBanner: () => null,
  AlertIcons: { email: null, warning: null },
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

// --- Helpers -------------------------------------------------------------

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
};

describe("Dashboard sync props (BACKLOG-4115: the sync tiles became the title-bar pill)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["neither", {}],
    ["onSyncPhone", { onSyncPhone: jest.fn() }],
    ["onSyncAndroid", { onSyncAndroid: jest.fn() }],
    ["both", { onSyncPhone: jest.fn(), onSyncAndroid: jest.fn() }],
  ])("%s: no sync tile, no small row; the action row holds only its two tiles", (_n, extra) => {
    render(<Dashboard {...baseProps} {...extra} />);
    expect(screen.queryByTestId("dashboard-small-row")).toBeNull();
    expect(screen.queryByTestId("sync-android-card")).toBeNull();
    expect(screen.queryByText("Sync iPhone Messages")).toBeNull();
    expect(screen.queryByText("Sync Android Messages")).toBeNull();
    expect(document.querySelector('[data-tour="sync-phone-card"]')).toBeNull();
    const row = screen.getByTestId("dashboard-action-row");
    expect(row.querySelectorAll("button")).toHaveLength(2);
    expect(row).toContainElement(screen.getByTestId("nav-clients-contacts"));
  });

  // BACKLOG-3658: the indicator's Details for a Google Messages Sync reopens
  // the Sync Android window. Mutation: the mapping missing → red.
  it("the sync indicator's Details for Google Messages reopens Sync Android", () => {
    const onSyncAndroid = jest.fn();
    render(<Dashboard {...baseProps} onSyncAndroid={onSyncAndroid} />);
    mockIndicatorProps.onViewSyncDetails?.("google-messages");
    expect(onSyncAndroid).toHaveBeenCalledTimes(1);
  });

  it("the sync indicator's Details for iPhone reopens iPhone Sync", () => {
    const onSyncPhone = jest.fn();
    render(<Dashboard {...baseProps} onSyncPhone={onSyncPhone} />);
    mockIndicatorProps.onViewSyncDetails?.("iphone");
    expect(onSyncPhone).toHaveBeenCalledTimes(1);
  });
});

describe("Dashboard primary action label (BACKLOG-3614)", () => {
  it("reads New Transaction, not New Audit", () => {
    render(<Dashboard {...baseProps} />);
    expect(screen.getByRole("heading", { name: "New Transaction" })).toBeInTheDocument();
    expect(screen.queryByText(/new audit/i)).toBeNull();
  });
});

describe("Dashboard face copy (BACKLOG-3965 PR-1)", () => {
  // C1 (BACKLOG-4115 M10): the All audits tile is gone, in either casing; the
  // list is reached from the Recent panel's "All →" (RecentPanel-3965 N5).
  // Mutation: the tile restored in Dashboard.tsx -> red.
  it("has no All audits tile", () => {
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByRole("heading", { name: /all audits/i })).toBeNull();
    expect(screen.queryByText(/all audits/i)).toBeNull();
    expect(screen.queryByTestId("nav-transactions")).toBeNull();
  });

  // C2: the tagline under the greeting is gone; the greeting stays.
  // Mutation: the tagline paragraph restored -> red.
  it("shows the greeting and no tagline", () => {
    render(<Dashboard {...baseProps} user={{ display_name: "Avery Example" }} />);
    expect(screen.getByRole("heading", { name: "Welcome back, Avery!" })).toBeInTheDocument();
    expect(screen.queryByText(/compliance made simple/i)).toBeNull();
  });
});

describe("Dashboard primary cards: New Transaction stays on one line (BACKLOG-3614 QA)", () => {
  // jsdom does no layout. These tests resolve the grid's Tailwind classes at
  // each window width (sm: = 640px, md: = 768px, lg: = 1024px) and pin the
  // no-wrap class. The layout itself was measured in Chromium (Tailwind
  // compiled over this component's rendered HTML) from 400 to 1280px: before,
  // "New Transaction" wrapped to two lines at every width from 640 to 730;
  // after, one line at every width swept. Results are on BACKLOG-3614.
  const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280 };

  /** The grid-cols-N in effect at `width`, from classes like "grid-cols-1 md:grid-cols-2". */
  const columnsAt = (className: string, width: number): number => {
    let cols = 1;
    let from = -1;
    for (const cls of className.split(/\s+/)) {
      const m = /^(?:(sm|md|lg|xl):)?grid-cols-(\d+)$/.exec(cls);
      if (!m) continue;
      const min = m[1] ? BREAKPOINTS[m[1]] : 0;
      if (width >= min && min >= from) {
        cols = Number(m[2]);
        from = min;
      }
    }
    return cols;
  };

  const primaryGrid = () => screen.getByTestId("dashboard-action-row");

  it.each([
    [400, 1],
    [639, 1],
    [640, 1],
    [660, 1],
    [680, 1],
    [700, 1],
    [730, 1],
    [767, 1],
    [768, 2],
    [1024, 2],
    [1280, 2],
  ])("%ipx: the primary cards sit %i per row", (width, expected) => {
    render(<Dashboard {...baseProps} />);
    const grid = primaryGrid();
    expect(grid).toContainElement(screen.getByTestId("nav-new-audit"));
    expect(grid).toContainElement(screen.getByTestId("nav-clients-contacts"));
    // Two per row from 640px squeezed each card to ~272px and wrapped the title.
    expect(columnsAt(grid.className, width)).toBe(expected);
  });

  it("the New Transaction title never wraps", () => {
    render(<Dashboard {...baseProps} />);
    const title = screen.getByRole("heading", { name: "New Transaction" });
    expect(title.className.split(/\s+/)).toContain("whitespace-nowrap");
  });

  it("the title keeps the same type style as the Clients & Contacts card", () => {
    render(<Dashboard {...baseProps} />);
    const style = (name: string) =>
      screen
        .getByRole("heading", { name })
        .className.split(/\s+/)
        .filter((c) => c !== "whitespace-nowrap")
        .sort();
    expect(style("New Transaction")).toEqual(style("Clients & Contacts"));
  });
});
