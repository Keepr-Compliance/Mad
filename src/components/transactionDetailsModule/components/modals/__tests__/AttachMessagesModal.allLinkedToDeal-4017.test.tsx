/**
 * BACKLOG-4017: when every text of the chosen contact is in a chat already linked to
 * THIS deal, the picker's right-hand pane says so instead of "No chats found". A
 * contact with no texts at all keeps today's empty state.
 *
 * The response shape is the handler's (emailLinkingHandlers.ts,
 * "transactions:get-messages-by-contact"): { success, messages, linkedToDealThreadCount },
 * where linkedToDealThreadCount counts the contact's chats linked to this deal
 * (readPickerForContact, same scan as the picker read).
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttachMessagesModal, ALL_LINKED_TO_DEAL_MESSAGE } from "../AttachMessagesModal";

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: jest.fn().mockResolvedValue({ success: true }),
      },
      contacts: {
        getAll: jest.fn().mockResolvedValue({ success: true, contacts: [] }),
        resolveHandles: jest.fn().mockResolvedValue({ success: true, names: {} }),
      },
    },
    writable: true,
  });
});

const props = {
  userId: "user-123",
  transactionId: "txn-456",
  propertyAddress: "123 Main St",
  onClose: jest.fn(),
  onAttached: jest.fn(),
};

const NO_TEXTS = "No chats found with this contact";

async function openContact(): Promise<void> {
  render(<AttachMessagesModal {...props} />);
  await waitFor(() => expect(screen.getByText("John Doe")).toBeInTheDocument());
  fireEvent.click(screen.getByText("John Doe"));
  await waitFor(() =>
    expect(mockGetMessagesByContact).toHaveBeenCalledWith("user-123", "+14155550100", "txn-456"),
  );
}

describe("BACKLOG-4017 picker empty states", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessageContacts.mockResolvedValue({
      success: true,
      contacts: [
        { contact: "+14155550100", contactName: "John Doe", messageCount: 2, lastMessageAt: "2024-01-18T10:00:00Z" },
      ],
    });
  });

  it("all texts already in a chat linked to this deal -> says they are already attached", async () => {
    mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [], linkedToDealThreadCount: 1 });
    await openContact();
    expect(await screen.findByText(ALL_LINKED_TO_DEAL_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(NO_TEXTS)).not.toBeInTheDocument();
  });

  it("a contact with no texts at all -> keeps today's empty state", async () => {
    mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [], linkedToDealThreadCount: 0 });
    await openContact();
    expect(await screen.findByText(NO_TEXTS)).toBeInTheDocument();
    expect(screen.queryByText(ALL_LINKED_TO_DEAL_MESSAGE)).not.toBeInTheDocument();
  });

  it("texts attached to this deal one by one (nothing offered) -> says they are already attached", async () => {
    mockGetMessagesByContact.mockResolvedValue({
      success: true,
      messages: [],
      linkedToDealThreadCount: 0,
      hasTextsAttachedToDeal: true,
    });
    await openContact();
    expect(await screen.findByText(ALL_LINKED_TO_DEAL_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(NO_TEXTS)).not.toBeInTheDocument();
  });

  it("some texts attached, some not -> the list is shown, not an empty state", async () => {
    mockGetMessagesByContact.mockResolvedValue({
      success: true,
      messages: [
        {
          id: "m-1",
          user_id: "user-123",
          channel: "sms",
          direction: "inbound",
          body_text: "still unattached text",
          thread_id: "t-1",
          sent_at: "2024-01-18T10:00:00Z",
          participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
        },
      ],
      linkedToDealThreadCount: 0,
      hasTextsAttachedToDeal: false,
    });
    await openContact();
    expect(await screen.findByTestId("message-thread-card")).toHaveAttribute("data-thread-id", "t-1");
    expect(screen.queryByText(ALL_LINKED_TO_DEAL_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_TEXTS)).not.toBeInTheDocument();
  });

  it("the exact wording the founder approved", () => {
    expect(ALL_LINKED_TO_DEAL_MESSAGE).toBe("All of this contact's texts are already attached to this deal.");
  });
});
