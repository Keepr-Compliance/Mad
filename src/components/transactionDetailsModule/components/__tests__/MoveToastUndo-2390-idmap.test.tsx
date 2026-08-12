/**
 * BACKLOG-2390 (fix) — email move-toast Undo id-mapping regression tests.
 *
 * Founder QA: bulk-remove emails → click Undo → the emails STAYED in "Show
 * removed" (nothing restored) while the toast still said "Move undone".
 *
 * ROOT CAUSE: the Undo passed unlinkCommunication's `unlinkedIds` — which are
 * **communications.id** (junction PK, c.id) — as the restore payload, but
 * getRemovedEmails() returns suppression rows keyed by **emails.id** (e.id).
 * The filter `idSet.has(r.email_id)` compared c.id against e.id, matched zero
 * rows, and called restoreRemovedEmail zero times.
 *
 * The original MoveToastUndo-2390 suite MISSED this because its mock comms had
 * NO `communication_id`, so `email.id` doubled as both the id passed to unlink
 * AND the id unlink echoed back — collapsing c.id and e.id to one value. These
 * tests use the REAL shape: `communication_id` (c.id) DISTINCT from `id` (e.id).
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import { NotificationProvider } from "../../../../contexts/NotificationContext";

/**
 * BACKLOG-2447: these components now raise toasts through `useNotification`,
 * which requires the app-level NotificationProvider that `App.tsx` supplies in
 * production. Passing it as RTL's `wrapper` (rather than wrapping each element)
 * means `rerender` keeps the provider too.
 */
const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import {
  restoreRemovedEmailsByContentIds,
  type EmailRestoreApi,
} from "../../utils/undoMoveRestore";
import type { Communication } from "../../types";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const first = (testId: string) => screen.getAllByTestId(testId)[0];

// ---------------------------------------------------------------------------
// Unit: the shared restore helper — the single source of truth for the mapping.
// ---------------------------------------------------------------------------
describe("restoreRemovedEmailsByContentIds — id-space mapping", () => {
  function makeApi(overrides: Partial<Record<string, jest.Mock>> = {}) {
    const getRemovedEmails = jest.fn().mockResolvedValue({
      success: true,
      // Suppression rows keyed by emails.id (e.id) — NOT communications.id.
      // e-1 and e-2 are DISTINCT emails in the SAME thread → DISTINCT ignored rows.
      removedEmails: [
        { ignored_id: "ie-1", email_id: "e-1", thread_id: "t-a" },
        { ignored_id: "ie-2", email_id: "e-2", thread_id: "t-a" },
        { ignored_id: "ie-9", email_id: "e-9", thread_id: "t-z" },
      ],
    });
    const restoreRemovedEmail = jest.fn().mockResolvedValue({ success: true });
    return {
      getRemovedEmails,
      restoreRemovedEmail,
      ...overrides,
    } as unknown as EmailRestoreApi & Record<string, jest.Mock>;
  }

  it("restores each THREAD exactly once even with multiple ignored rows (BACKLOG-2390 regression)", async () => {
    const api = makeApi();
    const outcome = await restoreRemovedEmailsByContentIds(api, "txn-1", ["e-1", "e-2"]);

    // e-1 and e-2 are two emails of one thread (t-a) carrying two ignored rows.
    // restoreRemovedEmail is thread-aware — it restores the whole conversation
    // from ONE member — so calling it per ignored row re-inserts links the first
    // call already created (the UNIQUE collision). Assert exactly ONE call, from
    // a matching thread member.
    expect(api.restoreRemovedEmail).toHaveBeenCalledTimes(1);
    // BACKLOG-2414: `jest.mocked` exposes `.mock` — the intersection type resolves
    // `restoreRemovedEmail` to the plain API signature, which has no `.mock`.
    const [ignoredArg, emailArg, txArg] =
      jest.mocked(api.restoreRemovedEmail).mock.calls[0];
    expect(["ie-1", "ie-2"]).toContain(ignoredArg);
    expect(["e-1", "e-2"]).toContain(emailArg);
    expect(txArg).toBe("txn-1");
    expect(outcome).toEqual({ status: "success", restoredCount: 1 });
  });

  it("REPRODUCES THE BUG: communications ids (c.id) match nothing → none restored", async () => {
    const api = makeApi();
    // This is exactly what the OLD undo passed: unlinkCommunication's unlinkedIds,
    // i.e. communications.id values — a different id-space from emails.id.
    const outcome = await restoreRemovedEmailsByContentIds(api, "txn-1", ["comm-1", "comm-2"]);

    expect(api.restoreRemovedEmail).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "none_matched" });
  });

  it("fails loud when a restore returns success:false", async () => {
    const api = makeApi({
      restoreRemovedEmail: jest.fn().mockResolvedValue({ success: false, error: "nope" }),
    });
    const outcome = await restoreRemovedEmailsByContentIds(api, "txn-1", ["e-1"]);
    expect(outcome.status).toBe("restore_failed");
  });

  it("fails loud when getRemovedEmails fails", async () => {
    const api = makeApi({
      getRemovedEmails: jest.fn().mockResolvedValue({ success: false, error: "boom" }),
    });
    const outcome = await restoreRemovedEmailsByContentIds(api, "txn-1", ["e-1"]);
    expect(outcome).toEqual({ status: "fetch_failed", error: "boom" });
  });
});

