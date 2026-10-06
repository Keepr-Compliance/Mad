/**
 * Live (founder): in "Attach messages", a group chat's members showed as raw
 * numbers and View showed bare text, while the ATTACHED card showed the
 * members' names and View showed each sender + time.
 *
 * Founder decision: the picker uses the SAME components as the attached view —
 * MessageThreadCard (selection mode) and, through its View, ConversationViewModal
 * — fed the same shared resolveHandles names (no transactionId, BACKLOG-2758).
 *
 * Mutations (each red):
 *   - picker renders its own row / viewer again        → "same component" tests
 *   - picker stops resolving the loaded chats' handles → member + sender names
 *   - picker passes no contactNames to the card         → member + sender names
 *   - card's selection checkbox not a focusable checkbox → keyboard test
 */
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatMessageTime } from "../../../../../utils/messageFormatUtils";
import type { Communication } from "../../../types";

import * as cardModule from "../../MessageThreadCard";
import * as modalModule from "../ConversationViewModal";
import { AttachMessagesModal } from "../AttachMessagesModal";
import { TransactionMessagesTab } from "../../TransactionMessagesTab";

// Spies that still render the real components: "same component" is asserted
// by identity, not by markup that a copy could imitate.
const cardSpy = jest.spyOn(cardModule, "MessageThreadCard");
const modalSpy = jest.spyOn(modalModule, "ConversationViewModal");

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockResolveHandles = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        getRemovedMessages: jest.fn().mockResolvedValue({ success: true, messages: [] }),
        linkMessages: jest.fn(),
      },
      contacts: {
        getAll: jest.fn().mockResolvedValue({ success: true, contacts: [] }),
        resolveHandles: mockResolveHandles,
      },
    },
    writable: true,
  });
  Element.prototype.scrollIntoView = jest.fn();
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

const GROUP = "Closing Team";
/** On the roster (has unlinked messages under its own handle). */
const NUM = "+15555550121";
/** A group member NOT on the roster — only the chat itself names them. */
const MEMBER = "+15555550133";
const NAMES: Record<string, string> = { [NUM]: "Jordan Example", [MEMBER]: "Casey Member" };

const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-20T11:30:00.000Z";

function groupMessage(id: string, from: string, sentAt: string, body: string) {
  return {
    id,
    user_id: "user-x",
    thread_id: "gmweb2-abc",
    thread_display_name: GROUP,
    direction: "inbound",
    body_text: body,
    sent_at: sentAt,
    participants: JSON.stringify({ from, to: ["me"], chat_members: [NUM, MEMBER] }),
    channel: "sms",
  };
}

const MESSAGES = [
  groupMessage("m1", NUM, T1, "first"),
  groupMessage("m2", MEMBER, T2, "second"),
];

const pickerProps = {
  userId: "user-x",
  transactionId: "txn-x",
  propertyAddress: "1 Test St",
  onClose: jest.fn(),
  onAttached: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessageContacts.mockResolvedValue({
    success: true,
    contacts: [{ contact: NUM, messageCount: 2, lastMessageAt: T2, threadNames: [GROUP] }],
  });
  // The shared resolver answers only for the handles it is asked about.
  mockResolveHandles.mockImplementation(async (handles: string[]) => ({
    success: true,
    names: Object.fromEntries(handles.filter((h) => NAMES[h]).map((h) => [h, NAMES[h]])),
  }));
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: MESSAGES });
});

async function openPickerThreads(): Promise<HTMLElement> {
  render(<AttachMessagesModal {...pickerProps} />);
  fireEvent.click(await screen.findByText("Jordan Example"));
  return screen.findByTestId("message-thread-card");
}

describe("Attach messages renders chats through the attached view's components", () => {
  it("picker and Texts tab both render through MessageThreadCard", async () => {
    await openPickerThreads();
    expect(cardSpy.mock.calls.some(([p]) => p.selectionMode === true && p.messages.length === 2)).toBe(true);
    cardSpy.mockClear();

    render(
      <TransactionMessagesTab
        messages={MESSAGES as unknown as Communication[]}
        loading={false}
        error={null}
        userId="user-x"
        transactionId="txn-x"
      />
    );
    await waitFor(() => expect(cardSpy).toHaveBeenCalled());
  });

  it("picker View opens ConversationViewModal (the attached view's viewer)", async () => {
    const card = await openPickerThreads();
    expect(modalSpy).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByTestId("toggle-thread-button"));
    await waitFor(() => expect(modalSpy).toHaveBeenCalled());
  });

  it("a group card names every member, incl. one not on the roster", async () => {
    const card = await openPickerThreads();
    await waitFor(() => expect(card).toHaveTextContent("Casey Member"));
    expect(card).toHaveTextContent("Jordan Example");
    expect(card).toHaveTextContent(GROUP);
    expect(card).not.toHaveTextContent(MEMBER);
    // Same resolver, still without the transaction id (BACKLOG-2758).
    expect(mockResolveHandles).toHaveBeenCalledWith(expect.arrayContaining([MEMBER]), "user-x");
  });

  it("View shows each message's resolved sender and time", async () => {
    const card = await openPickerThreads();
    await waitFor(() => expect(card).toHaveTextContent("Casey Member"));
    fireEvent.click(within(card).getByTestId("toggle-thread-button"));

    const senders = await screen.findAllByTestId("group-message-sender");
    expect(senders.map((s) => s.textContent).sort()).toEqual(["Casey Member", "Jordan Example"]);
    expect(screen.getByText(formatMessageTime(new Date(T1)))).toBeInTheDocument();
    expect(screen.getByText(formatMessageTime(new Date(T2)))).toBeInTheDocument();
  });

  // SR: the old picker row toggled from the keyboard; the shared card's
  // selection checkbox must too (one fix, both screens).
  it("the selection checkbox is a focusable checkbox toggled by Space and Enter", async () => {
    const card = await openPickerThreads();
    const box = within(card).getByRole("checkbox", { name: "Select conversation" });
    expect(box).toHaveAttribute("aria-checked", "false");

    box.focus();
    expect(box).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(box).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    expect(box).toHaveAttribute("aria-checked", "false");
  });
});
