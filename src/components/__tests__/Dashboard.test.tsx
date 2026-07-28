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
 *   - the secondary-row grid switches between 1 and 2 columns correctly,
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

jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
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

/** The secondary actions row is the grid that contains the Contacts card. */
const secondaryRow = () =>
  screen.getByTestId("nav-clients-contacts").parentElement as HTMLElement;

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
      expect(screen.getByText("Import texts over Wi-Fi")).toBeInTheDocument();
    });

    it("does NOT render the Android card when onSyncAndroid is omitted", () => {
      render(<Dashboard {...baseProps} />);

      expect(screen.queryByTestId("sync-android-card")).not.toBeInTheDocument();
      expect(screen.queryByText("Sync Android Messages")).not.toBeInTheDocument();
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

    it("uses a single column when no sync card shows", () => {
      render(<Dashboard {...baseProps} />);
      const cls = secondaryRow().className;
      expect(cls).toContain("grid-cols-1");
      expect(cls).not.toContain("sm:grid-cols-2");
    });
  });
});
