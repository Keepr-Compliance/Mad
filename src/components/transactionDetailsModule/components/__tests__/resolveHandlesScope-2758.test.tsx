/**
 * BACKLOG-2758 — THE RENDERER CALL SITES SEND (OR WITHHOLD) THE TRANSACTION ID.
 *
 * ===========================================================================
 * WHAT THIS FILE OWNS
 * ===========================================================================
 * Three surfaces call `window.api.contacts.resolveHandles`, and after this fix
 * they do NOT all call it the same way. This file pins the arguments each one
 * sends. What those arguments MEAN is pinned over a real database in
 * `electron/services/__tests__/inAppHandleScope-2758.test.ts`; that the handler
 * builds a scope from them is pinned in
 * `electron/handlers/__tests__/resolveHandlesScope-2758.test.ts`.
 *
 * None of the three is sufficient alone. The defect the founder hit lived in the
 * gap between them: the resolver had honoured a transaction scope for months and
 * the export passed one, but the in-app path had no parameter to put an id in,
 * so every in-app card resolved unscoped. A test of the resolver alone stays
 * green through that; so does a test of the components alone.
 *
 * ===========================================================================
 * THE PICKER IS DELIBERATELY DIFFERENT
 * ===========================================================================
 * `AttachMessagesModal` withholds the transaction id (founder-ratified
 * 2026-08-27) because it lists threads that are NOT on the deal yet — naming a
 * shared line after this deal's party there would be a guess printed as fact.
 * The assertion for it uses `toHaveBeenCalledWith(handles, userId)`, which is
 * EXACT-ARITY: adding a third argument reds it. That is the control that keeps
 * the asymmetry deliberate rather than incidental.
 *
 * ===========================================================================
 * CONTROLS — MEASURED with `--bail=0` (jest.config.js sets `bail: 1`, so any
 * count taken without the flag is a FLOOR). Counts in the PR body.
 * ===========================================================================
 *   R1  Drop `{ transactionId }` from the TransactionMessagesTab call.
 *   R2  Drop `userId` / `{ transactionId }` from the RemovedMessagesSection call.
 *   R3  ADD `{ transactionId }` to the AttachMessagesModal call (the
 *       "consistency fix" this file exists to forbid).
 *
 * RUNNER: npx jest --bail=0 src/components/transactionDetailsModule/components/__tests__/resolveHandlesScope-2758.test.tsx
 *
 * Every name and number here is invented; handles are reserved-for-fiction 555.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import { RemovedMessagesSection } from "../RemovedMessagesSection";
import { AttachMessagesModal } from "../modals/AttachMessagesModal";
import type { Communication } from "../../types";

Element.prototype.scrollIntoView = jest.fn();

const mockResolveHandles = jest.fn();
const mockGetRemovedMessages = jest.fn();
const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockGetAllContacts = jest.fn();

const USER_ID = "user-2758";
const TX_ID = "txn-2758";
const HANDLE = "+15035550152";

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      contacts: { resolveHandles: mockResolveHandles, getAll: mockGetAllContacts },
      transactions: {
        getRemovedMessages: mockGetRemovedMessages,
        restoreRemovedMessage: jest.fn(),
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: jest.fn(),
      },
    },
    writable: true,
  });
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveHandles.mockResolvedValue({ success: true, names: {} });
  mockGetAllContacts.mockResolvedValue({ success: true, contacts: [] });
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
});

function makeMessage(id: string): Communication {
  return {
    id,
    user_id: USER_ID,
    sender: HANDLE,
    thread_id: "t-2758",
    channel: "sms",
    communication_type: "text",
    sent_at: "2026-01-10T10:00:00Z",
    created_at: "2026-01-10T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    participants: JSON.stringify({ from: HANDLE, to: ["me"], chat_members: [HANDLE] }),
  } as unknown as Communication;
}

/** The scope object (3rd argument) of the first resolveHandles call. */
function scopeArg(): unknown {
  return mockResolveHandles.mock.calls[0]?.[2];
}

describe("BACKLOG-2758 — Texts tab sends the transaction id", () => {
  it("passes { transactionId } alongside the user id", async () => {
    render(
      <TransactionMessagesTab
        messages={[makeMessage("m-1")]}
        loading={false}
        error={null}
        userId={USER_ID}
        transactionId={TX_ID}
      />,
    );
    await waitFor(() => expect(mockResolveHandles).toHaveBeenCalled());
    // Asserted as the id's VALUE, not merely "a third argument exists" — a call
    // site that passed `{}` would satisfy the weaker check and resolve unscoped.
    expect(scopeArg()).toEqual({ transactionId: TX_ID });
    expect(mockResolveHandles.mock.calls[0][1]).toBe(USER_ID);
  });
});

describe("BACKLOG-2758 — removed-threads section sends the user AND transaction id", () => {
  it("passes both, where before it passed neither", async () => {
    mockGetRemovedMessages.mockResolvedValue({
      success: true,
      removedMessages: [
        {
          ignored_id: "ig-1",
          ic_thread_id: null,
          reason: "Manually unlinked by user",
          ignored_at: "2026-02-01T10:00:00Z",
          message_id: "m-1",
          body: "Message body content",
          subject: null,
          channel: "sms",
          thread_id: "t-2758",
          sent_at: "2026-01-15T10:00:00Z",
          received_at: null,
          participants: JSON.stringify({ from: HANDLE, to: ["me"], chat_members: [HANDLE] }),
          participants_flat: null,
          direction: "inbound",
        },
      ],
    });

    render(
      <RemovedMessagesSection
        transactionId={TX_ID}
        userId={USER_ID}
        isOpen={true}
        onOpenChange={jest.fn()}
        onContactNamesResolved={jest.fn()}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockResolveHandles).toHaveBeenCalled());
    // The userId leg matters on its own: this section passed NO user id at all,
    // so the hard filter that keeps another user's contacts from naming these
    // threads was absent here entirely.
    expect(mockResolveHandles.mock.calls[0][1]).toBe(USER_ID);
    expect(scopeArg()).toEqual({ transactionId: TX_ID });
  });
});

describe("BACKLOG-2758 — the attach picker withholds the transaction id", () => {
  it("passes the user id and NOTHING ELSE", async () => {
    mockGetMessageContacts.mockResolvedValue({
      success: true,
      contacts: [
        {
          contact: HANDLE,
          contactName: "Chris Alvarez",
          messageCount: 3,
          lastMessageAt: "2026-01-18T10:00:00Z",
          threadNames: [],
        },
      ],
    });

    render(
      <AttachMessagesModal
        userId={USER_ID}
        transactionId={TX_ID}
        propertyAddress="1 Test St"
        onClose={jest.fn()}
        onAttached={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockResolveHandles).toHaveBeenCalled());
    // EXACT-ARITY. `toHaveBeenCalledWith` fails on a surplus third argument, so
    // this reds the moment someone "fixes" the picker to match the other two.
    // The modal HAS `transactionId` in props — withholding it is a decision, not
    // an oversight, and this is where that decision is enforced.
    expect(mockResolveHandles).toHaveBeenCalledWith([HANDLE], USER_ID);
    expect(scopeArg()).toBeUndefined();
  });
});
