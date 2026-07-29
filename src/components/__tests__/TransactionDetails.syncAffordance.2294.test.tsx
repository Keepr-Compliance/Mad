/**
 * BACKLOG-2294 — TransactionDetails must drive the Texts sync button's active
 * affordance from a BACKGROUND messages sync being in flight, not only from a
 * user click. It derives that in-flight signal from the existing 2292 lifecycle:
 * the macOS importer streams `messages:import-progress` while it runs, and
 * `onMessagesSyncComplete` marks it done. This test proves the derived
 * `messagesSyncInFlight` prop flips true on progress and back to false on
 * completion — with no user interaction.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";

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
  useAuth: () => ({
    currentUser: { id: "user-456", email: "test@test.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "test@test.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));

// Stub the Texts tab so we can read the derived `messagesSyncInFlight` prop
// without depending on the tab's internal markup.
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../transactionDetailsModule/components/TransactionMessagesTab", () => ({
  TransactionMessagesTab: (props: any) => (
    <div data-testid="messages-tab" data-in-flight={String(props.messagesSyncInFlight)} />
  ),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ImportProgress {
  phase: "deleting" | "importing" | "attachments";
  current: number;
  total: number;
  percent: number;
}
type CompletePayload = { transactionId: string | null; ran: boolean; imported: number };

const getAllAttachments = window.api.transactions.getAllAttachments as jest.Mock;

const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "123 Main Street",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("TransactionDetails — messagesSyncInFlight is driven by the 2292 lifecycle (BACKLOG-2294)", () => {
  let progressCbs: Array<(p: ImportProgress) => void>;
  let completeCbs: Array<(d: CompletePayload) => void>;

  beforeEach(() => {
    jest.clearAllMocks();
    progressCbs = [];
    completeCbs = [];

    getAllAttachments.mockResolvedValue({ success: true, data: [] });
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    window.api.contacts.getAll.mockResolvedValue({ success: true, contacts: [] });

    // Capture the callbacks the component registers so the test can fire the
    // background messages-sync lifecycle events itself.
    (window.api.messages as unknown as { onImportProgress: jest.Mock }).onImportProgress =
      jest.fn((cb: (p: ImportProgress) => void) => {
        progressCbs.push(cb);
        return () => {};
      });
    (window.api.transactions as unknown as { onMessagesSyncComplete: jest.Mock }).onMessagesSyncComplete =
      jest.fn((cb: (d: CompletePayload) => void) => {
        completeCbs.push(cb);
        return () => {};
      });
  });

  it("flips true on import-progress and back to false on messages-sync-complete (no user click)", async () => {
    render(
      <TransactionDetails
        transaction={baseTransaction}
        onClose={jest.fn()}
        onTransactionUpdated={jest.fn()}
        onShowSuccess={jest.fn()}
      />,
    );

    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());

    // Open the Texts tab so the (stubbed) tab renders and we can read the prop.
    await userEvent.click(screen.getByText("Texts"));
    const tab = await screen.findByTestId("messages-tab");
    expect(tab).toHaveAttribute("data-in-flight", "false");

    // The component must have subscribed to the import-progress stream.
    expect(progressCbs.length).toBeGreaterThan(0);

    // A background messages import starts streaming progress → button goes active.
    act(() => {
      progressCbs.forEach((cb) => cb({ phase: "importing", current: 1, total: 10, percent: 10 }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("messages-tab")).toHaveAttribute("data-in-flight", "true"),
    );

    // Completion clears it.
    expect(completeCbs.length).toBeGreaterThan(0);
    act(() => {
      completeCbs.forEach((cb) => cb({ transactionId: null, ran: true, imported: 5 }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("messages-tab")).toHaveAttribute("data-in-flight", "false"),
    );
  });
});
