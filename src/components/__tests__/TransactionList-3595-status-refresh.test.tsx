/**
 * BACKLOG-3595 — an open transaction list and an open transaction header did
 * not change when a broker review changed the deal's submission status.
 *
 * THE DEFECT. Main already emits `submission-status-changed` after it writes
 * the new status to the local row, and the preload bridge already exposes
 * `transactions.onSubmissionStatusChanged`. The only renderer subscriber lived
 * in `useSubmissionSync`, used only by `Transactions.tsx`, which nothing
 * renders. So neither surface the user can reach was listening.
 *
 * TWO subscribers, because there are two copies of the row:
 *   • the list's rows (`useTransactionList`) — a silent re-read fixes the chip;
 *   • the open details' local `transaction` state, seeded from the list row at
 *     open and never rewritten by a list re-read — it needs its own subscriber.
 *
 * REQUIREMENT 3 (the host is the real mounted one) is proven in two hops,
 * joined by module identity:
 *   hop 1 — `src/appCore/__tests__/AppModals.test.tsx`, "should render
 *           TransactionList when showTransactions is true…": the mounted
 *           AppModals renders the TransactionList module.
 *   hop 2 — this suite drives that same TransactionList module, unmocked, and
 *           opens the real TransactionDetails by clicking the card.
 * Before the fix the only subscriber was in the unrendered `Transactions.tsx`,
 * and hop 2 was red.
 *
 * The `onSubmissionStatusChanged` mock FANS OUT like the real preload (one
 * `ipcRenderer.on` per subscriber): it holds a Set, and each unsubscribe
 * removes only the callback it added. A single-slot mock lets the last
 * subscriber win and cannot show one event reaching both surfaces.
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

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

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

// TASK-2159: LicenseGate reads through useFeatureGate; the existing
// TransactionList suites mock it via the "@/" alias, matched here.
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------

type StatusChanged = {
  transactionId: string;
  propertyAddress: string;
  oldStatus: string;
  newStatus: string;
  reviewNotes?: string;
  title: string;
  message: string;
};

const USER_ID = "user-3595";
const TXN_A = "txn-3595-a";
const TXN_B = "txn-3595-b";
const ADDR_A = "4 Probe Way";
const ADDR_B = "9 Other Court";

const txn = (
  id: string,
  address: string,
  submissionStatus: string,
  lastReviewNotes: string | null = null,
): Transaction =>
  ({
    id,
    user_id: USER_ID,
    property_address: address,
    transaction_type: "purchase",
    status: "active",
    detection_status: "confirmed",
    submission_status: submissionStatus,
    last_review_notes: lastReviewNotes,
    // Cast: a deliberately partial row carrying only what the screens render.
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
  reviewNotes: "fix the addendum",
  title: "Changes requested",
  message: "STATUS-EVENT-3595",
});

describe("BACKLOG-3595: open list and header refresh on submission status change", () => {
  const listeners = new Set<(data: StatusChanged) => void>();
  const fire = async (data: StatusChanged) => {
    await act(async () => {
      for (const cb of Array.from(listeners)) cb(data);
    });
  };

  const api = () =>
    window.api as unknown as { transactions: Record<string, jest.Mock> };

  /** The status the "server" row currently carries, per transaction id. */
  let serverRows: Map<string, Transaction>;

  beforeEach(() => {
    jest.clearAllMocks();
    listeners.clear();

    serverRows = new Map([
      [TXN_A, txn(TXN_A, ADDR_A, "submitted")],
      [TXN_B, txn(TXN_B, ADDR_B, "submitted")],
    ]);

    api().transactions.onSubmissionStatusChanged.mockImplementation(
      (cb: (data: StatusChanged) => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    );
    jest.mocked(window.api.onTransactionScanProgress).mockReturnValue(jest.fn());

    api().transactions.getAll.mockImplementation(async () => ({
      success: true,
      transactions: Array.from(serverRows.values()),
    }));
    // `getOverview` is not part of the shared window.api mock.
    api().transactions.getOverview = jest.fn(async (id: string) => {
      const row = serverRows.get(id);
      return row ? detail(row) : { success: false };
    });
    api().transactions.getDetails.mockImplementation(async (id: string) => {
      const row = serverRows.get(id);
      return row ? detail(row) : { success: false };
    });
  });

  /** The broker reviewed deal `id`: main writes the row, then emits. */
  const brokerRequestsChanges = (id: string) => {
    const row = serverRows.get(id)!;
    serverRows.set(
      id,
      txn(id, row.property_address as string, "needs_changes", "fix the addendum"),
    );
  };

  /**
   * The header renders the badge twice (responsive layouts). Returns a stand-in
   * whose text is every copy joined, so `toHaveTextContent` checks all of them
   * and fails if any copy is stale.
   */
  const headerBadge = (): HTMLElement => {
    const copies = within(screen.getByTestId("transaction-details-modal")).getAllByTestId(
      "submission-status-badge",
    );
    const labels = copies.map((c) => c.textContent ?? "");
    const stale = labels.find((l) => l !== labels[0]);
    const joined = document.createElement("span");
    joined.textContent = stale === undefined ? labels[0] : `MIXED: ${labels.join(" | ")}`;
    return joined;
  };

  const noticeCount = (): number =>
    document.querySelectorAll('[role="alert"], [data-testid^="notification-"]:not([data-testid="notification-container"])').length;

  const renderList = (props: Partial<React.ComponentProps<typeof TransactionList>> = {}) =>
    render(
      <TransactionList userId={USER_ID} provider="google" onClose={jest.fn()} {...props} />,
    );

  const openDetails = async (address: string) => {
    fireEvent.click(screen.getAllByText(address)[0]);
    await screen.findByTestId("transaction-details-modal");
    await waitFor(() => expect(headerBadge()).toHaveTextContent("Under Review"));
  };

  // C1 — one event reaches BOTH surfaces, in place, and the list re-read does
  // not revert the header through TransactionDetails' prop-sync effect.
  it("one event flips the list chip and the open header, without a remount", async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    await openDetails(ADDR_A);

    // Both surfaces are subscribed: the list and the open header.
    expect(listeners.size).toBe(2);

    const chipsBefore = screen.getAllByTestId("submission-status-chip");
    const modalBefore = screen.getByTestId("transaction-details-modal");
    expect(chipsBefore[0]).toHaveTextContent("Under Review");

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    // In place: one of the chip NODES captured before the event now reads
    // "Changes Requested" — a remounted list would have replaced them.
    await waitFor(() =>
      expect(
        chipsBefore.some(
          (c) => c.isConnected && c.textContent?.includes("Changes Requested"),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(headerBadge()).toHaveTextContent("Changes Requested"));

    // The review notes panel follows the status.
    expect(
      within(screen.getByTestId("transaction-details-modal")).getAllByText(/fix the addendum/)
        .length,
    ).toBeGreaterThan(0);

    // Updated in place: same modal node (no reopen) — a remount replaces it.
    expect(screen.getByTestId("transaction-details-modal")).toBe(modalBefore);

    // Let the list re-read settle, then confirm the header did not revert.
    await waitFor(() => expect(api().transactions.getAll.mock.calls.length).toBeGreaterThan(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(headerBadge()).toHaveTextContent("Changes Requested");

    // The header re-read uses getOverview; get-details would start a sync.
    expect(api().transactions.getOverview).toHaveBeenCalledWith(TXN_A);
  });

  // List hop on its own (details closed).
  it("an open list flips the chip with the details closed", async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    expect(listeners.size).toBe(1);
    const readsBefore = api().transactions.getAll.mock.calls.length;

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));

    await waitFor(() =>
      expect(api().transactions.getAll.mock.calls.length).toBe(readsBefore + 1),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("submission-status-chip")
          .some((c) => c.textContent?.includes("Changes Requested")),
      ).toBe(true),
    );
  });

  // C2 — closing the details releases the header's subscription (and only it).
  it("closing the details removes the header listener", async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    await openDetails(ADDR_A);
    expect(listeners.size).toBe(2);

    fireEvent.click(screen.getAllByTestId("transaction-details-close")[0]);
    await waitFor(() =>
      expect(screen.queryByTestId("transaction-details-modal")).not.toBeInTheDocument(),
    );
    expect(listeners.size).toBe(1);

    // And no header re-read happens for an event after close.
    const overviewBefore = api().transactions.getOverview.mock.calls.length;
    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(api().transactions.getOverview.mock.calls.length).toBe(overviewBefore);
  });

  // C3 — an event for another deal does not re-read or change the open one.
  it("ignores an event for a different transaction", async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    await openDetails(ADDR_A);
    // The header IS listening — otherwise "nothing happened" below is vacuous.
    expect(listeners.size).toBe(2);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const overviewBefore = api().transactions.getOverview.mock.calls.length;

    brokerRequestsChanges(TXN_A); // A's row changed on the server…
    await fire(event(TXN_B, ADDR_B)); // …but the event is for B.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api().transactions.getOverview.mock.calls.length).toBe(overviewBefore);
    expect(headerBadge()).toHaveTextContent("Under Review");
  });

  // C4 — the details are handed a different transaction WITHOUT a remount
  // (TransactionList's initialTransaction effect does this with no key bump).
  // The subscriber must follow the new id, not the one captured at mount.
  it("follows the current transaction when swapped without a remount", async () => {
    const a = txn(TXN_A, ADDR_A, "submitted");
    const b = txn(TXN_B, ADDR_B, "submitted");
    const { rerender } = renderList({ initialTransaction: a });
    const modal = await screen.findByTestId("transaction-details-modal");
    await waitFor(() => expect(headerBadge()).toHaveTextContent("Under Review"));

    rerender(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransaction={b}
      />,
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("transaction-details-modal")).getAllByText(ADDR_B).length,
      ).toBeGreaterThan(0),
    );
    // Same modal node: the swap did not remount the details.
    expect(screen.getByTestId("transaction-details-modal")).toBe(modal);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    brokerRequestsChanges(TXN_B);
    await fire(event(TXN_B, ADDR_B));

    await waitFor(() => expect(api().transactions.getOverview).toHaveBeenCalledWith(TXN_B));
    await waitFor(() => expect(headerBadge()).toHaveTextContent("Changes Requested"));
  });

  // C5 — requirement 4: no proactive notice. Asserted by role / test id, not by
  // the event's message text, so a notice worded any other way is still caught.
  it("raises no alert or notification", async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByText(ADDR_A).length).toBeGreaterThan(0));
    await openDetails(ADDR_A);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = noticeCount();

    brokerRequestsChanges(TXN_A);
    await fire(event(TXN_A, ADDR_A));
    await waitFor(() => expect(headerBadge()).toHaveTextContent("Changes Requested"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(noticeCount()).toBe(before);
    expect(screen.queryByText(/STATUS-EVENT-3595/)).toBeNull();
  });
});
