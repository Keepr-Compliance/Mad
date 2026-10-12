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
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../../electron/types/models";
import {
  DEAL_LOCK_EDIT_TOOLTIP,
  DEAL_LOCK_NOTICE_COPY,
  DEAL_LOCK_SYNC_TOOLTIP,
} from "../../utils/dealLock";

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
