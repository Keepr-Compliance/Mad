/**
 * BACKLOG-3965 PR-4b: the Dashboard composes Recent | Todo under the small row.
 *
 * - The panels render for a signed-in user with the open-at-tab helper.
 * - Clients & Contacts stays in the small row (ASSUMPTION, OPEN QUESTION
 *   35835347: option 1), not in the top row.
 * - C4 extended: no gradient or per-tile colour inside the panels either.
 * - Rows are disabled while a sync runs.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboard from "../Dashboard";

jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: 0 }),
}));
let mockSyncing = false;
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: mockSyncing }),
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

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = () => (window as any).api;

const props = (over: Record<string, unknown> = {}) => ({
  onAuditNew: jest.fn(),
  onViewTransactions: jest.fn(),
  onManageContacts: jest.fn(),
  onOpenTransaction: jest.fn(),
  user: { id: "user-1", display_name: "Test User" },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSyncing = false;
  api().featureGate.strictState.mockResolvedValue("allowed");
  api().transactions.getRecentlyOpened.mockResolvedValue({
    success: true,
    transactions: [
      {
        transactionId: "txn-r",
        propertyAddress: "1 Recent St",
        status: "active",
        openedAt: new Date().toISOString(),
        requiredDone: 1,
        requiredTotal: 2,
      },
    ],
  });
  api().checklists.listOpenRequired.mockResolvedValue({
    success: true,
    result: {
      totalCount: 1,
      items: [
        {
          itemId: "i-1",
          checklistId: "c-1",
          title: "Signed disclosure",
          transactionId: "txn-t",
          propertyAddress: "2 Todo Ave",
          closingDeadline: null,
          dealRequiredDone: 0,
          dealRequiredTotal: 1,
        },
      ],
    },
  });
});

describe("Dashboard + panels (BACKLOG-3965 PR-4b)", () => {
  it("renders Recent and Todo after the small row", async () => {
    render(<Dashboard {...props()} />);
    await screen.findByText("Signed disclosure");
    const panels = screen.getByTestId("dashboard-panels");
    const contacts = screen.getByTestId("nav-clients-contacts");
    // DOCUMENT_POSITION_FOLLOWING: the panels come after the small row.
    expect(contacts.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panels).getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(within(panels).getByRole("heading", { name: "Todo" })).toBeInTheDocument();
  });

  it("no panels without a signed-in user id or without the open helper", () => {
    const { unmount } = render(<Dashboard {...props({ user: { display_name: "No Id" } })} />);
    expect(screen.queryByTestId("dashboard-panels")).toBeNull();
    unmount();
    render(<Dashboard {...props({ onOpenTransaction: undefined })} />);
    expect(screen.queryByTestId("dashboard-panels")).toBeNull();
  });

  it("Clients & Contacts stays in the small row, not the top row (option 1)", async () => {
    render(<Dashboard {...props({ onSyncPhone: jest.fn() })} />);
    await screen.findByText("1 Recent St");
    const topRow = screen.getByTestId("nav-new-audit").parentElement as HTMLElement;
    const contacts = screen.getByTestId("nav-clients-contacts");
    expect(topRow.contains(contacts)).toBe(false);
    expect(contacts.parentElement).toHaveTextContent("Sync iPhone Messages");
    expect(within(contacts).getByText("Clients & Contacts")).toBeInTheDocument();
  });

  it("panel rows are disabled while a sync runs", async () => {
    mockSyncing = true;
    render(<Dashboard {...props()} />);
    expect(await screen.findByTestId("dashboard-recent-row")).toBeDisabled();
    expect(within(await screen.findByTestId("dashboard-todo-row")).getByRole("checkbox")).toBeDisabled();
  });

  it("C4: no gradient or per-tile colour class inside the panels", async () => {
    render(<Dashboard {...props()} />);
    await screen.findByText("Signed disclosure");
    const OFF_TOKEN = /(?:^|:)(?:bg-gradient-|from-|via-|to-)|(?:^|[:-])(?:blue|indigo|purple|green|teal|pink)-\d/;
    const found: string[] = [];
    const panels = screen.getByTestId("dashboard-panels");
    [panels, ...Array.from(panels.querySelectorAll("*"))].forEach((el) =>
      el.classList.forEach((c) => {
        if (OFF_TOKEN.test(c)) found.push(c);
      }),
    );
    expect(panels.querySelectorAll("*").length).toBeGreaterThan(10);
    expect(found).toEqual([]);
  });
});
