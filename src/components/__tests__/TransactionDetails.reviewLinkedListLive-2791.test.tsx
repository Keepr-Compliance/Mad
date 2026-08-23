/**
 * BACKLOG-2791 — T3's "tab main list moves live" clause, against the REAL screen.
 *
 * FOUNDER WALK, 2026-08-23: "approving a suggested thread made it DISAPPEAR —
 * it left Needs Review correctly but did not appear in the Emails tab's linked
 * list until the transaction was closed and reopened."
 *
 * WHY THE ROW WAS REPORTED PASS WHILE THIS WAS BROKEN. The T3 pin
 * (reviewTransitions-2791, "approve -> LINKED") asserts `where()` — three direct
 * SQL reads of `pending_review_communications`, `communications` and
 * `ignored_communications`. It measures the DATABASE. The approve DID write the
 * link, so it was green and stayed green; it had no access to the rendered list
 * at all. The live-refresh work covered the QUEUE surfaces, which read
 * useReviewQueue; the tab's LINKED list is a different data source
 * (useTransactionDetails, fed by `transactions:getCommunications`) and nothing
 * told it to re-read.
 *
 * So the assertion here is the founder's own sentence, not a proxy for it: after
 * Confirm, the email must still be ON SCREEN. It has left the review card by
 * then, so if the linked list has not refreshed it is nowhere — which is exactly
 * what "made it DISAPPEAR" means.
 *
 * This mounts the REAL TransactionDetails. A test that stubbed the tab or drove
 * the hook directly would be re-testing my own wiring; only the real screen can
 * see one data source failing to hear another's notification.
 *
 * CONTROLS RUN (mutation applied, suite re-run, MEASURED):
 *  1. Delete the review-state subscription effect entirely -> RED, 3 of 4 tests.
 *     The survivor is the T7 restore test, and that is the correct result, not
 *     a hole: the ordinary-restore path has had its OWN silent refresh since
 *     BACKLOG-1780 and never depended on the review notification. The control
 *     therefore also proves the two paths are genuinely independent.
 *  2. Refresh only the "email" channel                     -> RED, 1 of 4 tests
 *     (the Texts-tab test — the gap the founder had not reached yet).
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: false,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-456", email: "agent@example.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "agent@example.com" }),
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

const SUBJECT = "Inspection addendum";
const TEXT_BODY = "on my way with the keys";

const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "742 Example Ave",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

/** The pending EMAIL, as the queue projects it. */
const pendingEmail = {
  id: "pending:p1",
  rowId: "p1",
  origin: "pending" as const,
  kind: "email" as const,
  transaction_id: "txn-123",
  email_id: "e1",
  thread_id: null,
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: SUBJECT,
    subtitle: "paul@example.com",
    snippet: "the signed addendum",
    occurredAt: "2026-06-01T00:00:00.000Z",
    itemCount: 1,
    threadId: "thr-addendum",
    recipients: "agent@example.com",
    cc: null,
    sender: "paul@example.com",
    hasAttachments: false,
    threadParticipants: [],
    threadMessages: [],
  },
};

/** The pending TEXT thread. */
const pendingText = {
  ...pendingEmail,
  id: "pending:t1",
  rowId: "t1",
  kind: "text" as const,
  email_id: null,
  thread_id: "th-1",
  display: {
    ...pendingEmail.display,
    title: "+15555550142",
    subtitle: "+15555550142",
    snippet: TEXT_BODY,
    threadId: "th-1",
    threadParticipants: ["+15555550142"],
    threadMessages: [
      {
        id: "m-1",
        thread_id: "th-1",
        body_text: TEXT_BODY,
        sent_at: "2026-06-01T00:00:00.000Z",
        direction: "inbound",
        participants_flat: "+15555550142",
        channel: "sms",
      },
    ],
  },
};

