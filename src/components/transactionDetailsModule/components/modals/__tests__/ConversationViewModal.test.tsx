/**
 * ConversationViewModal Tests
 * Tests for the conversation view modal with attachment display (TASK-1012)
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ConversationViewModal } from "../ConversationViewModal";

// Mock the window.api for attachment fetching
const mockGetMessageAttachmentsBatch = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      messages: {
        getMessageAttachmentsBatch: mockGetMessageAttachmentsBatch,
      },
    },
    writable: true,
  });
});

describe("ConversationViewModal", () => {
  const mockOnClose = jest.fn();

  const defaultMessages = [
    {
      id: "msg-1",
      user_id: "user-123",
      channel: "imessage",
      body_text: "Hello there!",
      sent_at: "2024-01-15T10:00:00Z",
      direction: "inbound" as const,
      has_attachments: false,
      participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
    },
    {
      id: "msg-2",
      user_id: "user-123",
      channel: "imessage",
      body_text: "Hi! How are you?",
      sent_at: "2024-01-15T10:05:00Z",
      direction: "outbound" as const,
      has_attachments: false,
      participants: JSON.stringify({ from: "me", to: ["+14155550100"] }),
    },
  ];

  const defaultProps = {
    messages: defaultMessages,
    contactName: "John Doe",
    phoneNumber: "+14155550100",
    contactNames: {},
    onClose: mockOnClose,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessageAttachmentsBatch.mockResolvedValue({});
  });

  describe("Basic Rendering", () => {
    it("renders modal with header and messages", () => {
      render(<ConversationViewModal {...defaultProps} />);

      expect(screen.getByText("John Doe")).toBeInTheDocument();
      expect(screen.getByText("2 messages")).toBeInTheDocument();
      expect(screen.getByText("Hello there!")).toBeInTheDocument();
      expect(screen.getByText("Hi! How are you?")).toBeInTheDocument();
    });

    it("displays phone number when no contact name", () => {
      render(
        <ConversationViewModal
          {...defaultProps}
          contactName={undefined}
        />
      );

      expect(screen.getByText("+14155550100")).toBeInTheDocument();
    });

    it("shows participant names in header for group chats", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from sender 1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from sender 2",
          sent_at: "2024-01-15T10:05:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice Smith",
        "+14155550200": "Bob Jones",
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // Should show participant names instead of single contact name
      expect(screen.getByText("Alice Smith, Bob Jones")).toBeInTheDocument();
    });

    it("shows phone numbers for unknown contacts in group chat header", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from sender 1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from sender 2",
          sent_at: "2024-01-15T10:05:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={{}}
        />
      );

      // Should show phone numbers when no contact names available
      expect(screen.getByText("+14155550100, +14155550200")).toBeInTheDocument();
    });

    it("shows +X more for groups with more than 3 participants", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message 1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message 2",
          sent_at: "2024-01-15T10:01:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
        {
          id: "msg-3",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message 3",
          sent_at: "2024-01-15T10:02:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550300", to: ["me"] }),
        },
        {
          id: "msg-4",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message 4",
          sent_at: "2024-01-15T10:03:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550400", to: ["me"] }),
        },
        {
          id: "msg-5",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message 5",
          sent_at: "2024-01-15T10:04:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550500", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice",
        "+14155550200": "Bob",
        "+14155550300": "Carol",
        "+14155550400": "Dave",
        "+14155550500": "Eve",
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // Should show first 3 names plus "+2 more"
      expect(screen.getByText(/Alice, Bob, Carol \+2 more/)).toBeInTheDocument();
    });
  });

  describe("Sender Name Display in Group Chats", () => {
    it("shows sender name on inbound messages in group chats", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Hello from Alice",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Hello from Bob",
          sent_at: "2024-01-15T10:05:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice",
        "+14155550200": "Bob",
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // TASK-1794: Messages are sorted newest-first, so Bob (10:05) comes before Alice (10:00)
      const senderElements = screen.getAllByTestId("group-message-sender");
      expect(senderElements).toHaveLength(2);
      expect(senderElements[0]).toHaveTextContent("Bob");
      expect(senderElements[1]).toHaveTextContent("Alice");
    });

    it("hides sender name for consecutive messages from same sender", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "First message from Alice",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Second message from Alice",
          sent_at: "2024-01-15T10:01:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-3",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from Bob",
          sent_at: "2024-01-15T10:02:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice",
        "+14155550200": "Bob",
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // TASK-1794: Messages are sorted newest-first
      // Bob (10:02) -> Alice (10:01, consecutive) -> Alice (10:00, hidden as consecutive)
      const senderElements = screen.getAllByTestId("group-message-sender");
      expect(senderElements).toHaveLength(2);
      expect(senderElements[0]).toHaveTextContent("Bob");
      expect(senderElements[1]).toHaveTextContent("Alice");
    });

    it("does not show sender name on outbound messages", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from Alice",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "My reply",
          sent_at: "2024-01-15T10:01:00Z",
          direction: "outbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "me", to: ["+14155550100", "+14155550200"] }),
        },
        {
          id: "msg-3",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from Bob",
          sent_at: "2024-01-15T10:02:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice",
        "+14155550200": "Bob",
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // TASK-1794: Messages are sorted newest-first
      // Bob (10:02) -> outbound (10:01, no sender) -> Alice (10:00)
      const senderElements = screen.getAllByTestId("group-message-sender");
      expect(senderElements).toHaveLength(2);
      expect(senderElements[0]).toHaveTextContent("Bob");
      expect(senderElements[1]).toHaveTextContent("Alice");
    });

    it("falls back to phone number when contact name not available", () => {
      const groupMessages = [
        {
          id: "msg-1",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from known contact",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        },
        {
          id: "msg-2",
          user_id: "user-123",
          channel: "imessage",
          body_text: "Message from unknown contact",
          sent_at: "2024-01-15T10:01:00Z",
          direction: "inbound" as const,
          has_attachments: false,
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        },
      ];

      const contactNamesForGroup = {
        "+14155550100": "Alice",
        // +14155550200 intentionally not in contactNames
      };

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={groupMessages}
          contactNames={contactNamesForGroup}
        />
      );

      // TASK-1794: Messages are sorted newest-first
      // Unknown (10:01) -> Alice (10:00)
      const senderElements = screen.getAllByTestId("group-message-sender");
      expect(senderElements).toHaveLength(2);
      expect(senderElements[0]).toHaveTextContent("+14155550200");
      expect(senderElements[1]).toHaveTextContent("Alice");
    });
  });

  describe("Attachment Display (TASK-1012)", () => {
    // Note: Attachment loading now requires message_id field (SPRINT-034 fix)
    // because attachments are stored by message_id, not communication id

    it("loads attachments for messages with has_attachments flag and message_id", async () => {
      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-with-attachment",
          message_id: "macos-msg-123", // Required for attachment lookup
          has_attachments: true,
        },
      ];

      mockGetMessageAttachmentsBatch.mockResolvedValue({
        "macos-msg-123": [
          {
            id: "att-1",
            message_id: "macos-msg-123",
            filename: "photo.jpg",
            mime_type: "image/jpeg",
            file_size_bytes: 12345,
            data: "base64data",
          },
        ],
      });

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      await waitFor(() => {
        expect(mockGetMessageAttachmentsBatch).toHaveBeenCalledWith([
          "macos-msg-123",
        ]);
      });
    });

    it("does not call API when no messages have attachments", () => {
      render(<ConversationViewModal {...defaultProps} />);

      expect(mockGetMessageAttachmentsBatch).not.toHaveBeenCalled();
    });

    it("does not call API when messages have has_attachments but no message_id", () => {
      // Messages without message_id won't trigger attachment loading
      const messagesWithoutMessageId = [
        {
          ...defaultMessages[0],
          id: "msg-no-message-id",
          has_attachments: true,
          // No message_id field
        },
      ];

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithoutMessageId}
        />
      );

      expect(mockGetMessageAttachmentsBatch).not.toHaveBeenCalled();
    });

    it("shows loading state while fetching attachments", async () => {
      // Create a promise that we can control
      let resolveAttachments: (value: unknown) => void;
      const attachmentPromise = new Promise((resolve) => {
        resolveAttachments = resolve;
      });
      mockGetMessageAttachmentsBatch.mockReturnValue(attachmentPromise);

      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-loading",
          message_id: "macos-loading-123", // Required for attachment lookup
          has_attachments: true,
        },
      ];

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      // Should show loading state
      expect(screen.getByText("Loading attachment...")).toBeInTheDocument();

      // Resolve the promise
      resolveAttachments!({});

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText("Loading attachment...")).not.toBeInTheDocument();
      });
    });

    it("shows placeholder text for HEIC attachments (not displayable)", async () => {
      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-with-heic",
          message_id: "macos-heic-123",
          has_attachments: true,
        },
      ];

      // HEIC files are filtered out as non-displayable
      mockGetMessageAttachmentsBatch.mockResolvedValue({
        "macos-heic-123": [
          {
            id: "att-1",
            message_id: "macos-heic-123",
            filename: "photo.heic",
            mime_type: "image/heic",
            file_size_bytes: 12345,
            data: "base64data",
          },
        ],
      });

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      // The message text should still be shown
      await waitFor(() => {
        expect(screen.getByText("Hello there!")).toBeInTheDocument();
      });
    });

    it("renders image when attachment data is available", async () => {
      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-with-image",
          message_id: "macos-image-123",
          has_attachments: true,
        },
      ];

      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      mockGetMessageAttachmentsBatch.mockResolvedValue({
        "macos-image-123": [
          {
            id: "att-1",
            message_id: "macos-image-123",
            filename: "test.png",
            mime_type: "image/png",
            file_size_bytes: 100,
            data: base64Data,
          },
        ],
      });

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      await waitFor(() => {
        const img = screen.getByAltText("test.png");
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute(
          "src",
          `data:image/png;base64,${base64Data}`
        );
      });
    });

    it("shows placeholder when attachment file is missing", async () => {
      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-missing-file",
          message_id: "macos-missing-123",
          has_attachments: true,
        },
      ];

      mockGetMessageAttachmentsBatch.mockResolvedValue({
        "macos-missing-123": [
          {
            id: "att-1",
            message_id: "macos-missing-123",
            filename: "missing.jpg",
            mime_type: "image/jpeg",
            file_size_bytes: 12345,
            data: null, // File not found
          },
        ],
      });

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("[Image: missing.jpg]")).toBeInTheDocument();
      });
    });

    it("handles API errors gracefully", async () => {
      const messagesWithAttachments = [
        {
          ...defaultMessages[0],
          id: "msg-error",
          message_id: "macos-error-123",
          has_attachments: true,
        },
      ];

      mockGetMessageAttachmentsBatch.mockRejectedValue(new Error("API Error"));

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={messagesWithAttachments}
        />
      );

      // Should not crash - when API fails, no attachments are loaded
      // so messages with has_attachments show placeholder
      await waitFor(() => {
        expect(screen.getByText(/Attachment/)).toBeInTheDocument();
      });
    });
  });

  describe("Message Sorting", () => {
    it("displays messages in chronological order", () => {
      const unorderedMessages = [
        {
          ...defaultMessages[0],
          id: "msg-later",
          body_text: "Second message text here",
          sent_at: "2024-01-15T11:00:00Z",
        },
        {
          ...defaultMessages[0],
          id: "msg-earlier",
          body_text: "First message text here",
          sent_at: "2024-01-15T09:00:00Z",
        },
      ];

      render(
        <ConversationViewModal
          {...defaultProps}
          messages={unorderedMessages}
        />
      );

      // TASK-1794: Messages are sorted newest-first, so "Second" (11:00) appears before "First" (09:00)
      const firstMsg = screen.getByText("First message text here");
      const secondMsg = screen.getByText("Second message text here");

      expect(firstMsg).toBeInTheDocument();
      expect(secondMsg).toBeInTheDocument();

      // Verify ordering by checking DOM positions - newest first means Second appears before First
      expect(
        secondMsg.compareDocumentPosition(firstMsg) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });

  // BACKLOG-1935: additive optional "See transaction" affordance. Must be
  // non-regressing — the existing MessageThreadCard usage omits onSeeTransaction
  // and gets the original footer (Close only) byte-for-byte.
  describe("See transaction button (BACKLOG-1935)", () => {
    it("does NOT render the See transaction button when onSeeTransaction is omitted", () => {
      render(<ConversationViewModal {...defaultProps} />);
      expect(
        screen.queryByTestId("conversation-view-see-transaction")
      ).not.toBeInTheDocument();
      // The original Close button is still present.
      expect(screen.getByText("Close")).toBeInTheDocument();
    });

    it("renders the See transaction button when onSeeTransaction is provided", () => {
      render(
        <ConversationViewModal
          {...defaultProps}
          onSeeTransaction={jest.fn()}
        />
      );
      expect(
        screen.getByTestId("conversation-view-see-transaction")
      ).toBeInTheDocument();
      expect(screen.getByText("See transaction")).toBeInTheDocument();
    });

    it("fires onSeeTransaction when the button is clicked", () => {
      const onSeeTransaction = jest.fn();
      render(
        <ConversationViewModal
          {...defaultProps}
          onSeeTransaction={onSeeTransaction}
        />
      );
      fireEvent.click(
        screen.getByTestId("conversation-view-see-transaction")
      );
      expect(onSeeTransaction).toHaveBeenCalledTimes(1);
    });

    it("still renders messages without audit dates (contact-card context)", () => {
      // The contact card passes no auditStartDate/auditEndDate; the modal must
      // render fine and hide the audit filter (parseDateSafe tolerates undefined).
      render(
        <ConversationViewModal
          {...defaultProps}
          auditStartDate={undefined}
          auditEndDate={undefined}
          onSeeTransaction={jest.fn()}
        />
      );
      expect(screen.getByText("Hello there!")).toBeInTheDocument();
      // No audit-period filter checkbox when there are no dates.
      expect(
        screen.queryByText(/Show audit period only/)
      ).not.toBeInTheDocument();
    });
  });
});
