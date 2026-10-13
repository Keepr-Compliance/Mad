/**
 * BACKLOG-3910 (slice b) — C-R3g': the deal screen's locked state.
 *
 * Every submission status the schema allows, plus NULL: a locked deal shows ONE
 * notice (its reason's sentence) and its Sync button is disabled with the
 * reason's tooltip; an open deal shows no notice and an enabled Sync button.
 * The mapping is the one the main process enforces (`src/utils/dealLock.ts`,
 * kept equal to the canonical copy by `dealLock.parity.test.ts`).
 */
import React from "react";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../../electron/types/models";
import {
  DEAL_LOCK_EDIT_TOOLTIP,
  DEAL_LOCK_NOTICE_COPY,
  DEAL_LOCK_SYNC_TOOLTIP,
} from "../../utils/dealLock";
import {
  envelopeOf,
  fixtureDetail,
} from "../transactionDetailsModule/components/checklist/__tests__/checklistFixture";

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper: NotificationProvider });

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

// Row copied from TransactionDetails.checklist-3476.test.tsx (originally AuditTransactionModal.test.tsx).
const contactAssignments = [
  {
    id: "assign-1",
    contact_id: "contact-1",
    contact_name: "John Doe",
    contact_email: "john@example.com",
    role: "client",
    specific_role: "client",
    is_primary: 1,
  },
];

function txn(submissionStatus: string | null): Transaction {
  return {
    id: "txn-123",
    user_id: "user-456",
    property_address: "123 Main Street",
    transaction_type: "purchase",
    status: "active",
    submission_status: submissionStatus,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  } as unknown as Transaction;
}

const CASES: Array<[string | null, "submitted" | "sealed" | null]> = [
  ["not_submitted", null],
  ["submitted", "submitted"],
  ["under_review", "submitted"],
  ["needs_changes", null],
  ["resubmitted", "submitted"],
  ["approved", "sealed"],
  ["rejected", null],
  [null, null],
];

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.getAllAttachments as jest.Mock).mockResolvedValue({ success: true, data: [] });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
});

describe("C-R3g': locked-deal notice and Sync button, per submission status", () => {
  it.each(CASES)("%s -> %s", async (status, reason) => {
    const t = txn(status);
    (window.api.transactions as unknown as { getOverview: jest.Mock }).getOverview = jest
      .fn()
      .mockResolvedValue({ success: true, transaction: { contact_assignments: contactAssignments } });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...t, communications: [], contact_assignments: contactAssignments },
    } as never);

    render(<TransactionDetails transaction={t} onClose={jest.fn()} />);

    const syncTitle = reason ? DEAL_LOCK_SYNC_TOOLTIP[reason] : "Sync Communications";
    const sync = await screen.findByTitle(syncTitle);

    if (reason) {
      expect(sync).toBeDisabled();
      const notices = screen.getAllByTestId("deal-lock-notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toHaveTextContent(DEAL_LOCK_NOTICE_COPY[reason]);
    } else {
      await waitFor(() => expect(sync).toBeEnabled());
      expect(screen.queryByTestId("deal-lock-notice")).toBeNull();
    }
  });
});