/** What the tab's LINKED list returns once the email is actually linked. */
const linkedEmail = {
  id: "c-1",
  communication_id: "c-1",
  user_id: "user-456",
  transaction_id: "txn-123",
  email_id: "e1",
  communication_type: "email",
  subject: SUBJECT,
  sender: "paul@example.com",
  recipients: "agent@example.com",
  body_text: "the signed addendum",
  sent_at: "2026-06-01T00:00:00.000Z",
  created_at: "2026-06-01T00:00:00.000Z",
  has_attachments: false,
};

const linkedText = {
  id: "m-1",
  communication_id: "c-2",
  user_id: "user-456",
  transaction_id: "txn-123",
  communication_type: "text",
  channel: "sms",
  body_text: TEXT_BODY,
  participants_flat: "+15555550142",
  thread_id: "th-1",
  sent_at: "2026-06-01T00:00:00.000Z",
  created_at: "2026-06-01T00:00:00.000Z",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let getCommunications: jest.Mock;
let getReviewState: jest.Mock;
let approveReviewItems: jest.Mock;
let rejectReviewItems: jest.Mock;
let syncReviewQueue: jest.Mock;

beforeAll(() => {
  getCommunications = jest.fn();
  getReviewState = jest.fn();
  approveReviewItems = jest.fn();
  rejectReviewItems = jest.fn();
  syncReviewQueue = jest.fn();
  const t = window.api.transactions as any;
  t.getCommunications = getCommunications;
  t.getReviewState = getReviewState;
  t.approveReviewItems = approveReviewItems;
  t.rejectReviewItems = rejectReviewItems;
  t.syncReviewQueue = syncReviewQueue;
  // The renderer subscribes; nothing in this suite broadcasts, which is the
  // point — the linked list must move on the LOCAL mutation too, not only when
  // the main process happens to announce one.
  t.onReviewQueueChanged = jest.fn().mockReturnValue(() => {});
  t.getRemovedContacts = jest.fn().mockResolvedValue({ success: true, removedContacts: [] });
  t.restoreContact = jest.fn();
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Linked communications the tab will see on its NEXT read. */
let linkedNow: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  linkedNow = [];

  jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  } as never);
  // Always answers with the CURRENT link state, so "did the list re-read?" is
  // the only thing that decides what renders.
  getCommunications.mockImplementation(async () => ({
    success: true,
    transaction: { communications: linkedNow, contact_assignments: [] },
  }));
  getReviewState.mockResolvedValue({ items: [pendingEmail], count: 1 });
  syncReviewQueue.mockResolvedValue({ added: 0, linked: 0, outstanding: 1 });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] } as never);
  (window.api.transactions.getAllAttachments as jest.Mock).mockResolvedValue({
    success: true,
    data: [],
  });
});

/** Wait out the initial details load, then switch tabs. */
async function openTab(name: RegExp): Promise<void> {
  await waitFor(() =>
    expect(window.api.transactions.getAllAttachments as jest.Mock).toHaveBeenCalled(),
  );
  const tab = await screen.findByRole("button", { name });
  await act(async () => {
    await userEvent.click(tab);
  });
}

