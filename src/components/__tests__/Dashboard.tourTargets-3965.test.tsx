/**
 * BACKLOG-3965 PR-1: guards for the Dashboard face rebuild.
 *
 * C3: every Dashboard tour step points at an element the Dashboard renders.
 *     The tour steps come from the real getDashboardTourSteps with every flag
 *     on, so a tile rebuilt without its data-tour breaks this test, not the
 *     tour in the field.
 * C4: no Dashboard-owned element keeps a gradient or a per-tile colour
 *     (blue/indigo/purple/green/teal/pink); the sync status subtree is out of
 *     scope (SR ruling: SyncStatusIndicator waits for the S8 sweep).
 * C7: the "N new" badge on New Transaction shows only with the AI add-on and
 *     a pending count, and no "Suggested" region renders in any state.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";
import { getDashboardTourSteps } from "../../config/tourSteps";
import { TitleBar } from "../../appCore/shell/TitleBar";
import { deriveIPhonePill, deriveCompanionPill } from "../../appCore/shell/syncPillState";

jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));

let mockPendingCount = 0;
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: mockPendingCount }),
}));

let mockSyncing = false;
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

let mockAiAddon = true;
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

const baseProps = {
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
};

/**
 * Targets that are not the Dashboard's to render:
 * - "body": the welcome/finish steps.
 * - profile-button: the title bar (AccountButton.tsx), outside the Dashboard.
 * - ai-detection-status: no element in src renders it today (pre-existing,
 *   found by this test; recorded on BACKLOG-3965). Drop it from this list when
 *   an element carries it again.
 * - sync-phone-card: the title-bar sync pill (BACKLOG-4115 N6), outside the
 *   Dashboard; its own test below asserts the pill carries it.
 */