describe("C-R3g': the Emails and Texts tabs' Sync buttons follow the same lock", () => {
  async function renderWith(status: string): Promise<void> {
    const t = txn(status);
    (window.api.transactions as unknown as { getOverview: jest.Mock }).getOverview = jest
      .fn()
      .mockResolvedValue({ success: true, transaction: { contact_assignments: contactAssignments } });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...t, communications: [], contact_assignments: contactAssignments },
    } as never);
    render(<TransactionDetails transaction={t} onClose={jest.fn()} />);
    // Loaded once the overview's Sync button (which needs the contact) is on screen.
    await screen.findByTitle(
      status === "submitted" ? DEAL_LOCK_SYNC_TOOLTIP.submitted : "Sync Communications",
    );
  }

  it("submitted: Emails and Texts Sync are disabled with the tooltip", async () => {
    await renderWith("submitted");
    const tooltip = DEAL_LOCK_SYNC_TOOLTIP.submitted;

    (await screen.findByText("Texts")).click();
    const textSync = await screen.findAllByTestId("sync-messages-button");
    for (const b of textSync) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute("title", tooltip);
    }

    (await screen.findByText("Emails")).click();
    const emailSync = await screen.findAllByTitle(tooltip);
    expect(emailSync.length).toBeGreaterThan(0);
    for (const b of emailSync) expect(b).toBeDisabled();
  });

  it("REVERSE: needs_changes: the Texts Sync button is enabled", async () => {
    await renderWith("needs_changes");

    (await screen.findByText("Texts")).click();
    const textSync = await screen.findAllByTestId("sync-messages-button");
    for (const b of textSync) await waitFor(() => expect(b).toBeEnabled());
    expect(screen.queryByTitle(DEAL_LOCK_SYNC_TOOLTIP.submitted)).toBeNull();
  });
});

/**
 * BACKLOG-3910 fix-up (founder 2026-10-11): a locked deal is read-only. Edit
 * contacts and both Attach buttons are disabled with the reason's tooltip on a
 * locked deal, and enabled on an open one. Every status is swept, so the
 * needs_changes / rejected boundary is covered. The main-process handlers
 * refuse as well (electron/handlers/__tests__/dealLockHandlers-3910.test.ts).
 */
describe("C-c (UI): Edit contacts and Attach follow the read-only lock, per submission status", () => {
  it.each(CASES)("%s -> %s", async (status, reason) => {
    const t = txn(status);
    (window.api.transactions as unknown as { getOverview: jest.Mock }).getOverview = jest
      .fn()
      .mockResolvedValue({ success: true, transaction: { contact_assignments: contactAssignments } });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...t, communications: [], contact_assignments: contactAssignments },
    } as never);
    // The Attach buttons render only with a user id (TransactionEmailsTab / MessagesTab).
    render(<TransactionDetails transaction={t} onClose={jest.fn()} userId="user-456" />);

    const expectLock = (b: HTMLElement) => {
      if (reason) {
        expect(b).toBeDisabled();
        expect(b).toHaveAttribute("title", DEAL_LOCK_EDIT_TOOLTIP[reason]);
      } else {
        expect(b).toBeEnabled();
        expect(b.getAttribute("title") ?? "").not.toMatch(/Read-only/);
      }
    };

    const edit = await screen.findByTestId("edit-contacts-button");
    expectLock(edit);
    // Slice d (founder 2026-10-12): Edit Summary (deal details, audit dates) too.
    expectLock(await screen.findByTestId("edit-summary-button"));

    (await screen.findByText("Emails")).click();
    const attachEmails = await screen.findAllByTestId("attach-emails-button");
    expect(attachEmails.length).toBeGreaterThan(0);
    attachEmails.forEach(expectLock);

    (await screen.findByText("Texts")).click();
    const attachTexts = await screen.findAllByTestId("attach-messages-button");
    expect(attachTexts.length).toBeGreaterThan(0);
    attachTexts.forEach(expectLock);
  });

  it("the notice no longer says manual attaching still works, and says read-only", () => {
    for (const text of Object.values(DEAL_LOCK_NOTICE_COPY)) {
      expect(text).not.toMatch(/attach them yourself/i);
      expect(text).toMatch(/read-only/);
    }
  });
});

/**
 * BACKLOG-3910 fix-up round 2: the lock reaches the Needs Review approve/reject
 * buttons (Emails tab section, Texts tab section, the review screen) and the
 * Removed contacts restore button, wired from the deal screen. Component-level
 * behaviour is in transactionDetailsModule/components/__tests__/lockedDealReadOnly-3910.test.tsx.
 */
