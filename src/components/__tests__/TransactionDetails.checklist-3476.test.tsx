/**
 * BACKLOG-3476 — the Checklist tab inside TransactionDetails.
 *
 * Wrong implementations this suite is here to catch:
 *   C-I  the gate read fail-open: the tab shows while the plan is `pending` or
 *        `unknown` with no checklist.
 *   C-J  the Overview line shown while the tab is hidden (SR condition 5).
 *   C-R  the tab left active after it stops being shown — a blank panel.
 *   SR condition 1  the link picker loads emails with the LOUD loader, which on
 *        a transaction with no contacts swaps the whole modal for a spinner and
 *        unmounts the picker; and a second fetch when the Emails tab opens.
 *
 * Fixtures: `checklistFixture.ts` (generated from the real producers).
 */
import React from "react";
import { render as rtlRender, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";
import {
  fixtureDetail,
  fixtureEmailCommunications,
} from "../transactionDetailsModule/components/checklist/__tests__/checklistFixture";

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: NotificationProvider });

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: true,
    organizationId: "org-123",
    canExport: false,
    canSubmit: true,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-456", email: "test@test.com" }, isAuthenticated: true }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "test@test.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));

jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));

// The Emails tab is not under test; a stub keeps its IPC out of the counts.
jest.mock("../transactionDetailsModule/components/TransactionEmailsTab", () => ({
  TransactionEmailsTab: () => <div data-testid="emails-tab-stub" />,
}));
jest.mock("../transactionDetailsModule/components/modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: () => null,
}));

const tx = window.api.transactions as unknown as Record<string, jest.Mock>;
const checklists = () => window.api.checklists as unknown as Record<string, jest.Mock>;
const strictState = () => window.api.featureGate.strictState as jest.Mock;

const baseTransaction = {
  id: "txn-1",
  user_id: "user-456",
  property_address: "1 Probe Way",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Transaction;

const emailCalls = () =>
  tx.getCommunications.mock.calls.filter((c: unknown[]) => c[1] === "email").length;

beforeEach(() => {
  jest.clearAllMocks();
  // No contacts: the case where the loud loader's spinner replaces the modal.
  tx.getOverview = jest.fn().mockResolvedValue({ success: true, transaction: { contact_assignments: [] } });
  tx.getDetails.mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  });
  tx.getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: fixtureEmailCommunications(), contact_assignments: [] },
  });
  checklists().get.mockResolvedValue({ success: true, checklist: null });
});

describe("C-I — the tab follows the plan, never fail-open", () => {
  it("allowed + no checklist → tab shown", async () => {
    strictState().mockResolvedValue("allowed");
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    expect(await screen.findByTestId("tab-checklist")).toBeInTheDocument();
  });

  it("unknown + no checklist → no tab and no Overview line", async () => {
    strictState().mockResolvedValue("unknown");
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await waitFor(() => expect(strictState()).toHaveBeenCalled());
    await waitFor(() => expect(checklists().get).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-checklist")).not.toBeInTheDocument();
  });

  it("pending (never answers) + a checklist → no tab and no Overview line", async () => {
    strictState().mockReturnValue(new Promise(() => {}));
    checklists().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await waitFor(() => expect(checklists().get).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-checklist")).not.toBeInTheDocument();
  });
});

describe("C-J — the Overview line appears exactly when the tab does", () => {
  it("allowed + a checklist → tab and Overview line, progress from main", async () => {
    strictState().mockResolvedValue("allowed");
    checklists().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    const section = await screen.findByTestId("overview-checklist");
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    // requiredDone 1 of 2 while two items (one optional) are ticked.
    expect(section).toHaveTextContent("1 of 2 required done");
    fireEvent.click(screen.getByTestId("overview-open-checklist"));
    expect(await screen.findByTestId("checklist-panel")).toBeInTheDocument();
  });

  it("blocked + a checklist → tab read-only, Overview line shown", async () => {
    strictState().mockResolvedValue("blocked");
    checklists().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    expect(await screen.findByTestId("overview-checklist")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-checklist"));
    expect(await screen.findByTestId("checklist-readonly-notice")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-remove")).toBeInTheDocument();
  });

  it("blocked + no checklist → neither", async () => {
    strictState().mockResolvedValue("blocked");
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await waitFor(() => expect(checklists().get).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-checklist")).not.toBeInTheDocument();
  });
});

describe("C-R — the active tab falls back to Overview when the Checklist tab goes", () => {
  it("opened on the Checklist tab, and the plan answers blocked with no checklist", async () => {
    strictState().mockResolvedValue("blocked");
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} initialTab="checklist" />);
    // Overview content (the search box it opens with) is back.
    await waitFor(() => expect(screen.queryByTestId("checklist-panel")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText("Overview").className).toContain("border-green-500"),
    );
  });

  it("Remove (read-only) takes the tab away and lands on Overview", async () => {
    strictState().mockResolvedValue("blocked");
    checklists().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    checklists().remove.mockImplementation(async () => {
      checklists().get.mockResolvedValue({ success: true, checklist: null });
      return { success: true, changed: true };
    });
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("tab-checklist"));
    fireEvent.click(await screen.findByTestId("checklist-remove"));
    fireEvent.click(await screen.findByTestId("checklist-remove-confirm"));
    await waitFor(() => expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument());
    expect(screen.getByText("Overview").className).toContain("border-green-500");
    expect(screen.queryByTestId("overview-checklist")).not.toBeInTheDocument();
  });
});

describe("SR condition 1 — the picker loads emails silently", () => {
  it("no contacts: the picker stays mounted, no spinner, and the Emails tab does not fetch again", async () => {
    strictState().mockResolvedValue("allowed");
    checklists().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    let resolveEmails!: (v: unknown) => void;
    tx.getCommunications = jest.fn().mockImplementation(
      () => new Promise((r) => { resolveEmails = r; }),
    );

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("tab-checklist"));
    const item = fixtureDetail().items[1];
    fireEvent.click(await screen.findByTestId(`checklist-open-picker-${item.id}`));
    expect(await screen.findByTestId("checklist-link-picker")).toBeInTheDocument();
    expect(screen.queryByText("Loading transaction...")).not.toBeInTheDocument();

    await act(async () => {
      resolveEmails({
        success: true,
        transaction: { communications: fixtureEmailCommunications(), contact_assignments: [] },
      });
    });

    expect(screen.getByTestId("checklist-link-picker")).toBeInTheDocument();
    expect(screen.queryByText("Loading transaction...")).not.toBeInTheDocument();
    // The thread list arrived in the still-mounted picker.
    expect(await screen.findByTestId("checklist-picker-thread-thread-thr-probe")).toBeInTheDocument();
    expect(emailCalls()).toBe(1);

    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Emails"));
    expect(await screen.findByTestId("emails-tab-stub")).toBeInTheDocument();
    await act(async () => {});
    expect(emailCalls()).toBe(1);
  });
});