const NOT_DASHBOARD_TARGETS = new Set([
  "body",
  '[data-tour="profile-button"]',
  '[data-tour="ai-detection-status"]',
  '[data-tour="sync-phone-card"]',
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = () => (window as any).api;

/** Props that also render Recent | Todo (BACKLOG-4115 N2: the transactions-card
 *  tour target is the Recent panel's "All →", which renders only with these). */
const panelProps = {
  user: { id: "user-1", display_name: "Test User" },
  onOpenTransaction: jest.fn(),
};

beforeEach(() => {
  mockPendingCount = 0;
  mockSyncing = false;
  mockAiAddon = true;
  api().featureGate.strictState.mockResolvedValue("allowed");
  api().transactions.getRecentlyOpened.mockResolvedValue({ success: true, transactions: [] });
  api().checklists.listOpenRequired.mockResolvedValue({
    success: true,
    result: { totalCount: 0, items: [] },
  });
});

describe("Dashboard tour targets (BACKLOG-3965 C3)", () => {
  it("every Dashboard tour step anchors to a rendered element", async () => {
    const { container } = render(
      <Dashboard {...baseProps} {...panelProps} onSyncPhone={jest.fn()} onSyncAndroid={jest.fn()} />,
    );
    await screen.findByText("Deals you open show here.");
    const steps = getDashboardTourSteps({
      hasAIAddon: true,
      isMacOS: true,
      notificationsEnabled: false,
      hasIPhoneSync: true,
      hasSyncVisible: true,
    });
    const targets = Array.from(
      new Set(steps.map((s) => s.target).filter((t): t is string => typeof t === "string")),
    ).filter((t) => !NOT_DASHBOARD_TARGETS.has(t));
    // The two tiles, Recent's "All →" and the sync status wrapper; an empty list would prove nothing.
    expect(targets.length).toBeGreaterThanOrEqual(4);
    const missing = targets.filter((t) => container.querySelector(t) === null);
    expect(missing).toEqual([]);
  });

  it('the "All audits" tour step points at the Recent panel\'s "All →" (BACKLOG-4115)', async () => {
    const { container } = render(<Dashboard {...baseProps} {...panelProps} />);
    await screen.findByText("Deals you open show here.");
    const targets = container.querySelectorAll('[data-tour="transactions-card"]');
    expect(targets).toHaveLength(1);
    expect(within(screen.getByTestId("dashboard-recent")).getByRole("button", { name: "All →" })).toBe(
      targets[0],
    );
  });
});

describe("tour targets outside the Dashboard (BACKLOG-4115)", () => {
  const steps = () =>
    getDashboardTourSteps({ hasAIAddon: true, isMacOS: true, notificationsEnabled: false, hasIPhoneSync: true, hasSyncVisible: true });
  const pillApp = (pill: ReturnType<typeof deriveIPhonePill>) =>
    render(
      <TitleBar
        runningInElectron
        currentStep="dashboard"
        isAuthenticated
        currentUser={{ id: "u1", email: "a@example.com" }}
        title="Dashboard"
        onOpenAccount={jest.fn()}
        sync={{ pill, onClick: jest.fn() }}
      />,
    );

  it("sync-phone-card is the iPhone title-bar pill (N6), placed below it", () => {
    const step = steps().find((s) => s.target === '[data-tour="sync-phone-card"]');
    expect(step?.placement).toBe("bottom");
    const { container } = pillApp(
      deriveIPhonePill(
        { isConnected: false, syncStatus: "idle", progress: null, syncLocked: false, lockReason: null, appleEncryptedBackup: false, isWaitingForPasscode: false, retryAvailableAt: null, needsTrust: false, driverMissing: false, toolsMissing: false, lastSyncTime: null },
        true,
        Date.now(),
      ),
    );
    const targets = container.querySelectorAll('[data-tour="sync-phone-card"]');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(screen.getByTestId("title-bar-sync-pill"));
  });

  it("the Android pill is not the iPhone step's target", () => {
    const { container } = pillApp(deriveCompanionPill());
    expect(container.querySelector('[data-tour="sync-phone-card"]')).toBeNull();
  });

  it("Clients & Contacts comes before the Recent panel's All →, both placed below (SR PR-2 note)", () => {
    const targets = steps().map((s) => s.target);
    const contacts = targets.indexOf('[data-tour="contacts-card"]');
    const all = targets.indexOf('[data-tour="transactions-card"]');
    const newTx = targets.indexOf('[data-tour="new-audit-card"]');
    expect(newTx).toBeGreaterThanOrEqual(0);
    expect(contacts).toBe(newTx + 1);
    expect(all).toBe(contacts + 1);
    expect(steps()[contacts].placement).toBe("bottom");
    expect(steps()[all].placement).toBe("bottom");
  });
});

describe('"N new" badge on New Transaction (BACKLOG-3965 C7)', () => {
  it("shows the count with the AI add-on and pending transactions", () => {
    mockPendingCount = 3;
    render(<Dashboard {...baseProps} />);
    const tile = screen.getByTestId("nav-new-audit");
    expect(tile).toHaveTextContent("3 new");
  });

  it("is absent with no pending transactions", () => {
    mockPendingCount = 0;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText(/\bnew$/)).toBeNull();
  });

  it("is absent without the AI add-on", () => {
    mockPendingCount = 3;
    mockAiAddon = false;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText("3 new")).toBeNull();
  });

  it.each([
    [true, 3],
    [false, 3],
    [true, 0],
  ])("renders no Suggested region (AI add-on %s, %i pending)", (ai, count) => {
    mockAiAddon = ai;
    mockPendingCount = count;
    render(<Dashboard {...baseProps} />);
    expect(screen.queryByText(/suggested/i)).toBeNull();
  });
});

describe("Dashboard tiles on kit tokens (BACKLOG-3965 C4)", () => {
  const OFF_TOKEN =
    /(?:^|:)(?:bg-gradient-|from-|via-|to-)|(?:^|[:-])(?:blue|indigo|purple|green|teal|pink)-\d/;

  function offTokenClasses(root: HTMLElement): string[] {
    const found: string[] = [];
    const visit = (el: Element) => {
      if (el.getAttribute("data-tour") === "sync-status") return; // S8 sweep
      el.classList.forEach((c) => {
        if (OFF_TOKEN.test(c)) found.push(c);
      });
      Array.from(el.children).forEach(visit);
    };
    visit(root);
    return found;
  }

  it.each([
    ["idle, no pending", false, 0],
    ["pending transactions (highlighted tile + badge)", false, 3],
    ["sync running (disabled tiles)", true, 0],
  ])("%s: no gradient or per-tile colour class", (_label, syncing, count) => {
    mockSyncing = syncing;
    mockPendingCount = count;
    const { container } = render(
      <Dashboard {...baseProps} onSyncPhone={jest.fn()} onSyncAndroid={jest.fn()} />,
    );
    // The tiles rendered, so an empty result is about them, not an empty page.
    // BACKLOG-4115: two tiles (New Transaction, Clients & Contacts); the sync tiles are the title-bar pill.
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2);
    expect(offTokenClasses(container)).toEqual([]);
  });
});