describe("C-d (UI): Needs Review and Removed restore follow the lock, per submission status", () => {
  // Shape transcribed from reviewQueueSameSet-2791.test.tsx's item() (the ReviewItemDto producer output).
  const display = {
    title: "Subject", subtitle: "paul@example.com", snippet: "hello",
    occurredAt: "2026-06-01T00:00:00.000Z", itemCount: 1, threadId: "thr-1",
    recipients: "me@example.com", cc: null, sender: "paul@example.com",
    body: null, bodyText: null, hasAttachments: false, threadParticipants: ["+15550142"],
    threadMessages: [{
      id: "m-1", thread_id: "th-1", body_text: "hello", sent_at: "2026-06-01T00:00:00.000Z",
      direction: "inbound", participants: null, thread_display_name: null,
      participants_flat: "+15550142", channel: "sms",
    }],
  };
  const reviewItems = [
    { id: "pending:p1", origin: "pending", kind: "email", rowId: "p1", transaction_id: "txn-123",
      email_id: "e1", thread_id: null, found_at: "2026-08-01T00:00:00.000Z", display },
    { id: "pending:t1", origin: "pending", kind: "text", rowId: "t1", transaction_id: "txn-123",
      email_id: null, thread_id: "th-1", found_at: "2026-08-01T00:00:00.000Z",
      display: { ...display, threadId: "th-1" } },
  ];
  const removedContact = {
    id: "tc-1", transaction_id: "txn-123", contact_id: "c-9", role: "listing_agent",
    role_category: "agent", specific_role: "listing_agent", is_primary: 1, notes: null,
    created_at: "2026-08-05 03:08:06", updated_at: "2026-08-05 03:08:06",
    removed_at: "2026-08-05 03:08:06", removed_reason: "Removed from transaction by user",
    contact_removed_at: null, contact_name: "removed-party-fixture", contact_email: "j@example.com",
    contact_phone: "+15550100", contact_company: "Example Realty", contact_title: "Broker",
    contact_source: "manual",
  };

  const linkedEmail = {
    id: "c-e1", user_id: "user-456", transaction_id: "txn-123", communication_type: "email",
    email_id: "le1", thread_id: "lthr-1", subject: "Linked subject", sender: "paul@example.com",
    recipients: "me@example.com", sent_at: "2026-06-02T00:00:00.000Z", body_plain: "hi",
    has_attachments: false,
  };
  const linkedText = {
    id: "c-t1", user_id: "user-456", transaction_id: "txn-123", communication_type: "text",
    message_id: "lm1", thread_id: "lth-1", body_text: "yo", sent_at: "2026-06-02T00:00:00.000Z",
    direction: "inbound", participants_flat: "+15550142", channel: "sms",
  };

  it.each(CASES)("%s -> %s", async (status, reason) => {
    const t = txn(status);
    (window.api.transactions as unknown as { getOverview: jest.Mock }).getOverview = jest
      .fn()
      .mockResolvedValue({ success: true, transaction: { contact_assignments: contactAssignments } });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: {
        ...t,
        // One linked email and one linked text so both tabs render their lists (and the review section above them).
        communications: [linkedEmail, linkedText],
        contact_assignments: contactAssignments,
      },
    } as never);
    jest.mocked(window.api.transactions.getReviewState).mockResolvedValue({
      items: reviewItems,
      count: reviewItems.length,
    } as never);
    (window.api.transactions as unknown as { getCommunications: jest.Mock }).getCommunications = jest
      .fn()
      .mockResolvedValue({
        success: true,
        transaction: { communications: [linkedEmail, linkedText], contact_assignments: contactAssignments },
      });
    (window.api.transactions as unknown as { isAutoSyncInFlight: jest.Mock }).isAutoSyncInFlight = jest
      .fn()
      .mockResolvedValue({ inFlight: false });
    (window.api.transactions as unknown as { syncReviewQueue: jest.Mock }).syncReviewQueue = jest
      .fn()
      .mockResolvedValue({ success: true, added: 0, linked: 0, found: 0 });
    (window.api.transactions as unknown as { getRemovedContacts: jest.Mock }).getRemovedContacts = jest
      .fn()
      .mockResolvedValue({ success: true, removedContacts: [removedContact] });

    render(<TransactionDetails transaction={t} onClose={jest.fn()} userId="user-456" />);

    const expectLock = (b: HTMLElement) => {
      if (reason) {
        expect(b).toBeDisabled();
        expect(b).toHaveAttribute("title", DEAL_LOCK_EDIT_TOOLTIP[reason]);
      } else {
        expect(b).toBeEnabled();
      }
    };

    // Details tab: Removed contacts restore.
    (await screen.findByTestId("show-removed-transaction-contacts-toggle")).click();
    expectLock(await screen.findByTestId("restore-transaction-contact-button"));

    // Emails tab section.
    (await screen.findByText("Emails")).click();
    const emailSection = within(await screen.findByTestId("needs-review-section"));
    // Only the Needs Review section's cards: the linked list below it has
    // its own remove buttons, which this item does not change.
    (await emailSection.findAllByTestId("confirm-thread-button")).forEach(expectLock);
    (await emailSection.findAllByTestId("unlink-thread-button")).forEach(expectLock);

    // Texts tab section: its cards are the "review-item" wrappers (text kind), so an
    // Emails section left mounted behind the tab cannot satisfy this.
    (await screen.findByText("Texts")).click();
    const textCards = await screen.findAllByTestId("review-item");
    expect(textCards.length).toBeGreaterThan(0);
    for (const card of textCards) {
      expectLock(within(card).getByTestId("confirm-thread-button"));
      expectLock(within(card).getByTestId("unlink-thread-button"));
    }

    // The combined review screen overlay.
    (await screen.findAllByTestId("needs-review-button"))[0].click();
    const screenEl = await screen.findByTestId("needs-review-screen");
    const approveAll = Array.from(screenEl.querySelectorAll("button")).find((b) => b.textContent === "Approve all") as HTMLElement;
    expect(approveAll).toBeDefined();
    expectLock(approveAll);
    const rejectAll = Array.from(screenEl.querySelectorAll("button")).find((b) => b.textContent === "Reject all") as HTMLElement;
    expectLock(rejectAll);
  });
});