describe("BACKLOG-2791 — approving moves the tab's LINKED list, live", () => {
  it("after Confirm the email is still on screen — it moves to the linked list, it does not vanish", async () => {
    // Approve links it: the queue empties and the tab's next read returns it.
    approveReviewItems.mockImplementation(async () => {
      linkedNow = [linkedEmail];
      getReviewState.mockResolvedValue({ items: [], count: 0 });
      return { success: true, approved: 1 };
    });

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await openTab(/Emails/i);

    // It starts in Needs Review, on screen.
    const card = await screen.findByTestId("email-thread-card");
    expect(card).toBeInTheDocument();
    expect(screen.getByText(SUBJECT)).toBeInTheDocument();
    expect(screen.getByTestId("needs-review-section")).toBeInTheDocument();

    await act(async () => {
      await userEvent.click(screen.getByTestId("confirm-thread-button"));
    });

    // It has left Needs Review — correct, and this half always worked.
    await waitFor(() =>
      expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument(),
    );

    // THE FOUNDER'S SENTENCE: it must not have disappeared. Without the
    // subscription the linked list still holds its stale empty read and this
    // subject is nowhere on the screen.
    await waitFor(() => expect(screen.getByText(SUBJECT)).toBeInTheDocument());
    expect(screen.getByTestId("email-thread-card")).toBeInTheDocument();
  });

  it("the linked list is RE-READ after the approval, not merely re-rendered", async () => {
    approveReviewItems.mockImplementation(async () => {
      linkedNow = [linkedEmail];
      getReviewState.mockResolvedValue({ items: [], count: 0 });
      return { success: true, approved: 1 };
    });

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await openTab(/Emails/i);
    await screen.findByTestId("email-thread-card");

    const readsBefore = getCommunications.mock.calls.length;

    await act(async () => {
      await userEvent.click(screen.getByTestId("confirm-thread-button"));
    });

    // Named directly, so a failure says WHICH link in the chain broke: the list
    // never asked the main process again.
    await waitFor(() =>
      expect(getCommunications.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    expect(
      getCommunications.mock.calls.some((c) => c[1] === "email"),
    ).toBe(true);
  });

  it("the TEXTS tab has the same wiring — approving a conversation moves it live too", async () => {
    // The gap the founder had not reached yet: same class, other medium.
    getReviewState.mockResolvedValue({ items: [pendingText], count: 1 });
    approveReviewItems.mockImplementation(async () => {
      linkedNow = [linkedText];
      getReviewState.mockResolvedValue({ items: [], count: 0 });
      return { success: true, approved: 1 };
    });

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await openTab(/Texts/i);

    await waitFor(() => expect(screen.getByTestId("needs-review-section")).toBeInTheDocument());

    // COUNTED BEFORE, NOT MERELY OBSERVED AFTER. Opening the Texts tab already
    // reads the text channel once, so "was text ever read?" is true no matter
    // what happens next — an assertion that cannot separate pass from fail. The
    // question is whether the approval caused ANOTHER read.
    const textReadsBefore = getCommunications.mock.calls.filter((c) => c[1] === "text").length;
    expect(textReadsBefore).toBeGreaterThan(0);

    await act(async () => {
      await userEvent.click(screen.getByTestId("confirm-thread-button"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        getCommunications.mock.calls.filter((c) => c[1] === "text").length,
      ).toBeGreaterThan(textReadsBefore),
    );
  });

  /**
   * T7 — REMOVED (ordinary flavour) -> LINKED, "Surfaces that must move, live:
   * Show removed, tab list".
   *
   * Same wiring class as the defect above, approached from the other direction:
   * the restore path had its OWN silent refresh (BACKLOG-1780) and so was
   * already correct, but nothing asserted the tab-list half of the row. Pinned
   * here so the two halves of T7 cannot drift — a future refactor that unified
   * these refresh paths on the review token would otherwise be free to drop it.
   */
  it("T7 — restoring an ordinary removal puts it back in the linked list, live", async () => {
    const removedRow = {
      id: "ic-1",
      email_id: "e1",
      transaction_id: "txn-123",
      subject: SUBJECT,
      sender: "paul@example.com",
      sent_at: "2026-06-01T00:00:00.000Z",
      reason: "user_removed",
      match_reason: null,
      thread_id: null,
    };
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: [removedRow],
    });
    (window.api.transactions.restoreRemovedEmail as jest.Mock).mockImplementation(async () => {
      linkedNow = [linkedEmail];
      (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
        success: true,
        removedEmails: [],
      });
      return { success: true, restoredCount: 1 };
    });

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await openTab(/Emails/i);

    await act(async () => {
      await userEvent.click(await screen.findByTestId("show-removed-emails-toggle"));
    });
    await screen.findByTestId("removed-email-card");

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-email-button"));
    });

    // It must arrive in the LINKED list, not merely leave Show removed.
    await waitFor(() => expect(screen.getByTestId("email-thread-card")).toBeInTheDocument());
    expect(screen.getByText(SUBJECT)).toBeInTheDocument();
  });
});
