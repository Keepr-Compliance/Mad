/**
 * BACKLOG-3595 follow-up — the Checklist tab of an open transaction refreshes
 * in place when broker checklists arrive.
 *
 * Two events reach TransactionDetails: `submission-status-changed` (a broker
 * review; main pulls the broker checklist and commits it before it emits) and
 * `transaction-checklists-changed` (an owed pull landed later, no status
 * change). Both re-read through `refresh`, which never shows loading and keeps
 * the last good checklist when the read fails.
 *
 * Drives the real tree: TransactionList -> card click -> TransactionDetails ->
 * Checklist tab. Harness copied from TransactionList-3595-status-refresh;
 * checklist envelopes from the producer-generated checklistFixture.ts.
 *
 * Wrong implementations this suite catches (each mutation run, see
 * pm_comments on BACKLOG-3595):
 *   P1/P2  listener inside the tab only: Overview and the tab gate go stale
 *   P3     refresh through `loading`: rows remount, the unsaved note is lost
 *   P4     re-read before the transaction guard
 *   P5     re-read chained inside the header re-read: a failed header read skips it
 *   P7     a failed background read replaces the checklist with the error
 *   C1-C6  the checklists-changed event is not wired, unguarded, or not keep-last-good
 */
import React from "react";
import {
  render as rtlRender,
  screen,
  waitFor,
  act,
  within,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionList from "../TransactionList";
import type { Transaction } from "../../../electron/types/models";
import {
  envelopeOf,
  fixtureAttachments,
  fixtureChecklist,
} from "../transactionDetailsModule/components/checklist/__tests__/checklistFixture";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

jest.mock("../../contexts/StrictFeatureContext", () => ({
  ...jest.requireActual("../../contexts/StrictFeatureContext"),
  useSessionStrictFeatureState: () => "allowed",
}));

// The Checklist tab reads the viewer (TransactionChecklistTab.tsx:98); the real
// app mounts it under AuthProvider. Mock copied from the 3477 gate suite.
jest.mock("../../contexts/AuthContext", () => ({
  ...jest.requireActual("../../contexts/AuthContext"),
  useAuth: () => ({ currentUser: { id: "user-3595b", email: "t@t.com" } }),
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

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

type StatusChanged = {
  transactionId: string;
  propertyAddress: string;
  oldStatus: string;
  newStatus: string;
  reviewNotes?: string;
  title: string;
  message: string;
};

const USER_ID = "user-3595b";
const TXN_A = "txn-3595b-a";
const TXN_B = "txn-3595b-b";
const ADDR_A = "4 Probe Way";
const ADDR_B = "9 Other Court";

const txn = (id: string, address: string, submissionStatus: string, notes: string | null = null): Transaction =>
  ({
    id,
    user_id: USER_ID,
    property_address: address,
    transaction_type: "purchase",
    status: "active",
    detection_status: "confirmed",
    submission_status: submissionStatus,
    last_review_notes: notes,
  }) as unknown as Transaction;

const detail = (t: Transaction) => ({
  success: true,
  transaction: { ...t, communications: [], contact_assignments: [] },
});

const event = (transactionId: string, address: string): StatusChanged => ({
  transactionId,
  propertyAddress: address,
  oldStatus: "submitted",
  newStatus: "needs_changes",
  reviewNotes: "add the inspection",
  title: "Changes requested",
  message: "STATUS-EVENT-3595B",
});

// Agent's own checklist (fixture [0], "Probe template") before; the broker adds
// fixture [1], "Other probe template", at review.
const AGENT = fixtureChecklist(0);
const BROKER = fixtureChecklist(1);
const BROKER_NAME = BROKER.checklist.templateName;
const NOTE_ITEM = AGENT.items[1]; // required, no note

describe("BACKLOG-3595: broker-added checklist appears in an open transaction", () => {
  const listeners = new Set<(data: StatusChanged) => void>();
  const fire = async (data: StatusChanged) => {
    await act(async () => {
      for (const cb of Array.from(listeners)) cb(data);
    });
  };
  const changedListeners = new Set<(data: { transactionId: string }) => void>();
  const fireChanged = async (transactionId: string) => {
    await act(async () => {
      for (const cb of Array.from(changedListeners)) cb({ transactionId });
    });
  };
  const api = () => window.api as unknown as { transactions: Record<string, jest.Mock>; checklists: Record<string, jest.Mock> };

  let serverRows: Map<string, Transaction>;
  let serverChecklists: Map<string, ReturnType<typeof envelopeOf>>;

  beforeEach(() => {
    jest.clearAllMocks();
    listeners.clear();
    changedListeners.clear();
    serverRows = new Map([
      [TXN_A, txn(TXN_A, ADDR_A, "submitted")],
      [TXN_B, txn(TXN_B, ADDR_B, "submitted")],
    ]);
    serverChecklists = new Map([
      [TXN_A, envelopeOf([AGENT])],
      [TXN_B, envelopeOf([AGENT])],
    ]);
    api().transactions.onSubmissionStatusChanged.mockImplementation((cb: (d: StatusChanged) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    });
    api().transactions.onChecklistsChanged.mockImplementation(
      (cb: (d: { transactionId: string }) => void) => {
        changedListeners.add(cb);
        return () => {
          changedListeners.delete(cb);
        };
      },
    );
    jest.mocked(window.api.onTransactionScanProgress).mockReturnValue(jest.fn());
    api().transactions.getAll.mockImplementation(async () => ({
      success: true,
      transactions: Array.from(serverRows.values()),
    }));
    api().transactions.getOverview = jest.fn(async (id: string) => {
      const row = serverRows.get(id);
      return row ? detail(row) : { success: false };
    });
    api().transactions.getDetails.mockImplementation(async (id: string) => {
      const row = serverRows.get(id);
      return row ? detail(row) : { success: false };
    });
    // IPC answers on a later macrotask, never in the same microtask queue: an
    // instant mock lets React batch a transient `loading` frame away.
    api().checklists.get.mockImplementation(async ({ transactionId }: { transactionId: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: true, checklists: serverChecklists.get(transactionId) ?? envelopeOf([]) };
    });
  });

  /** Main: pull writes the broker checklist, then the status, then emits. */
  const brokerRequestsChanges = (id: string) => {
    serverChecklists.set(id, envelopeOf([AGENT, BROKER]));
    const row = serverRows.get(id)!;
    serverRows.set(id, txn(id, row.property_address as string, "needs_changes", "add the inspection"));
  };

  const modal = () => within(screen.getByTestId("transaction-details-modal"));

  const openDetails = async (address: string) => {
    render(<TransactionList userId={USER_ID} provider="google" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByText(address).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(address)[0]);
    await screen.findByTestId("transaction-details-modal");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  };

  const openChecklistTab = async () => {
    fireEvent.click(screen.getByTestId("tab-checklist"));
    await waitFor(() => expect(modal().getAllByText(AGENT.checklist.templateName).length).toBeGreaterThan(0));
  };

  it("P1: Checklist tab open — broker checklist appears in place", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    expect(modal().queryAllByText(BROKER_NAME)).toHaveLength(0);
    const modalBefore = screen.getByTestId("transaction-details-modal");

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    expect(screen.getByTestId("transaction-details-modal")).toBe(modalBefore);
  });

  it("P2: Overview tab open — overview checklist section follows", async () => {
    await openDetails(ADDR_A);
    await waitFor(() => expect(screen.getByTestId("overview-checklist")).toBeInTheDocument());
    expect(screen.getByTestId("overview-checklist")).not.toHaveTextContent("2 checklists");
    const captionBefore = screen.getByTestId("overview-checklist").textContent;

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    await waitFor(() => expect(screen.getByTestId("overview-checklist").textContent).not.toBe(captionBefore));
  });

  it("P3: an unsaved note draft survives the refresh", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    fireEvent.click(screen.getByTestId(`checklist-add-note-${NOTE_ITEM.id}`));
    const box = screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UNSAVED-DRAFT-3595B" } });

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    const after = screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement;
    expect(after.value).toBe("UNSAVED-DRAFT-3595B");
    expect(api().checklists.setItemNote).not.toHaveBeenCalled();
  });

  it("P4: an event for another transaction does not re-read the checklists", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    expect(listeners.size).toBe(2);
    const before = api().checklists.get.mock.calls.length;

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_B, ADDR_B));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api().checklists.get.mock.calls.length).toBe(before);
    expect(modal().queryAllByText(BROKER_NAME)).toHaveLength(0);
  });

  it("P5: a failed header re-read still refreshes the checklists", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    api().transactions.getOverview.mockImplementation(async () => {
      throw new Error("overview read failed");
    });

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
  });

  it("P7: a failed background re-read keeps the open checklist and the draft", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    fireEvent.click(screen.getByTestId(`checklist-add-note-${NOTE_ITEM.id}`));
    const box = screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UNSAVED-DRAFT-P7" } });
    api().checklists.get.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: false, error: "read failed" };
    });
    await fire(event(TXN_A, ADDR_A));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(modal().getAllByText(AGENT.checklist.templateName).length).toBeGreaterThan(0);
    expect((screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement).value).toBe("UNSAVED-DRAFT-P7");
  });

  it("P6: no alert or notification", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    const count = () =>
      document.querySelectorAll('[role="alert"], [data-testid^="notification-"]:not([data-testid="notification-container"])').length;
    const before = count();
    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));
    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(count()).toBe(before);
  });

  /** Main: an owed pull landed the broker checklist; the status did not change. */
  const owedPullLands = (id: string) => {
    serverChecklists.set(id, envelopeOf([AGENT, BROKER]));
  };

  it("C1: checklists-changed with the tab open: broker checklist appears in place, no header re-read", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    const modalBefore = screen.getByTestId("transaction-details-modal");
    const overviewCalls = api().transactions.getOverview.mock.calls.length;

    owedPullLands(TXN_A);
    await fireChanged(TXN_A);

    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    expect(screen.getByTestId("transaction-details-modal")).toBe(modalBefore);
    expect(api().transactions.getOverview.mock.calls.length).toBe(overviewCalls);
  });

  it("C2: checklists-changed on the Overview tab: the overview checklist section follows", async () => {
    await openDetails(ADDR_A);
    await waitFor(() => expect(screen.getByTestId("overview-checklist")).toBeInTheDocument());
    const captionBefore = screen.getByTestId("overview-checklist").textContent;

    owedPullLands(TXN_A);
    await fireChanged(TXN_A);

    await waitFor(() => expect(screen.getByTestId("overview-checklist").textContent).not.toBe(captionBefore));
  });

  it("C3: checklists-changed for another transaction does not re-read", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    expect(changedListeners.size).toBe(1);
    const before = api().checklists.get.mock.calls.length;

    owedPullLands(TXN_A);
    await fireChanged(TXN_B);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api().checklists.get.mock.calls.length).toBe(before);
    expect(modal().queryAllByText(BROKER_NAME)).toHaveLength(0);
  });

  it("C4: checklists-changed keeps an unsaved note draft, and a failed read keeps the checklist", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    fireEvent.click(screen.getByTestId(`checklist-add-note-${NOTE_ITEM.id}`));
    fireEvent.change(screen.getByLabelText(`Note for ${NOTE_ITEM.title}`), {
      target: { value: "UNSAVED-DRAFT-C4" },
    });

    owedPullLands(TXN_A);
    await fireChanged(TXN_A);
    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    expect((screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement).value).toBe(
      "UNSAVED-DRAFT-C4",
    );

    api().checklists.get.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: false, error: "read failed" };
    });
    await fireChanged(TXN_A);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0);
    expect((screen.getByLabelText(`Note for ${NOTE_ITEM.title}`) as HTMLTextAreaElement).value).toBe(
      "UNSAVED-DRAFT-C4",
    );
    expect(api().checklists.setItemNote).not.toHaveBeenCalled();
  });

  it("C5: checklists-changed raises no alert or notification", async () => {
    await openDetails(ADDR_A);
    await openChecklistTab();
    const count = () =>
      document.querySelectorAll('[role="alert"], [data-testid^="notification-"]:not([data-testid="notification-container"])').length;
    const before = count();
    owedPullLands(TXN_A);
    await fireChanged(TXN_A);
    await waitFor(() => expect(modal().getAllByText(BROKER_NAME).length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(count()).toBe(before);
  });

  /**
   * BACKLOG-3764 (SR PR review pm_comments e1199f9f on BACKLOG-3764): the
   * Checklist tab gets the FULL attachment list, never only the ones inside the
   * deal's dates. Main asks about out-of-dates evidence at link time; a picker
   * fed the in-window list would hide it instead of asking.
   * Wrong build this catches: `attachments={attachments.filter((a) =>
   * attachmentsInWindowIds.has(a.id))}` on the Checklist tab.
   */
  it("BACKLOG-3764: the link picker offers an attachment outside the deal's dates", async () => {
    const all = fixtureAttachments();
    const [inside, outside] = [all[0], all[1]];
    serverRows.set(TXN_A, {
      ...txn(TXN_A, ADDR_A, "submitted"),
      started_at: "2026-09-01",
      closed_at: "2026-09-30",
    } as unknown as Transaction);
    // The windowed read (dates passed) returns only `inside`; the full read returns both.
    api().transactions.getAllAttachments.mockImplementation(
      async (_id: string, start?: string, end?: string) => ({
        success: true,
        data: start || end ? [inside] : [inside, outside],
      }),
    );
    await openDetails(ADDR_A);
    await openChecklistTab();
    const item = AGENT.items[0];
    fireEvent.click(modal().getByTestId(`checklist-open-picker-${item.id}`));
    await screen.findByTestId("checklist-picker-attachments");
    // PRECONDITION: the windowed read happened, so in-window ids exist to filter by.
    expect(api().transactions.getAllAttachments.mock.calls.some((c: unknown[]) => c[1] || c[2])).toBe(true);
    await waitFor(() => expect(screen.getByTestId(`checklist-picker-attachment-${inside.id}`)).toBeInTheDocument());
    expect(screen.getByTestId(`checklist-picker-attachment-${outside.id}`)).toBeInTheDocument();
  });

  it("C6: the checklists-changed listener is removed when the details close", async () => {
    const view = render(<TransactionList userId={USER_ID} provider="google" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(ADDR_A)[0]);
    await screen.findByTestId("transaction-details-modal");
    expect(changedListeners.size).toBe(1);
    view.unmount();
    expect(changedListeners.size).toBe(0);
  });
});