/**
 * BACKLOG-3910 (slice d, founder 2026-10-12): the lock reaches the Checklist
 * tab from the deal screen. Component behaviour is in
 * checklist/__tests__/TransactionChecklistTab.dealLock-3910d.test.tsx; this
 * proves TransactionDetails passes the lock in, for every status.
 */
describe("C-g (UI): the Checklist tab follows the lock, per submission status", () => {
  it.each(CASES)("%s -> %s", async (status, reason) => {
    const t = txn(status);
    (window.api.transactions as unknown as { getOverview: jest.Mock }).getOverview = jest
      .fn()
      .mockResolvedValue({ success: true, transaction: { contact_assignments: contactAssignments } });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...t, communications: [], contact_assignments: contactAssignments },
    } as never);
    (window.api.featureGate.strictState as jest.Mock).mockResolvedValue("allowed");
    (window.api.checklists as unknown as { get: jest.Mock }).get.mockResolvedValue({
      success: true,
      checklists: envelopeOf([fixtureDetail()]),
    });

    render(<TransactionDetails transaction={t} onClose={jest.fn()} userId="user-456" initialTab="checklist" />);

    const add = await screen.findByTestId("checklist-add");
    const tick = (await screen.findAllByRole("checkbox"))[0];
    if (reason) {
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute("title", DEAL_LOCK_EDIT_TOOLTIP[reason]);
      expect(tick).toBeDisabled();
      expect(screen.getByTestId("checklist-locked-notice")).toBeInTheDocument();
    } else {
      expect(add).toBeEnabled();
      expect(tick).toBeEnabled();
      expect(screen.queryByTestId("checklist-locked-notice")).toBeNull();
    }
  });
});
