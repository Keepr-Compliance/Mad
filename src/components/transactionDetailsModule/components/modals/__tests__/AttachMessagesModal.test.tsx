/**
 * AttachMessagesModal Tests
 * Tests for the contact-first attach messages modal dialog
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttachMessagesModal } from "../AttachMessagesModal";

// Mock the window.api
const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetAllContacts = jest.fn();
const mockResolveHandles = jest.fn();

beforeAll(() => {
  // Set up window.api mock
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: {
        getAll: mockGetAllContacts,
        // BACKLOG-2263: modal resolves message handles to names (phones + emails)
        // so cross-handle rows collapse into one roster entry.
        resolveHandles: mockResolveHandles,
      },
    },
    writable: true,
  });
});

describe("AttachMessagesModal", () => {
  const mockOnClose = jest.fn();
  const mockOnAttached = jest.fn();
  const defaultProps = {
    userId: "user-123",
    transactionId: "txn-456",
    propertyAddress: "123 Main St",
    onClose: mockOnClose,
    onAttached: mockOnAttached,
  };

  const mockContacts = [
    {
      contact: "+14155550100",
      contactName: "John Doe",
      messageCount: 5,
      lastMessageAt: "2024-01-18T10:00:00Z",
    },
    {
      contact: "+14155550200",
      contactName: null,
      messageCount: 3,
      lastMessageAt: "2024-01-17T12:00:00Z",
    },
  ];

  const mockMessages = [
    {
      id: "msg-1",
      user_id: "user-123",
      channel: "sms",
      body_text: "Hello from thread 1",
      sent_at: "2024-01-16T11:00:00Z",
      direction: "inbound",
      thread_id: "thread-1",
      participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    },
    {
      id: "msg-2",
      user_id: "user-123",
      channel: "imessage",
      body_text: "Reply from thread 1",
      sent_at: "2024-01-17T12:00:00Z",
      direction: "outbound",
      thread_id: "thread-1",
      participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessageContacts.mockResolvedValue({
      success: true,
      contacts: [],
    });
    mockGetMessagesByContact.mockResolvedValue({
      success: true,
      messages: [],
    });
    mockLinkMessages.mockResolvedValue({
      success: true,
    });
    mockGetAllContacts.mockResolvedValue({
      success: true,
      contacts: [],
    });
    mockResolveHandles.mockResolvedValue({
      success: true,
      names: {},
    });
  });

  describe("Basic Rendering", () => {
    it("should render modal with test id", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("attach-messages-modal")).toBeInTheDocument();
      });
    });

    it("should render Select Contact title in contacts view", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        // Mobile + desktop both render this heading
        expect(screen.getAllByText("Select Contact")[0]).toBeInTheDocument();
      });
    });

    it("should render property address subtitle when provided", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/Link chats to 123 Main St/)).toBeInTheDocument();
      });
    });

    it("should render close button", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        // Mobile + desktop both render close buttons
        expect(screen.getAllByTestId("close-modal-button")[0]).toBeInTheDocument();
      });
    });

    it("should render cancel button", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("cancel-button")).toBeInTheDocument();
      });
    });

    it("should render search input", async () => {
      render(<AttachMessagesModal {...defaultProps} />);
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText(/Search by name, phone number, or group chat name/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe("Loading State", () => {
    it("should show loading indicator while loading contacts", async () => {
      // Make the API hang
      mockGetMessageContacts.mockImplementation(() => new Promise(() => {}));

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Loading contacts/i)).toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("should show error message when loading contacts fails", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: false,
        error: "Failed to load contacts",
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Failed to load contacts")).toBeInTheDocument();
      });
    });
  });

  describe("Empty State", () => {
    it("should show empty state when no contacts with messages", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: [],
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/No contacts with unlinked messages/i)).toBeInTheDocument();
      });
    });
  });

  describe("Contacts List", () => {
    it("should display contacts list", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        // Should show contact name for first contact, phone for second (no name)
        expect(screen.getByText("John Doe")).toBeInTheDocument();
        expect(screen.getByText("+1 (415) 555-0200")).toBeInTheDocument();
      });
    });

    it("should display message counts for contacts", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("5 msgs")).toBeInTheDocument();
        expect(screen.getByText("3 msgs")).toBeInTheDocument();
      });
    });

    it("should filter contacts by search query", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // Type search query (search by name)
      const searchInput = screen.getByPlaceholderText(/Search by name, phone number, or group chat name/i);
      fireEvent.change(searchInput, { target: { value: "John" } });

      // Should only show matching contact
      expect(screen.getByText("John Doe")).toBeInTheDocument();
      expect(screen.queryByText("+1 (415) 555-0200")).not.toBeInTheDocument();
    });
  });

  describe("Threads View", () => {
    it("should load threads when contact is selected", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      // Wait for contacts to load
      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // Click on a contact
      fireEvent.click(screen.getByText("John Doe"));

      // Should call getMessagesByContact
      await waitFor(() => {
        expect(mockGetMessagesByContact).toHaveBeenCalledWith(
          "user-123",
          "+14155550100"
        );
      });
    });

    it("should show back button in threads view", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // Click on a contact
      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        // Mobile + desktop both render back buttons
        expect(screen.getAllByTestId("back-button")[0]).toBeInTheDocument();
      });
    });

    it("should navigate back to contacts when back button clicked", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // Click on a contact
      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        // Mobile + desktop both render back buttons
        expect(screen.getAllByTestId("back-button")[0]).toBeInTheDocument();
      });

      // Click back (use first instance - mobile)
      fireEvent.click(screen.getAllByTestId("back-button")[0]);

      // Should be back to contacts view (mobile + desktop both show title)
      await waitFor(() => {
        expect(screen.getAllByText("Select Contact")[0]).toBeInTheDocument();
      });
    });
  });

  describe("Thread Selection", () => {
    it("should allow selecting threads", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument();
      });

      // Click to select thread
      fireEvent.click(screen.getByTestId("thread-thread-1"));

      // Should show selection count (footer shows "N selected")
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    });

    it("should show attach button in threads view", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("attach-button")).toBeInTheDocument();
      });
    });
  });

  describe("Attaching Messages", () => {
    it("should call linkMessages when attach is clicked", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument();
      });

      // Select thread
      fireEvent.click(screen.getByTestId("thread-thread-1"));

      // Click attach
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        // Use arrayContaining to avoid flaky tests due to Map/Set iteration order
        expect(mockLinkMessages).toHaveBeenCalledWith(
          expect.arrayContaining(["msg-1", "msg-2"]),
          "txn-456"
        );
        expect(mockLinkMessages.mock.calls[0][0]).toHaveLength(2);
      });
    });

    it("should call onAttached and onClose after successful attach", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });
      mockLinkMessages.mockResolvedValue({ success: true });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("thread-thread-1"));
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        // BACKLOG-2390: onAttached now receives the exact linked message ids so
        // the caller can offer an Undo that reverses precisely those ids.
        expect(mockOnAttached).toHaveBeenCalledWith(expect.any(Array));
        expect(mockOnClose).toHaveBeenCalled();
      });
    });
  });

  describe("Close Modal", () => {
    it("should call onClose when close button clicked", async () => {
      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        // Mobile + desktop both render close buttons
        expect(screen.getAllByTestId("close-modal-button")[0]).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByTestId("close-modal-button")[0]);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onClose when cancel button clicked", async () => {
      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("cancel-button")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("cancel-button"));
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("Error Handling in Attach Flow", () => {
    it("should show error message when linkMessages fails", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });
      mockLinkMessages.mockResolvedValue({
        success: false,
        error: "Failed to link messages",
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("thread-thread-1"));
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(screen.getByText("Failed to link messages")).toBeInTheDocument();
      });

      // Should not call onAttached or onClose on failure
      expect(mockOnAttached).not.toHaveBeenCalled();
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it("should show error message when linkMessages throws exception", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: mockMessages,
      });
      mockLinkMessages.mockRejectedValue(new Error("Network error"));

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("thread-thread-1"));
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2263: cross-handle contact merge — the picker must show ONE entry
  // per contact and ONE conversation per 1:1, then attach every constituent
  // thread's messages (matching the attached list). A real group chat stays
  // its own entry.
  // -------------------------------------------------------------------------
  describe("BACKLOG-2263 contact + thread merge", () => {
    // Romina's messages arrive under three raw handles (the DB groups by handle).
    const rominaContacts = [
      { contact: "+14155550100", contactName: null, messageCount: 2, lastMessageAt: "2024-01-16T10:00:00Z" },
      { contact: "4155550100", contactName: null, messageCount: 1, lastMessageAt: "2024-01-17T10:00:00Z" },
      { contact: "romina@icloud.com", contactName: null, messageCount: 1, lastMessageAt: "2024-01-18T10:00:00Z" },
    ];

    const rominaNames = {
      success: true,
      names: {
        "+14155550100": "Romina",
        "4155550100": "Romina",
        "romina@icloud.com": "Romina",
      },
    };

    // Each handle query returns that handle's own thread(s).
    function messagesForHandle(_userId: string, handle: string) {
      const mk = (id: string, thread: string, from: string) => ({
        id,
        user_id: "user-123",
        channel: from.includes("@") ? "imessage" : "sms",
        body_text: `msg ${id}`,
        sent_at: "2024-01-16T10:00:00Z",
        direction: "inbound",
        thread_id: thread,
        participants: JSON.stringify({ from, to: ["me"] }),
      });
      if (handle === "+14155550100") {
        return Promise.resolve({
          success: true,
          messages: [
            mk("m-1", "t-sms-plus1", "+14155550100"),
            mk("m-2", "t-imsg-plus1", "+14155550100"),
          ],
        });
      }
      if (handle === "4155550100") {
        return Promise.resolve({ success: true, messages: [mk("m-3", "t-sms-bare", "4155550100")] });
      }
      if (handle === "romina@icloud.com") {
        return Promise.resolve({
          success: true,
          messages: [mk("m-4", "t-imsg-email", "romina@icloud.com")],
        });
      }
      return Promise.resolve({ success: true, messages: [] });
    }

    it("shows ONE roster entry for a contact split across +1/bare/email handles", async () => {
      mockGetMessageContacts.mockResolvedValue({ success: true, contacts: rominaContacts });
      mockResolveHandles.mockResolvedValue(rominaNames);

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Romina")).toBeInTheDocument();
      });

      // Merged: exactly one "Romina" roster row (not three), aggregated to 4 msgs.
      expect(screen.getAllByText("Romina")).toHaveLength(1);
      expect(screen.getByText("4 msgs")).toBeInTheDocument();
    });

    it("collapses the contact's four threads into ONE conversation and attaches all messages", async () => {
      mockGetMessageContacts.mockResolvedValue({ success: true, contacts: rominaContacts });
      mockResolveHandles.mockResolvedValue(rominaNames);
      mockGetMessagesByContact.mockImplementation(messagesForHandle);

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Romina")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Romina"));

      // Messages loaded for EACH constituent handle.
      await waitFor(() => {
        expect(mockGetMessagesByContact).toHaveBeenCalledWith("user-123", "+14155550100");
        expect(mockGetMessagesByContact).toHaveBeenCalledWith("user-123", "4155550100");
        expect(mockGetMessagesByContact).toHaveBeenCalledWith("user-123", "romina@icloud.com");
      });

      // The four raw threads collapse into a SINGLE conversation entry.
      await waitFor(() => {
        expect(screen.getByText(/1 chat found/i)).toBeInTheDocument();
      });
      const threadEntries = screen
        .getByTestId("attach-messages-modal")
        .querySelectorAll('[data-testid^="thread-"]');
      expect(threadEntries).toHaveLength(1);

      // Select the whole conversation and attach → the exact union of all four
      // constituent message ids is linked in one call.
      fireEvent.click(screen.getByTestId("select-all-button"));
      fireEvent.click(screen.getByTestId("attach-button"));

      await waitFor(() => {
        expect(mockLinkMessages).toHaveBeenCalledTimes(1);
      });
      const [linkedIds, txnId] = mockLinkMessages.mock.calls[0];
      expect([...linkedIds].sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
      expect(txnId).toBe("txn-456");
    });

    it("keeps a real group chat as its own separate conversation entry", async () => {
      mockGetMessageContacts.mockResolvedValue({
        success: true,
        contacts: [
          { contact: "+14155550100", contactName: null, messageCount: 2, lastMessageAt: "2024-01-18T10:00:00Z" },
        ],
      });
      mockResolveHandles.mockResolvedValue({
        success: true,
        names: { "+14155550100": "Romina", "+14155550200": "Alex Broker" },
      });
      // The +1 handle returns a 1:1 thread AND a group thread (two distinct people).
      mockGetMessagesByContact.mockResolvedValue({
        success: true,
        messages: [
          {
            id: "m-1",
            user_id: "user-123",
            channel: "sms",
            body_text: "1:1",
            sent_at: "2024-01-16T10:00:00Z",
            direction: "inbound",
            thread_id: "t-oneonone",
            participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
          },
          {
            id: "m-2",
            user_id: "user-123",
            channel: "sms",
            body_text: "group",
            sent_at: "2024-01-17T10:00:00Z",
            direction: "inbound",
            thread_id: "t-group",
            participants: JSON.stringify({
              from: "+14155550100",
              to: ["me"],
              chat_members: ["+14155550100", "+14155550200"],
            }),
          },
        ],
      });

      render(<AttachMessagesModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Romina")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Romina"));

      // The 1:1 and the group chat remain TWO separate conversation entries.
      await waitFor(() => {
        expect(screen.getByText(/2 chats found/i)).toBeInTheDocument();
      });
      const threadEntries = screen
        .getByTestId("attach-messages-modal")
        .querySelectorAll('[data-testid^="thread-"]');
      expect(threadEntries).toHaveLength(2);
    });
  });
});