// ---------------------------------------------------------------------------
// Component: full bulk-remove → Undo flow with DISTINCT c.id vs e.id.
// This is the founder-repro: on the OLD code the undo payload was allUnlinkedIds
// (= communications ids), so restoreRemovedEmail was NEVER called. This test
// FAILS on the old code and passes on the fix.
// ---------------------------------------------------------------------------
describe("BACKLOG-2390 — emails bulk remove-undo with realistic id shapes", () => {
  beforeAll(() => {
    Object.defineProperty(window, "api", {
      value: {
        transactions: {
          unlinkCommunication: jest.fn(),
          getRemovedEmails: jest.fn(),
          restoreRemovedEmail: jest.fn(),
        },
      },
      writable: true,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    // Realistic backend: unlinkCommunication is called with the JUNCTION id
    // (communication_id = c.id) and echoes back communications ids.
    t.unlinkCommunication.mockImplementation(async (cid: string) => ({
      success: true,
      unlinkedIds: [cid],
    }));
    // Suppression rows keyed by emails.id (e.id) — the id-space the fix must use.
    t.getRemovedEmails.mockResolvedValue({
      success: true,
      removedEmails: [
        { ignored_id: "ie-1", email_id: "e-1" },
        { ignored_id: "ie-2", email_id: "e-2" },
      ],
    });
    t.restoreRemovedEmail.mockResolvedValue({ success: true });
  });

  it("Undo restores via emails.id even though unlink returns communications.id", async () => {
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;

    const base = {
      user_id: "user-1",
      created_at: "2024-01-01T00:00:00Z",
      has_attachments: false,
      is_false_positive: false,
    };
    // CONTENT id (id = emails.id) is DISTINCT from the junction id (communication_id = c.id).
    const comms = [
      { ...base, id: "e-1", communication_id: "comm-1", subject: "Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-10T10:00:00Z" },
      { ...base, id: "e-2", communication_id: "comm-2", subject: "Inspection", sender: "bob@example.com", recipients: "me@example.com", sent_at: "2024-01-12T10:00:00Z" },
    ] as unknown as Communication[];

    const onShowSuccess = jest.fn();
    const onShowError = jest.fn();

    render(
      <TransactionEmailsTab
        communications={comms}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        onRemoveEmailsByIds={jest.fn((ids: string[]) => ids.length)}
        onShowSuccess={onShowSuccess}
        onShowError={onShowError}
      />
    );

    await userEvent.click(screen.getByTestId("select-emails-button"));
    for (const cb of screen.getAllByTestId("email-thread-select")) {
      await userEvent.click(cb);
    }
    await userEvent.click(first("emails-bulk-remove"));
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    // unlinkCommunication was called with the JUNCTION ids (c.id), proving the
    // two id-spaces really are distinct in this test.
    await waitFor(() =>
      expect(onShowSuccess).toHaveBeenCalledWith(
        "2 emails removed",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
      )
    );
    expect(t.unlinkCommunication).toHaveBeenCalledWith("comm-1");
    expect(t.unlinkCommunication).toHaveBeenCalledWith("comm-2");

    // Invoke Undo, as clicking the toast button would.
    const call = onShowSuccess.mock.calls.find((c) => c[0] === "2 emails removed");
    const undo = (call?.[1] as { action?: { onClick: () => void } } | undefined)?.action;
    await act(async () => {
      undo?.onClick();
    });

    // The FIX: restoreRemovedEmail is invoked with the matching ignored_id +
    // emails.id. On the OLD code the undo payload was ["comm-1","comm-2"] which
    // matched no suppression row, so these calls never happened.
    await waitFor(() => {
      expect(t.restoreRemovedEmail).toHaveBeenCalledWith("ie-1", "e-1", "txn-1");
      expect(t.restoreRemovedEmail).toHaveBeenCalledWith("ie-2", "e-2", "txn-1");
    });
    expect(onShowSuccess).toHaveBeenCalledWith("Move undone");
    expect(onShowError).not.toHaveBeenCalled();
  });

  it("fails loud: when nothing matches, shows an error instead of 'Move undone'", async () => {
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    // Suppression rows that DON'T correspond to the removed emails (simulates the
    // broken mapping): undo must NOT claim success.
    t.getRemovedEmails.mockResolvedValue({
      success: true,
      removedEmails: [{ ignored_id: "ie-x", email_id: "e-999" }],
    });

    const base = { user_id: "user-1", created_at: "2024-01-01T00:00:00Z", has_attachments: false, is_false_positive: false };
    const comms = [
      { ...base, id: "e-1", communication_id: "comm-1", subject: "Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-10T10:00:00Z" },
    ] as unknown as Communication[];

    const onShowSuccess = jest.fn();
    const onShowError = jest.fn();

    render(
      <TransactionEmailsTab
        communications={comms}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        onRemoveEmailsByIds={jest.fn((ids: string[]) => ids.length)}
        onShowSuccess={onShowSuccess}
        onShowError={onShowError}
      />
    );

    await userEvent.click(screen.getByTestId("select-emails-button"));
    for (const cb of screen.getAllByTestId("email-thread-select")) {
      await userEvent.click(cb);
    }
    await userEvent.click(first("emails-bulk-remove"));
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    const call = onShowSuccess.mock.calls.find((c) => c[0] === "Email removed from transaction" || c[0] === "1 emails removed" || c[0]?.toString().includes("removed"));
    const undo = (call?.[1] as { action?: { onClick: () => void } } | undefined)?.action;
    await act(async () => {
      undo?.onClick();
    });

    await waitFor(() =>
      expect(onShowError).toHaveBeenCalledWith("Couldn't undo — emails are still removed")
    );
    expect(onShowSuccess).not.toHaveBeenCalledWith("Move undone");
  });
});
