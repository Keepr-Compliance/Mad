/**
 * Live (founder, installed 0.3.84): in "Attach messages", Google Messages
 * group chats showed as raw numbers / "Group Chat", while the attached
 * thread card showed the group's name. The picker now uses the card's own
 * sources: message_thread_names (thread_display_name on the thread rows,
 * threadNames on the roster) and the shared resolveHandles (incl. the names
 * Google Messages showed, Source 4) for a number-only member.
 *
 * Mutations (each red): the group line not shown on the roster row; the
 * thread title not using getThreadDisplayName; the resolver's name not used.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttachMessagesModal } from "../AttachMessagesModal";

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockResolveHandles = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: jest.fn(),
      },
      contacts: { getAll: jest.fn().mockResolvedValue({ success: true, contacts: [] }), resolveHandles: mockResolveHandles },
    },
    writable: true,
  });
});

const GROUP = "Closing Team";
const NUM = "+15555550121";
const OTHER = "+15555550122";
/** The name Google Messages showed for NUM (rcs_chat_people → resolveHandles Source 4). */
const SHOWN = "Jordan Example";

const props = { userId: "user-live", transactionId: "txn-live", propertyAddress: "1 Test St", onClose: jest.fn(), onAttached: jest.fn() };

function groupMessage(id: string) {
  return {
    id,
    thread_id: "gmweb2-abc",
    thread_display_name: GROUP,
    direction: "inbound",
    body_text: "hello",
    sent_at: "2026-09-20T10:00:00.000Z",
    participants: JSON.stringify({ from: NUM, to: ["me", OTHER], chat_members: [NUM, OTHER] }),
    channel: "sms",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessageContacts.mockResolvedValue({
    success: true,
    contacts: [{ contact: NUM, messageCount: 2, lastMessageAt: "2026-09-20T10:00:00.000Z", threadNames: [GROUP] }],
  });
  mockResolveHandles.mockResolvedValue({ success: true, names: { [NUM]: SHOWN } });
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [groupMessage("m1"), groupMessage("m2")] });
});

describe("Attach messages: Google Messages group names (live)", () => {
  it("the roster row: the member's resolved name and the group's name", async () => {
    render(<AttachMessagesModal {...props} />);
    expect(await screen.findByText(SHOWN)).toBeInTheDocument();
    expect(screen.getByTestId("picker-contact-groups")).toHaveTextContent(GROUP);
    // Search by the group name finds it.
    fireEvent.change(screen.getByPlaceholderText(/Search by name, phone number, or group chat name/i), { target: { value: "closing" } });
    expect(screen.getByText(SHOWN)).toBeInTheDocument();
  });

  it("the thread rows: the group's name, as its card shows it", async () => {
    render(<AttachMessagesModal {...props} />);
    fireEvent.click(await screen.findByText(SHOWN));
    await waitFor(() => expect(mockGetMessagesByContact).toHaveBeenCalled());
    expect(await screen.findByText(GROUP)).toBeInTheDocument();
    expect(screen.queryByText("Group Chat")).toBeNull();
  });
});
