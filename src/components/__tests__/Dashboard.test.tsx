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

/** The small row (BACKLOG-4115: sync tiles only). */
const secondaryRow = () => screen.getByTestId("dashboard-small-row");

describe("Dashboard sync cards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Android sync card (BACKLOG-2320)", () => {
    it("renders the Android card with founder-specified copy when onSyncAndroid is provided", () => {
      render(<Dashboard {...baseProps} onSyncAndroid={jest.fn()} />);

      expect(screen.getByTestId("sync-android-card")).toBeInTheDocument();
      expect(screen.getByText("Sync Android Messages")).toBeInTheDocument();
      // Founder-specified: Wi-Fi, NOT "via USB cable".
      expect(screen.getByText("Copy texts from Google Messages")).toBeInTheDocument();
    });

    it("does NOT render the Android card when onSyncAndroid is omitted", () => {
      render(<Dashboard {...baseProps} />);

      expect(screen.queryByTestId("sync-android-card")).not.toBeInTheDocument();
      expect(screen.queryByText("Sync Android Messages")).not.toBeInTheDocument();
    });

    // BACKLOG-3658: the indicator's Details for a Google Messages Sync reopens
    // the Sync Android window. Mutation: the mapping missing → red.
    it("the sync indicator's Details for Google Messages reopens Sync Android", () => {
      const onSyncAndroid = jest.fn();
      render(<Dashboard {...baseProps} onSyncAndroid={onSyncAndroid} />);
      mockIndicatorProps.onViewSyncDetails?.("google-messages");
      expect(onSyncAndroid).toHaveBeenCalledTimes(1);
    });

    it("invokes onSyncAndroid when the Android card is clicked (opens the wizard modal)", async () => {
      const onSyncAndroid = jest.fn();
      render(<Dashboard {...baseProps} onSyncAndroid={onSyncAndroid} />);

      await userEvent.click(screen.getByTestId("sync-android-card"));

      expect(onSyncAndroid).toHaveBeenCalledTimes(1);
    });

    it("does NOT render the iPhone card when only onSyncAndroid is set", () => {
      render(<Dashboard {...baseProps} onSyncAndroid={jest.fn()} />);

      expect(screen.queryByText("Sync iPhone Messages")).not.toBeInTheDocument();
    });
  });

  describe("iPhone sync card (unchanged — BACKLOG-1653)", () => {
    it("renders the iPhone card with its USB copy when onSyncPhone is provided", () => {
      render(<Dashboard {...baseProps} onSyncPhone={jest.fn()} />);

      expect(screen.getByText("Sync iPhone Messages")).toBeInTheDocument();
      expect(screen.getByText("Import texts via USB cable")).toBeInTheDocument();
      // The Android card must not appear on the iPhone path.
      expect(screen.queryByTestId("sync-android-card")).not.toBeInTheDocument();
    });

    it("invokes onSyncPhone when the iPhone card is clicked", async () => {
      const onSyncPhone = jest.fn();
      render(<Dashboard {...baseProps} onSyncPhone={onSyncPhone} />);

      await userEvent.click(screen.getByText("Sync iPhone Messages"));

      expect(onSyncPhone).toHaveBeenCalledTimes(1);
    });
  });

  describe("secondary-row grid column logic", () => {
    it("uses two columns when the Android sync card shows", () => {
      render(<Dashboard {...baseProps} onSyncAndroid={jest.fn()} />);
      expect(secondaryRow().className).toContain("sm:grid-cols-2");
    });

    it("uses two columns when the iPhone sync card shows", () => {
      render(<Dashboard {...baseProps} onSyncPhone={jest.fn()} />);
      expect(secondaryRow().className).toContain("sm:grid-cols-2");
    });

    it("renders no small row when no sync card shows (BACKLOG-4115)", () => {
      render(<Dashboard {...baseProps} />);
      expect(screen.queryByTestId("dashboard-small-row")).toBeNull();
      // Clients & Contacts is not in the small row any more; it is in the action row.
      expect(screen.getByTestId("dashboard-action-row")).toContainElement(
        screen.getByTestId("nav-clients-contacts"),
      );
    });
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
