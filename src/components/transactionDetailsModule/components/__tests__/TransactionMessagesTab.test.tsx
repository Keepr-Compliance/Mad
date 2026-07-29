/**
 * Tests for TransactionMessagesTab component
 * Verifies rendering of loading, empty, error, and thread-based message list states
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

// Mock the window.api
const mockUnlinkMessages = jest.fn();
const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetNamesByPhones = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        unlinkMessages: mockUnlinkMessages,
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: {
        getNamesByPhones: mockGetNamesByPhones,
      },
    },
    writable: true,
  });
});

describe("TransactionMessagesTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUnlinkMessages.mockResolvedValue({ success: true });
    mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [] });
    mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
    mockLinkMessages.mockResolvedValue({ success: true });
    mockGetNamesByPhones.mockResolvedValue({ success: true, names: {} });
  });

  // Mock messages for testing
  const mockMessages: Partial<Communication>[] = [
    {
      id: "msg-1",
      user_id: "user-456",
      channel: "sms",
      body_text: "Got your message about the property!",
      sent_at: "2024-01-16T11:00:00Z",
      direction: "inbound",
      thread_id: "thread-1",
      participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
      has_attachments: false,
      is_false_positive: false,
    },
    {
      id: "msg-2",
      user_id: "user-456",
      channel: "imessage",
      body_text: "Can we schedule a showing tomorrow?",
      sent_at: "2024-01-17T12:00:00Z",
      direction: "outbound",
      thread_id: "thread-1",
      participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }),
      has_attachments: false,
      is_false_positive: false,
    },
    {
      id: "msg-3",
      user_id: "user-456",
      channel: "sms",
      body_text: "Thanks for the update!",
      sent_at: "2024-01-19T09:00:00Z",
      direction: "inbound",
      thread_id: "thread-2",
      participants: JSON.stringify({ from: "+14155550200", to: ["+14155550101"] }),
      has_attachments: false,
      is_false_positive: false,
    },
  ];

  describe("loading state", () => {
    it("should display loading spinner when loading is true", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={true}
          error={null}
        />
      );

      expect(screen.getByText("Loading messages...")).toBeInTheDocument();
    });

    it("should display spinning animation element", () => {
      const { container } = render(
        <TransactionMessagesTab
          messages={[]}
          loading={true}
          error={null}
        />
      );

      // Check for the spinner element with animate-spin class
      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("should display error message when error is set", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error="Failed to load messages"
        />
      );

      expect(screen.getByText("Failed to load messages")).toBeInTheDocument();
    });

    it("should display support message with error", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error="Network error"
        />
      );

      expect(
        screen.getByText("Please try again or contact support if the issue persists.")
      ).toBeInTheDocument();
    });

    it("should display error icon", () => {
      const { container } = render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error="Some error"
        />
      );

      // Check for SVG with error color styling
      const errorIcon = container.querySelector("svg.text-red-300");
      expect(errorIcon).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("should display empty state when no messages and not loading", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
        />
      );

      expect(screen.getByText("No text messages linked")).toBeInTheDocument();
    });

    it("should display explanation text in empty state", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
        />
      );

      expect(
        screen.getByText(/Click.*Attach Messages.*to get started/i)
      ).toBeInTheDocument();
    });

    it("should display message icon in empty state", () => {
      const { container } = render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
        />
      );

      // Check for SVG with gray styling
      const messageIcon = container.querySelector("svg.text-gray-300");
      expect(messageIcon).toBeInTheDocument();
    });
  });

  describe("messages list", () => {
    it("should render thread list when messages exist", () => {
      render(
        <TransactionMessagesTab
          messages={mockMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Should have thread list container
      expect(screen.getByTestId("message-thread-list")).toBeInTheDocument();

      // Should render thread cards
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBeGreaterThan(0);
    });

    it("should render thread cards for 1:1 chats", () => {
      // 1:1 chat messages - single external participant per thread
      const singleParticipantMessages: Partial<Communication>[] = [
        {
          id: "msg-1",
          user_id: "user-456",
          channel: "sms",
          body_text: "Single chat message 1",
          sent_at: "2024-01-16T11:00:00Z",
          direction: "inbound",
          thread_id: "thread-single",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
          has_attachments: false,
          is_false_positive: false,
        },
        {
          id: "msg-2",
          user_id: "user-456",
          channel: "sms",
          body_text: "Single chat message 2",
          sent_at: "2024-01-17T12:00:00Z",
          direction: "outbound",
          thread_id: "thread-single",
          participants: JSON.stringify({ from: "me", to: ["+14155550100"] }),
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={singleParticipantMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Should render thread card
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
      // Should show contact name/phone
      expect(screen.getByTestId("thread-contact-name")).toBeInTheDocument();
    });

    it("should render multiple thread cards for multiple threads", () => {
      render(
        <TransactionMessagesTab
          messages={mockMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Mock data has 2 threads (thread-1 and thread-2)
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBe(2);
    });

    it("should group messages into threads", () => {
      render(
        <TransactionMessagesTab
          messages={mockMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Should have thread list container
      expect(screen.getByTestId("message-thread-list")).toBeInTheDocument();

      // Should have 2 thread cards (thread-1 and thread-2)
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBe(2);
    });

    it("should display contact name in thread header", () => {
      render(
        <TransactionMessagesTab
          messages={mockMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Each thread should have a contact name element
      const contactNames = screen.getAllByTestId("thread-contact-name");
      expect(contactNames.length).toBe(2);
    });

    it("should display phone numbers as thread headers", () => {
      render(
        <TransactionMessagesTab
          messages={mockMessages as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Thread headers should show phone numbers from participants
      const contactNames = screen.getAllByTestId("thread-contact-name");
      expect(contactNames.length).toBe(2);
    });

    it("should handle messages without thread_id", () => {
      const messagesWithoutThreadId: Partial<Communication>[] = [
        {
          id: "solo-msg-1",
          user_id: "user-456",
          channel: "sms",
          body_text: "Solo message 1",
          sent_at: "2024-01-16T11:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
        {
          id: "solo-msg-2",
          user_id: "user-456",
          channel: "sms",
          body_text: "Solo message 2",
          sent_at: "2024-01-17T11:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messagesWithoutThreadId as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Each message without thread_id should be in its own "thread"
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBe(2);
    });

    it("should display Unknown for messages without participants", () => {
      const messageWithoutParticipants: Partial<Communication>[] = [
        {
          id: "no-participants",
          user_id: "user-456",
          channel: "sms",
          body_text: "Message without participants",
          sent_at: "2024-01-20T10:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithoutParticipants as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Should show "Unknown" in the thread header
      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent("Unknown");
    });

    it("should use legacy sender field as fallback", () => {
      const messageWithLegacySender: Partial<Communication>[] = [
        {
          id: "legacy-sender",
          user_id: "user-456",
          channel: "sms",
          body_text: "Message with legacy sender",
          sent_at: "2024-01-20T10:00:00Z",
          sender: "John Doe",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithLegacySender as Communication[]}
          loading={false}
          error={null}
        />
      );

      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent("John Doe");
    });
  });

  describe("thread card display", () => {
    it("should display View button to open conversation modal", () => {
      const inboundMessage: Partial<Communication>[] = [
        {
          id: "inbound-msg",
          user_id: "user-456",
          channel: "sms",
          body_text: "Inbound message",
          sent_at: "2024-01-20T10:00:00Z",
          direction: "inbound",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={inboundMessage as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Thread card should have View button
      expect(screen.getByTestId("toggle-thread-button")).toHaveTextContent("View");
    });

  });

  describe("date formatting", () => {
    it("should render thread card for message with date", () => {
      const messageWithDate: Partial<Communication>[] = [
        {
          id: "dated-msg",
          user_id: "user-456",
          channel: "sms",
          body_text: "Dated message",
          sent_at: "2024-01-16T11:30:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithDate as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Thread card should be rendered
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
      // Contact name should be shown
      expect(screen.getByTestId("thread-contact-name")).toBeInTheDocument();
    });

    it("should use received_at as fallback for date", () => {
      const messageWithReceivedAt: Partial<Communication>[] = [
        {
          id: "received-msg",
          user_id: "user-456",
          channel: "sms",
          body_text: "Received message",
          received_at: "2024-01-17T14:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithReceivedAt as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Should render thread card for message with received_at date
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
    });
  });

  describe("body text fallbacks", () => {
    it("should render thread card for message with body_plain", () => {
      const messageWithBodyPlain: Partial<Communication>[] = [
        {
          id: "plain-msg",
          user_id: "user-456",
          channel: "sms",
          body_plain: "Plain body content",
          sent_at: "2024-01-20T10:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithBodyPlain as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Thread card should be rendered for message with body_plain
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
    });

    it("should render thread card for message with body", () => {
      const messageWithBody: Partial<Communication>[] = [
        {
          id: "body-msg",
          user_id: "user-456",
          channel: "sms",
          body: "Legacy body content",
          sent_at: "2024-01-20T10:00:00Z",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messageWithBody as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Thread card should be rendered for message with legacy body field
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
    });
  });

  describe("thread sorting", () => {
    it("should sort threads by most recent message", () => {
      // Thread 1 has older messages, Thread 2 has newer
      const messagesForSorting: Partial<Communication>[] = [
        {
          id: "old-msg",
          user_id: "user-456",
          channel: "sms",
          body_text: "Old message",
          sent_at: "2024-01-15T10:00:00Z",
          thread_id: "thread-old",
          has_attachments: false,
          is_false_positive: false,
        },
        {
          id: "new-msg",
          user_id: "user-456",
          channel: "sms",
          body_text: "New message",
          sent_at: "2024-01-17T10:00:00Z",
          thread_id: "thread-new",
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={messagesForSorting as Communication[]}
          loading={false}
          error={null}
        />
      );

      const threadCards = screen.getAllByTestId("message-thread-card");
      // Newest thread should be first
      expect(threadCards[0]).toHaveAttribute("data-thread-id", "thread-new");
      expect(threadCards[1]).toHaveAttribute("data-thread-id", "thread-old");
    });
  });

  describe("unlink flow", () => {
    const messagesWithUserId: Partial<Communication>[] = [
      {
        id: "msg-1",
        user_id: "user-456",
        channel: "sms",
        body_text: "Test message 1",
        sent_at: "2024-01-16T11:00:00Z",
        direction: "inbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
        has_attachments: false,
        is_false_positive: false,
      },
      {
        id: "msg-2",
        user_id: "user-456",
        channel: "sms",
        body_text: "Test message 2",
        sent_at: "2024-01-17T11:00:00Z",
        direction: "outbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }),
        has_attachments: false,
        is_false_positive: false,
      },
    ];

    it("should show unlink button when userId and transactionId are provided", () => {
      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      // Unlink button should be visible
      expect(screen.getByTestId("unlink-thread-button")).toBeInTheDocument();
    });

    it("should not show unlink button when userId or transactionId is missing", () => {
      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
        />
      );

      // Unlink button should not exist
      expect(screen.queryByTestId("unlink-thread-button")).not.toBeInTheDocument();
    });

    it("should open unlink confirmation modal when unlink button is clicked", () => {
      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      // Click the unlink button
      fireEvent.click(screen.getByTestId("unlink-thread-button"));

      // Modal should appear
      expect(screen.getByTestId("unlink-message-modal")).toBeInTheDocument();
      expect(screen.getByText("Remove Messages from Transaction?")).toBeInTheDocument();
    });

    it("should show phone number and message count in unlink modal", () => {
      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));

      // Should show modal with correct message count
      const modal = screen.getByTestId("unlink-message-modal");
      expect(modal).toBeInTheDocument();
      // Modal should contain the phone number somewhere
      expect(modal).toHaveTextContent("+14155550100");
      expect(modal).toHaveTextContent("2 messages");
    });

    it("should close modal when cancel is clicked", () => {
      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      expect(screen.getByTestId("unlink-message-modal")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("unlink-cancel-button"));
      expect(screen.queryByTestId("unlink-message-modal")).not.toBeInTheDocument();
    });

    it("should call unlinkMessages API when confirmed", async () => {
      const mockOnMessagesChanged = jest.fn();
      const mockOnShowSuccess = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onMessagesChanged={mockOnMessagesChanged}
          onShowSuccess={mockOnShowSuccess}
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      await waitFor(() => {
        // TASK-1116: unlinkMessages now requires transactionId for thread-based unlinking
        // Use arrayContaining to avoid flaky tests due to Map iteration order
        expect(mockUnlinkMessages).toHaveBeenCalledWith(
          expect.arrayContaining(["msg-1", "msg-2"]),
          "txn-123"
        );
        // Verify exact count of message IDs passed
        expect(mockUnlinkMessages.mock.calls[0][0]).toHaveLength(2);
      });

      await waitFor(() => {
        expect(mockOnShowSuccess).toHaveBeenCalledWith("Messages removed from transaction");
        expect(mockOnMessagesChanged).toHaveBeenCalled();
      });
    });

    it("should show error message when unlink fails", async () => {
      mockUnlinkMessages.mockResolvedValue({
        success: false,
        error: "Network error occurred",
      });

      const mockOnShowError = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onShowError={mockOnShowError}
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      await waitFor(() => {
        expect(mockOnShowError).toHaveBeenCalledWith("Network error occurred");
      });
    });

    it("should handle API exception during unlink", async () => {
      mockUnlinkMessages.mockRejectedValue(new Error("Connection failed"));

      const mockOnShowError = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onShowError={mockOnShowError}
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      await waitFor(() => {
        expect(mockOnShowError).toHaveBeenCalledWith("Connection failed");
      });
    });

    it("should use optimistic removal (onRemoveMessagesByIds) instead of full refresh (TASK-2094)", async () => {
      const mockOnMessagesChanged = jest.fn();
      const mockOnRemoveMessagesByIds = jest.fn();
      const mockOnShowSuccess = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onMessagesChanged={mockOnMessagesChanged}
          onRemoveMessagesByIds={mockOnRemoveMessagesByIds}
          onShowSuccess={mockOnShowSuccess}
        />
      );

      // Thread list should be mounted
      expect(screen.getByTestId("message-thread-list")).toBeInTheDocument();

      // Click unlink and confirm
      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      await waitFor(() => {
        expect(mockUnlinkMessages).toHaveBeenCalled();
      });

      await waitFor(() => {
        // Should call optimistic removal with the message IDs
        expect(mockOnRemoveMessagesByIds).toHaveBeenCalledWith(
          expect.arrayContaining(["msg-1", "msg-2"])
        );
        // Should NOT call onMessagesChanged (full refresh) when optimistic removal is available
        expect(mockOnMessagesChanged).not.toHaveBeenCalled();
      });
    });

    it("should fall back to onMessagesChanged when onRemoveMessagesByIds is not provided (TASK-2094)", async () => {
      const mockOnMessagesChanged = jest.fn();
      const mockOnShowSuccess = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onMessagesChanged={mockOnMessagesChanged}
          onShowSuccess={mockOnShowSuccess}
        />
      );

      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      await waitFor(() => {
        expect(mockUnlinkMessages).toHaveBeenCalled();
      });

      await waitFor(() => {
        // Without optimistic removal, should fall back to full refresh
        expect(mockOnMessagesChanged).toHaveBeenCalled();
      });
    });

    it("should await async onMessagesChanged callback before closing modal", async () => {
      // Track when the callback completes
      let callbackResolved = false;
      const mockOnMessagesChanged = jest.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            callbackResolved = true;
            resolve();
          }, 50);
        });
      });
      const mockOnShowSuccess = jest.fn();

      render(
        <TransactionMessagesTab
          messages={messagesWithUserId as Communication[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
          onMessagesChanged={mockOnMessagesChanged}
          onShowSuccess={mockOnShowSuccess}
        />
      );

      // Open unlink modal
      fireEvent.click(screen.getByTestId("unlink-thread-button"));
      expect(screen.getByTestId("unlink-message-modal")).toBeInTheDocument();

      // Confirm unlink
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));

      // Wait for API call
      await waitFor(() => {
        expect(mockUnlinkMessages).toHaveBeenCalled();
      });

      // Callback should be called and awaited before modal closes
      await waitFor(() => {
        expect(mockOnMessagesChanged).toHaveBeenCalled();
        expect(callbackResolved).toBe(true);
      });

      // Modal should be closed after callback completes
      await waitFor(() => {
        expect(screen.queryByTestId("unlink-message-modal")).not.toBeInTheDocument();
      });
    });
  });

  describe("audit period filter (BACKLOG-357)", () => {
    // Messages spanning different date ranges for filter testing
    const messagesForDateFilter: Partial<Communication>[] = [
      {
        id: "msg-before",
        user_id: "user-456",
        channel: "sms",
        body_text: "Message before audit period",
        sent_at: "2024-01-01T10:00:00Z",
        direction: "inbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
        has_attachments: false,
        is_false_positive: false,
      },
      {
        id: "msg-during-1",
        user_id: "user-456",
        channel: "sms",
        body_text: "Message during audit period 1",
        sent_at: "2024-01-15T10:00:00Z",
        direction: "inbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
        has_attachments: false,
        is_false_positive: false,
      },
      {
        id: "msg-during-2",
        user_id: "user-456",
        channel: "sms",
        body_text: "Message during audit period 2",
        sent_at: "2024-01-20T10:00:00Z",
        direction: "outbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }),
        has_attachments: false,
        is_false_positive: false,
      },
      {
        id: "msg-after",
        user_id: "user-456",
        channel: "sms",
        body_text: "Message after audit period",
        sent_at: "2024-02-01T10:00:00Z",
        direction: "inbound",
        thread_id: "thread-1",
        participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
        has_attachments: false,
        is_false_positive: false,
      },
      {
        id: "msg-thread2-outside",
        user_id: "user-456",
        channel: "sms",
        body_text: "Thread 2 message outside audit",
        sent_at: "2024-02-15T10:00:00Z",
        direction: "inbound",
        thread_id: "thread-2",
        participants: JSON.stringify({ from: "+14155550200", to: ["+14155550101"] }),
        has_attachments: false,
        is_false_positive: false,
      },
    ];

    it("should show audit period filter toggle when audit dates are provided", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      expect(screen.getByTestId("audit-period-filter")).toBeInTheDocument();
      expect(screen.getByTestId("audit-period-filter-checkbox")).toBeInTheDocument();
    });

    it("should not show audit period filter when no audit dates are provided", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
        />
      );

      expect(screen.queryByTestId("audit-period-filter")).not.toBeInTheDocument();
    });

    it("should filter threads by audit date range when toggle is on (default)", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      // Toggle should be checked by default when audit dates are available
      const checkbox = screen.getByTestId("audit-period-filter-checkbox");
      expect(checkbox).toBeChecked();

      // Should show filtered message count in header (format: "X conversations (Y text messages)")
      expect(screen.getByText(/1 conversation/)).toBeInTheDocument();

      // BACKLOG-2278: the info line now mirrors the Emails tab — a plain-language
      // filter label rather than an inline "Showing X of Y" count.
      const infoLine = screen.getByTestId("audit-period-info");
      expect(infoLine).toHaveTextContent(/Remove texts outside audit range/);

      // Thread 2 (only has messages outside audit period) should be hidden
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBe(1);
    });

    it("should show all threads when toggle is turned off", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      // Turn off the filter
      const checkbox = screen.getByTestId("audit-period-filter-checkbox");
      fireEvent.click(checkbox);

      // Should show all messages (format: "X conversations (Y text messages)")
      expect(screen.getByText(/2 conversations/)).toBeInTheDocument();

      // Both threads should be visible
      const threadCards = screen.getAllByTestId("message-thread-card");
      expect(threadCards.length).toBe(2);
    });

    it("should show the audit-range filter label and (i) info button", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      expect(screen.getByTestId("audit-period-info")).toBeInTheDocument();
      expect(screen.getByTestId("audit-period-info")).toHaveTextContent(/Remove texts outside audit range/);
      expect(screen.getByTestId("audit-period-info-button")).toBeInTheDocument();
      // Explanation is discoverable via hover (native title) before any click.
      expect(screen.getByTestId("audit-period-info-button")).toHaveAttribute(
        "title",
        expect.stringContaining("audit period")
      );
    });

    // BACKLOG-2277: the displayed audit range must match exactly what the user
    // set — a bare "YYYY-MM-DD" is a LOCAL calendar day, not UTC midnight, so it
    // must not shift back a day (e.g. Jan 10 -> Jan 9) in negative-offset zones.
    it("should show the correct (non-off-by-one) audit range in the (i) popover", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      // Popover is closed until the (i) button is clicked.
      expect(screen.queryByTestId("audit-period-info-popover")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("audit-period-info-button"));

      const popover = screen.getByTestId("audit-period-info-popover");
      expect(popover).toBeInTheDocument();
      // Exact days the user set — no -1 day shift.
      expect(popover).toHaveTextContent(/Jan\s+10,\s+2024/);
      expect(popover).toHaveTextContent(/Jan\s+25,\s+2024/);
      expect(popover).not.toHaveTextContent(/Jan\s+9,\s+2024/);
    });

    // BACKLOG-2277: the off-by-one is a FILTER (inclusion) bug, not just a label
    // bug — a UTC-midnight start boundary can drop a text sent early on the first
    // audit day. Boundaries are now LOCAL start-of-day, so a text at 08:00 local
    // on the audit start day is INCLUDED, and a text before the start is excluded.
    it("INCLUDES a text sent early on the audit start day (local start-of-day boundary)", () => {
      const boundaryMessages: Partial<Communication>[] = [
        {
          id: "msg-startday",
          user_id: "user-456",
          channel: "sms",
          body_text: "Sent early on the first audit day",
          // No trailing "Z" → parsed as LOCAL time → 08:00 on Jan 1 in the
          // runner's timezone, making this test timezone-agnostic.
          sent_at: "2026-01-01T08:00:00",
          direction: "inbound",
          thread_id: "thread-inside",
          participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
          has_attachments: false,
          is_false_positive: false,
        },
        {
          id: "msg-beforestart",
          user_id: "user-456",
          channel: "sms",
          body_text: "Two days before the audit start",
          sent_at: "2025-12-30T10:00:00",
          direction: "inbound",
          thread_id: "thread-outside",
          participants: JSON.stringify({ from: "+14155550200", to: ["+14155550101"] }),
          has_attachments: false,
          is_false_positive: false,
        },
      ];

      render(
        <TransactionMessagesTab
          messages={boundaryMessages as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2026-01-01"
          auditEndDate="2026-01-31"
        />
      );

      // Filter is ON by default. Only the in-range (start-day) conversation shows —
      // the first-day text is INCLUDED, the pre-start text is excluded.
      expect(screen.getAllByTestId("message-thread-card")).toHaveLength(1);
      expect(screen.getByText(/1 conversation/)).toBeInTheDocument();
      expect(screen.getByText(/of 2 conversation/)).toBeInTheDocument();

      // The displayed range matches exactly what the user set (no -1 day shift).
      fireEvent.click(screen.getByTestId("audit-period-info-button"));
      const popover = screen.getByTestId("audit-period-info-popover");
      expect(popover).toHaveTextContent(/Jan\s+1,\s+2026/);
      expect(popover).toHaveTextContent(/Jan\s+31,\s+2026/);
      expect(popover).not.toHaveTextContent(/Dec\s+31,\s+2025/);
    });

    it("should show empty state when all messages are outside audit period", () => {
      // All messages are outside Jan 10-11 range
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-11"
        />
      );

      // Should show empty filtered state with option to show all
      expect(screen.getByText("No messages in audit period")).toBeInTheDocument();
      expect(screen.getByText("Show all messages")).toBeInTheDocument();
    });

    it("should show all messages when clicking 'Show all messages' link", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-11"
        />
      );

      // Click show all messages
      fireEvent.click(screen.getByText("Show all messages"));

      // Toggle should be unchecked
      expect(screen.getByTestId("audit-period-filter-checkbox")).not.toBeChecked();

      // Should show all messages now (format: "X conversations (Y text messages)")
      expect(screen.getByText(/2 conversations/)).toBeInTheDocument();
    });

    it("should handle ongoing transaction with only start date", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-15"
          auditEndDate={null}
        />
      );

      // Filter should still be available
      expect(screen.getByTestId("audit-period-filter")).toBeInTheDocument();

      // Should show messages from Jan 15 onwards (4 messages)
      expect(screen.getAllByText(/2 conversations/)[0]).toBeInTheDocument();
    });

    it("should update conversation count based on filter", () => {
      render(
        <TransactionMessagesTab
          messages={messagesForDateFilter as Communication[]}
          loading={false}
          error={null}
          auditStartDate="2024-01-10"
          auditEndDate="2024-01-25"
        />
      );

      // With filter on, only 1 conversation has messages in period (format: "X conversations (Y text messages)")
      expect(screen.getByText(/1 conversation/)).toBeInTheDocument();
      expect(screen.getByText(/of 2 conversation/)).toBeInTheDocument();

      // Turn off filter
      fireEvent.click(screen.getByTestId("audit-period-filter-checkbox"));

      // Both conversations should show
      expect(screen.getByText(/2 conversations/)).toBeInTheDocument();
    });
  });

  describe("attach flow", () => {
    it("should show Attach Messages button when userId and transactionId are provided", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      expect(screen.getByTestId("attach-messages-button")).toBeInTheDocument();
    });

    it("should not show Attach Messages button when userId or transactionId is missing", () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
        />
      );

      expect(screen.queryByTestId("attach-messages-button")).not.toBeInTheDocument();
    });

    it("should open attach modal when Attach Messages button is clicked", async () => {
      render(
        <TransactionMessagesTab
          messages={[]}
          loading={false}
          error={null}
          userId="user-456"
          transactionId="txn-123"
        />
      );

      fireEvent.click(screen.getByTestId("attach-messages-button"));

      await waitFor(() => {
        expect(screen.getByTestId("attach-messages-modal")).toBeInTheDocument();
      });
    });
  });
});