describe("Dashboard tiles: clicks, sync lock, highlight, focus ring (BACKLOG-3965 SR round 1)", () => {
  const props = () => ({
    onAuditNew: jest.fn(),
    onViewTransactions: jest.fn(),
    onManageContacts: jest.fn(),
    onSyncPhone: jest.fn(),
    onSyncAndroid: jest.fn(),
  });
  // BACKLOG-4115: All audits is no longer a tile; its "All →" link is covered
  // in RecentPanel-3965 (N5) and by the C3 tour test above.
  // BACKLOG-4115: the sync tiles became the title-bar pill (TitleBar.syncPill-4115).
  const TILES = ["new-audit-card", "contacts-card"] as const;
  // New Transaction opens the start-audit modal (AI add-on on, as today).
  const tile = (container: HTMLElement, tour: string) =>
    container.querySelector(`[data-tour="${tour}"], [data-testid="${tour}"]`) as HTMLElement;

  it.each([
    ["contacts-card", "onManageContacts"],
  ] as const)("clicking %s calls %s once and no other handler", async (target, handler) => {
    const p = props();
    const { container } = render(<Dashboard {...p} />);
    await userEvent.click(tile(container, target));
    for (const [name, fn] of Object.entries(p)) {
      expect(fn).toHaveBeenCalledTimes(name === handler ? 1 : 0);
    }
  });

  it("clicking New Transaction opens the start-audit modal", async () => {
    const p = props();
    const { container } = render(<Dashboard {...p} />);
    expect(screen.queryByTestId("start-new-audit-modal")).toBeNull();
    await userEvent.click(tile(container, "new-audit-card"));
    expect(screen.getByTestId("start-new-audit-modal")).toBeInTheDocument();
  });

  it.each(TILES)("%s is disabled (attribute) while a sync runs and enabled otherwise", (target) => {
    mockSyncing = true;
    const { container, unmount } = render(<Dashboard {...props()} />);
    expect(tile(container, target)).toBeDisabled();
    unmount();
    mockSyncing = false;
    const again = render(<Dashboard {...props()} />);
    expect(tile(again.container, target)).toBeEnabled();
  });

  it("New Transaction carries the highlight classes only with pending transactions", () => {
    mockPendingCount = 3;
    const on = render(<Dashboard {...props()} />);
    const hi = tile(on.container, "new-audit-card").classList;
    expect(hi.contains("border-primary-500")).toBe(true);
    expect(hi.contains("ring-primary-200")).toBe(true);
    expect(hi.contains("border-warm-line")).toBe(false);
    on.unmount();

    mockPendingCount = 0;
    const off = render(<Dashboard {...props()} />);
    const lo = tile(off.container, "new-audit-card").classList;
    expect(lo.contains("border-primary-500")).toBe(false);
    expect(lo.contains("ring-primary-200")).toBe(false);
    expect(lo.contains("border-warm-line")).toBe(true);
    expect(lo.contains("border-gray-200")).toBe(false);
  });

  it("a highlighted tile has no warm hover border; an unhighlighted one has it (BACKLOG-4110)", () => {
    mockPendingCount = 3;
    const { container } = render(<Dashboard {...props()} />);
    expect(tile(container, "new-audit-card").classList.contains("hover:border-warm-control")).toBe(false);
    expect(tile(container, "contacts-card").classList.contains("hover:border-warm-control")).toBe(true);
    expect(tile(container, "contacts-card").classList.contains("hover:border-gray-300")).toBe(false);
  });

  it.each(TILES)("%s keeps the keyboard focus ring", (target) => {
    const { container } = render(<Dashboard {...props()} />);
    const cls = tile(container, target).classList;
    expect(cls.contains("focus-visible:ring-2")).toBe(true);
    expect(cls.contains("focus-visible:ring-primary-500")).toBe(true);
  });
});
