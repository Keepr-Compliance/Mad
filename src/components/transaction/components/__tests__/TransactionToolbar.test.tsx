/**
 * Tests for TransactionToolbar component
 * TASK-2159: Migrated from useLicense to useFeatureGate for AI gating
 * Verifies AI gating behavior for Rejected filter tab (BACKLOG-462)
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import TransactionToolbar from "../TransactionToolbar";
import type { TransactionToolbarProps } from "../TransactionToolbar";

// TASK-2159: Mock useFeatureGate (replaces useLicense mock)
const mockIsAllowed = jest.fn();
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));

// Mock LicenseGate to pass through (already uses useFeatureGate internally)
jest.mock("@/components/common/LicenseGate", () => ({
  LicenseGate: ({ requires, children }: { requires: string; children: React.ReactNode }) => {
    // Simulate the feature gate logic
    const allowed = (() => {
      switch (requires) {
        case "ai_addon":
          return mockIsAllowed("ai_detection");
        case "individual":
          return mockIsAllowed("text_export") || mockIsAllowed("email_export");
        case "team":
        case "enterprise":
          return mockIsAllowed("broker_submission");
        default:
          return false;
      }
    })();
    return allowed ? <>{children}</> : null;
  },
}));

// Helper to create default props
function createDefaultProps(overrides: Partial<TransactionToolbarProps> = {}): TransactionToolbarProps {
  return {
    transactionCount: 10,
    onClose: jest.fn(),
    filter: "all",
    onFilterChange: jest.fn(),
    filterCounts: {
      all: 10,
      pending: 2,
      active: 5,
      closed: 2,
      rejected: 1,
    },
    scanning: false,
    scanProgress: null,
    onStartScan: jest.fn(),
    onStopScan: jest.fn(),
    selectionMode: false,
    onToggleSelectionMode: jest.fn(),
    showStatusInfo: false,
    onToggleStatusInfo: jest.fn(),
    onNewTransaction: jest.fn(),
    error: null,
    quickExportSuccess: null,
    bulkActionSuccess: null,
    ...overrides,
  };
}

describe("TransactionToolbar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Rejected filter tab AI gating (BACKLOG-462)", () => {
    it("should show Rejected tab when ai_detection feature is allowed", () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed

      render(<TransactionToolbar {...createDefaultProps()} />);

      const rejectedButton = screen.getByRole("button", { name: /rejected/i });
      expect(rejectedButton).toBeInTheDocument();
    });

    it("should hide Rejected tab when ai_detection feature is not allowed", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      render(<TransactionToolbar {...createDefaultProps()} />);

      const rejectedButton = screen.queryByRole("button", { name: /rejected/i });
      expect(rejectedButton).not.toBeInTheDocument();
    });

    it("should show rejected count badge when count > 0 and ai_detection is allowed", () => {
      mockIsAllowed.mockReturnValue(true);

      render(
        <TransactionToolbar
          {...createDefaultProps({
            filterCounts: {
              all: 10,
              pending: 2,
              active: 5,
              closed: 2,
              rejected: 3,
            },
          })}
        />
      );

      const rejectedButton = screen.getByRole("button", { name: /rejected/i });
      expect(rejectedButton).toHaveTextContent("3");
    });
  });

  describe("Pending Review filter tab AI gating", () => {
    it("should show Pending Review tab when ai_detection feature is allowed", () => {
      mockIsAllowed.mockReturnValue(true);

      render(<TransactionToolbar {...createDefaultProps()} />);

      const pendingButton = screen.getByRole("button", { name: /pending review/i });
      expect(pendingButton).toBeInTheDocument();
    });

    it("should hide Pending Review tab when ai_detection feature is not allowed", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      render(<TransactionToolbar {...createDefaultProps()} />);

      const pendingButton = screen.queryByRole("button", { name: /pending review/i });
      expect(pendingButton).not.toBeInTheDocument();
    });
  });

  describe("Auto Detect button AI gating", () => {
    it("should show Auto Detect button when ai_detection feature is allowed", () => {
      mockIsAllowed.mockReturnValue(true);

      render(<TransactionToolbar {...createDefaultProps()} />);

      const autoDetectButton = screen.getByRole("button", { name: /auto detect/i });
      expect(autoDetectButton).toBeInTheDocument();
    });

    it("should hide Auto Detect button when ai_detection feature is not allowed", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      render(<TransactionToolbar {...createDefaultProps()} />);

      const autoDetectButton = screen.queryByRole("button", { name: /auto detect/i });
      expect(autoDetectButton).not.toBeInTheDocument();
    });
  });

  describe("Non-gated filter tabs", () => {
    it("should always show All tab regardless of ai_detection", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      const { rerender } = render(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getAllByRole("button", { name: /^all/i }).length).toBeGreaterThan(0);

      mockIsAllowed.mockReturnValue(true);
      rerender(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getAllByRole("button", { name: /^all/i }).length).toBeGreaterThan(0);
    });

    it("should always show Active tab regardless of ai_detection", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      const { rerender } = render(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getByRole("button", { name: /^active/i })).toBeInTheDocument();

      mockIsAllowed.mockReturnValue(true);
      rerender(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getByRole("button", { name: /^active/i })).toBeInTheDocument();
    });

    it("should always show Closed tab regardless of ai_detection", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");
      const { rerender } = render(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getByRole("button", { name: /^closed/i })).toBeInTheDocument();

      mockIsAllowed.mockReturnValue(true);
      rerender(<TransactionToolbar {...createDefaultProps()} />);
      expect(screen.getByRole("button", { name: /^closed/i })).toBeInTheDocument();
    });
  });

  describe("Status info tooltip AI gating", () => {
    it("should show Rejected explanation in tooltip only when ai_detection is allowed", () => {
      mockIsAllowed.mockReturnValue(true);

      render(
        <TransactionToolbar
          {...createDefaultProps({
            showStatusInfo: true,
          })}
        />
      );

      expect(screen.getByText("Not a real transaction (false positive)")).toBeInTheDocument();
    });

    it("should not show Rejected explanation in tooltip when ai_detection is not allowed", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      render(
        <TransactionToolbar
          {...createDefaultProps({
            showStatusInfo: true,
          })}
        />
      );

      expect(screen.queryByText("Not a real transaction (false positive)")).not.toBeInTheDocument();
    });

    it("should show Pending Review explanation in tooltip only when ai_detection is allowed", () => {
      mockIsAllowed.mockReturnValue(true);

      render(
        <TransactionToolbar
          {...createDefaultProps({
            showStatusInfo: true,
          })}
        />
      );

      expect(screen.getByText("Auto-detected transaction awaiting your approval")).toBeInTheDocument();
    });

    it("should not show Pending Review explanation in tooltip when ai_detection is not allowed", () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      render(
        <TransactionToolbar
          {...createDefaultProps({
            showStatusInfo: true,
          })}
        />
      );

      expect(screen.queryByText("Auto-detected transaction awaiting your approval")).not.toBeInTheDocument();
    });
  });
});
