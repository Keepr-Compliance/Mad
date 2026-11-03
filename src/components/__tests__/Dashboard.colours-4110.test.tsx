/**
 * BACKLOG-4110 (mock v9) — Dashboard colours.
 *
 * - Chip tone per tile: New Transaction and Clients & Contacts carry the blue
 *   chip. The default tone is "muted", so a tile that forgets its prop reds
 *   here. (BACKLOG-4115: the muted sync tiles became the title-bar pill.)
 * - BACKLOG-4115: the action row is exactly New Transaction then Clients &
 *   Contacts, both blue (All audits is gone; it is reached from Recent).
 * - Tiles: warm hairline, no resting shadow, ink title.
 * - The Dashboard root paints the warm page (the shell stays gray: see
 *   appCore/__tests__/AppShell.titleBar.test.tsx).
 * - The greeting is semibold ink.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";

jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));

let mockPendingCount = 0;
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: mockPendingCount }),
}));

const mockSyncing = false;
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: mockSyncing }),
}));
jest.mock("../../hooks/useReconnectionSummary", () => ({ useReconnectionSummary: () => {} }));
jest.mock("../dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
}));
jest.mock("../StartNewAuditModal", () => ({
  __esModule: true,
  default: () => <div data-testid="start-new-audit-modal" />,
}));

const mockAiAddon = true;
jest.mock("../common/FeatureGate", () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => (mockAiAddon ? <>{children}</> : null),
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

const props = () => ({
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
  onSyncPhone: jest.fn(),
  onSyncAndroid: jest.fn(),
});

const tile = (container: HTMLElement, target: string) => {
  const el = container.querySelector(`[data-tour="${target}"], [data-testid="${target}"]`);
  if (!el) throw new Error(`no tile ${target}`);
  return el as HTMLElement;
};
const chip = (container: HTMLElement, target: string) => {
  const el = tile(container, target).querySelector('[data-part="chip"]');
  if (!el) throw new Error(`no chip in ${target}`);
  return el as HTMLElement;
};

const BLUE = ["new-audit-card", "contacts-card"] as const;
// BACKLOG-4115: the two muted sync tiles became the title-bar pill; every
// Dashboard tile left is blue-chipped (the muted chip stays in
// DashboardActionCard, covered by its own test).
const ALL = [...BLUE];

describe("BACKLOG-4110 — tile chips", () => {
  it.each(BLUE)("%s has the blue chip and not the muted one", (target) => {
    const { container } = render(<Dashboard {...props()} />);
    const c = chip(container, target);
    expect(c).toHaveClass("bg-primary-50", "text-primary-600");
    expect(c).not.toHaveClass("bg-warm-chip");
    expect(c).not.toHaveClass("text-ink-muted");
  });
});

describe("BACKLOG-4115 — the action row", () => {
  it("holds exactly New Transaction then Clients & Contacts, both with the blue chip", () => {
    render(<Dashboard {...props()} />);
    const row = screen.getByTestId("dashboard-action-row");
    const buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "nav-new-audit",
      "nav-clients-contacts",
    ]);
    for (const b of buttons) {
      const c = b.querySelector('[data-part="chip"]') as HTMLElement;
      expect(c).toHaveClass("bg-primary-50", "text-primary-600");
      expect(c).not.toHaveClass("bg-warm-chip");
      // Same tile size as New Transaction: primary variant (h2, 12 px top/bottom).
      expect(b).toHaveClass("px-5", "py-3");
      expect(b).not.toHaveClass("p-5");
      expect(b.querySelector("h2")).not.toBeNull();
    }
  });
});

describe("BACKLOG-4110 — tiles", () => {
  it.each(ALL)("%s: warm hairline, no resting shadow, ink title", (target) => {
    const { container } = render(<Dashboard {...props()} />);
    const t = tile(container, target);
    expect(t).toHaveClass("border-warm-line");
    expect(t).not.toHaveClass("shadow-sm");
    expect(t).not.toHaveClass("border-gray-200");
    const heading = t.querySelector("h2, h3") as HTMLElement;
    expect(heading).toHaveClass("text-ink");
    expect(heading).not.toHaveClass("text-gray-900");
  });
});

describe("BACKLOG-4110 — page and greeting", () => {
  it("the Dashboard root paints the warm page, not the old gray", () => {
    const { container } = render(<Dashboard {...props()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("min-h-full", "bg-warm-page");
    expect(root).not.toHaveClass("bg-gray-50");
  });

  it("the greeting is semibold ink, not bold gray-900", () => {
    render(<Dashboard {...props()} />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveClass("text-2xl", "font-semibold", "text-ink");
    expect(h1).not.toHaveClass("font-bold");
    expect(h1).not.toHaveClass("text-gray-900");
  });
});
