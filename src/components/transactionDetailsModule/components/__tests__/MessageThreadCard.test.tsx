/**
 * Tests for MessageThreadCard component and utility functions
 * Verifies thread display, grouping, and phone number extraction
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  MessageThreadCard,
  groupMessagesByThread,
  extractPhoneFromThread,
  sortThreadsByRecent,
} from "../MessageThreadCard";
import type { Communication } from "../../types";

describe("MessageThreadCard", () => {
  // Helper to create mock messages
  const createMockMessage = (overrides: Partial<Communication> = {}): Communication => ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    direction: "inbound",
    body_text: "Test message",
    sent_at: "2024-01-16T14:30:00Z",
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as Communication);

  describe("component rendering", () => {
    it("should render thread card with testid", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
    });

    it("should include thread-id data attribute", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="my-thread-id"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("message-thread-card")).toHaveAttribute(
        "data-thread-id",
        "my-thread-id"
      );
    });

    it("should display phone number when no contact name", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent(
        "+14155550100"
      );
    });

    it("should display contact name when provided", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="John Doe"
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent(
        "John Doe"
      );
    });

    it("should display contact name without phone number in card (phone hidden for cleaner layout)", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="Jane Smith"
          phoneNumber="+14155550200"
        />
      );

      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent(
        "Jane Smith"
      );
      // Phone number is intentionally not displayed in the card layout
      expect(screen.queryByTestId("thread-phone-number")).not.toBeInTheDocument();
    });
  });

  describe("avatar display", () => {
    it("should show first letter of contact name as avatar", () => {
      const messages = [createMockMessage()];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="Alice"
          phoneNumber="+14155550100"
        />
      );

      const avatar = container.querySelector(
        ".bg-gradient-to-br.from-green-500.to-teal-600"
      );
      expect(avatar).toHaveTextContent("A");
    });

    it("should show hash symbol when no contact name", () => {
      const messages = [createMockMessage()];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      const avatar = container.querySelector(
        ".bg-gradient-to-br.from-green-500.to-teal-600"
      );
      expect(avatar).toHaveTextContent("#");
    });
  });

  // BACKLOG-2278: the per-conversation date range was removed from the card. It
  // became disconnected from the data once the audit dates changed; the audit
  // period is now communicated once via the tab-level filter control instead.
  describe("date range display (removed — BACKLOG-2278)", () => {
    it("should NOT render a per-conversation date range for a multi-day thread", () => {
      const messages = [
        createMockMessage({ id: "msg-1", sent_at: "2024-01-15T10:00:00Z" }),
        createMockMessage({ id: "msg-2", sent_at: "2024-01-17T10:00:00Z" }),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="Jane Doe"
          phoneNumber="+14155550100"
        />
      );

      // No date range like "Jan 15, 2024 - Jan 17, 2024" — and no date text at all.
      // (Pattern requires a digit after "Jan" so it never matches the "Jane" name.)
      expect(container.textContent).not.toMatch(/Jan\s+15.*-.*Jan\s+17/);
      expect(container.textContent).not.toMatch(/Jan\s+\d/);
    });

    it("should NOT render a per-conversation date for a single-day thread", () => {
      const messages = [
        createMockMessage({ id: "msg-1", sent_at: "2024-01-15T10:00:00Z" }),
        createMockMessage({ id: "msg-2", sent_at: "2024-01-15T14:00:00Z" }),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // The card still renders, but no conversation date is shown.
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/Jan\s+\d/);
    });
  });

  describe("view button and preview", () => {
    it("should show View button to open modal", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("toggle-thread-button")).toHaveTextContent("View");
    });

    it("should render thread card with View button", () => {
      const messages = [
        createMockMessage({ id: "msg-1", body_text: "This is a preview message" }),
      ];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Thread card renders with View button to open full conversation
      expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
      expect(screen.getByTestId("toggle-thread-button")).toBeInTheDocument();
    });

    it("should render contact name in thread header", () => {
      const messages = [
        createMockMessage({ id: "msg-1", body_text: "Test message" }),
      ];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="John Doe"
          phoneNumber="+14155550100"
        />
      );

      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent("John Doe");
    });
  });

  describe("group chat cards", () => {
    // Helper to create a group chat message with multiple participants
    // Note: chat_members is the authoritative list of participants (used by getThreadParticipants)
    const createGroupMessage = (overrides: Partial<Communication> = {}): Communication => ({
      id: "msg-1",
      user_id: "user-123",
      channel: "sms",
      direction: "inbound",
      body_text: "Group message content",
      sent_at: "2024-01-16T14:30:00Z",
      has_attachments: false,
      is_false_positive: false,
      participants: JSON.stringify({
        from: "+14155550100",
        to: ["+14155550101", "+14155550102"],
        chat_members: ["+14155550100", "+14155550101", "+14155550102"],
      }),
      ...overrides,
    } as Communication);

    it("should NOT render message count badge for group chat", () => {
      const messages = [
        createGroupMessage({ id: "msg-1" }),
        createGroupMessage({ id: "msg-2" }),
        createGroupMessage({ id: "msg-3" }),
      ];

      render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Message count badge should NOT exist for group chats
      expect(screen.queryByTestId("group-message-count-badge")).not.toBeInTheDocument();
    });

    it("should render View button for group chat", () => {
      const messages = [
        createGroupMessage({ id: "msg-1", body_text: "Group chat preview message" }),
      ];

      render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Group chat should have View button to open full conversation
      expect(screen.getByTestId("toggle-thread-button")).toBeInTheDocument();
    });

    it("should display group indicator in contact name", () => {
      const messages = [createGroupMessage({ id: "msg-1" })];

      render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Group chat should show "Group Chat" label (without colon)
      const contactName = screen.getByTestId("thread-contact-name");
      expect(contactName.textContent).toContain("Group Chat");
    });

    it("should not display people badge for group chat (removed for cleaner layout)", () => {
      const messages = [createGroupMessage({ id: "msg-1" })];

      render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // People badge intentionally removed - contact name shows participants inline
      expect(screen.queryByText("3 people")).not.toBeInTheDocument();
    });

    it("should display participant names on separate line below Group Chat label", () => {
      const messages = [createGroupMessage({ id: "msg-1" })];

      render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Contact name container should exist
      const contactName = screen.getByTestId("thread-contact-name");
      expect(contactName).toBeInTheDocument();
      // Should show "Group Chat" header and participant names on separate lines
      expect(contactName.textContent).toContain("Group Chat");
      // Participant names are shown on a separate line with title for tooltip
      const participantLine = contactName.querySelector('[title]');
      expect(participantLine).toBeInTheDocument();
    });
  });

  describe("unknown participant filtering (BACKLOG-299)", () => {
    // Helper to create a message with specific participants
    // Includes chat_members which is the authoritative list used by getThreadParticipants
    const createMessageWithParticipants = (
      from: string,
      to: string[],
      overrides: Partial<Communication> = {}
    ): Communication => {
      // Build chat_members from from + to, excluding 'me'
      const chatMembers = [from, ...to].filter(p => p !== "me");
      return {
        id: "msg-1",
        user_id: "user-123",
        channel: "sms",
        direction: "inbound",
        body_text: "Test message",
        sent_at: "2024-01-16T14:30:00Z",
        has_attachments: false,
        is_false_positive: false,
        participants: JSON.stringify({ from, to, chat_members: chatMembers }),
        ...overrides,
      } as Communication;
    };

    it("should display 1:1 chat (not group) when one participant is 'unknown'", () => {
      // Scenario: 1:1 chat where "unknown" appears in participants
      const messages = [
        createMessageWithParticipants("+14155550100", ["me", "unknown"]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Should show 1:1 avatar (green gradient), NOT group avatar (purple)
      expect(
        container.querySelector(".bg-gradient-to-br.from-green-500.to-teal-600")
      ).toBeInTheDocument();
      expect(container.querySelector(".bg-purple-100")).not.toBeInTheDocument();

      // Should NOT show "Group Chat" label (it's a 1:1 chat)
      expect(screen.getByTestId("thread-contact-name")).not.toHaveTextContent(
        "Group Chat"
      );
    });

    it("should display 1:1 chat when 'unknown' is the from participant", () => {
      // Scenario: from is "unknown", to has actual phone
      const messages = [
        createMessageWithParticipants("unknown", ["+14155550100"]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Should show 1:1 avatar (green gradient)
      expect(
        container.querySelector(".bg-gradient-to-br.from-green-500.to-teal-600")
      ).toBeInTheDocument();
    });

    it("should display as group chat when 3+ known participants exist (regardless of unknown)", () => {
      // Scenario: Actual group chat with 3 known participants + unknown
      const messages = [
        createMessageWithParticipants("+14155550100", [
          "+14155550101",
          "+14155550102",
          "unknown",
          "me",
        ]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Should show group avatar (purple)
      expect(container.querySelector(".bg-purple-100")).toBeInTheDocument();
      expect(
        container.querySelector(".bg-gradient-to-br.from-green-500.to-teal-600")
      ).not.toBeInTheDocument();

      // Should show "Group Chat" label
      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent(
        "Group Chat"
      );
    });

    it("should display 1:1 when 2 unknown + 1 known participant", () => {
      // Edge case: multiple unknowns should all be filtered
      const messages = [
        createMessageWithParticipants("unknown", [
          "+14155550100",
          "unknown",
          "me",
        ]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Should show 1:1 avatar (only 1 known participant after filtering)
      expect(
        container.querySelector(".bg-gradient-to-br.from-green-500.to-teal-600")
      ).toBeInTheDocument();
    });

    it("should handle all-unknown participants gracefully", () => {
      // Edge case: all participants are unknown or me
      const messages = [
        createMessageWithParticipants("unknown", ["me", "unknown"]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="Unknown"
        />
      );

      // Should show 1:1 avatar (0 known participants = not a group)
      expect(
        container.querySelector(".bg-gradient-to-br.from-green-500.to-teal-600")
      ).toBeInTheDocument();
      // Should display the fallback phone number
      expect(screen.getByTestId("thread-contact-name")).toHaveTextContent(
        "Unknown"
      );
    });

    it("should display 3+ external participants as group chat", () => {
      // Verify normal group detection still works (3+ external participants = group)
      const messages = [
        createMessageWithParticipants("+14155550100", [
          "+14155550101",
          "+14155550102",
        ]),
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Should show group avatar (purple background)
      expect(container.querySelector(".bg-purple-100")).toBeInTheDocument();
    });
  });

  describe("unified styling", () => {
    it("should have hover state class on card container", () => {
      const messages = [createMockMessage()];

      render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      const card = screen.getByTestId("message-thread-card");
      expect(card.className).toContain("hover:bg-gray-50");
      expect(card.className).toContain("transition-colors");
    });

    it("should have consistent avatar size for individual chat", () => {
      const messages = [createMockMessage()];

      const { container } = render(
        <MessageThreadCard
          threadId="thread-1"
          messages={messages}
          contactName="John"
          phoneNumber="+14155550100"
        />
      );

      // Avatar is w-8 h-8
      const avatar = container.querySelector(".w-8.h-8");
      expect(avatar).toBeInTheDocument();
    });

    it("should have consistent avatar size for group chat", () => {
      const messages = [
        {
          ...createMockMessage(),
          participants: JSON.stringify({
            from: "+14155550100",
            to: ["+14155550101", "+14155550102"],
          }),
        },
      ];

      const { container } = render(
        <MessageThreadCard
          threadId="group-thread-1"
          messages={messages}
          phoneNumber="+14155550100"
        />
      );

      // Avatar is w-8 h-8
      const avatar = container.querySelector(".w-8.h-8");
      expect(avatar).toBeInTheDocument();
    });
  });
});

describe("groupMessagesByThread", () => {
  const createMockMessage = (overrides: Partial<Communication> = {}): Communication => ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as Communication);

  it("should group messages by thread_id", () => {
    const messages = [
      createMockMessage({ id: "msg-1", thread_id: "thread-A" }),
      createMockMessage({ id: "msg-2", thread_id: "thread-B" }),
      createMockMessage({ id: "msg-3", thread_id: "thread-A" }),
    ];

    const threads = groupMessagesByThread(messages);

    expect(threads.size).toBe(2);
    expect(threads.get("thread-A")?.length).toBe(2);
    expect(threads.get("thread-B")?.length).toBe(1);
  });

  it("should use message id as thread_id when no thread_id", () => {
    const messages = [
      createMockMessage({ id: "msg-solo-1" }),
      createMockMessage({ id: "msg-solo-2" }),
    ];

    const threads = groupMessagesByThread(messages);

    expect(threads.size).toBe(2);
    // Fallback key format is "msg-{id}"
    expect(threads.has("msg-msg-solo-1")).toBe(true);
    expect(threads.has("msg-msg-solo-2")).toBe(true);
  });

  it("should sort messages within thread chronologically (newest first)", () => {
    const messages = [
      createMockMessage({
        id: "msg-2",
        thread_id: "thread-A",
        sent_at: "2024-01-16T15:00:00Z",
      }),
      createMockMessage({
        id: "msg-1",
        thread_id: "thread-A",
        sent_at: "2024-01-16T14:00:00Z",
      }),
      createMockMessage({
        id: "msg-3",
        thread_id: "thread-A",
        sent_at: "2024-01-16T16:00:00Z",
      }),
    ];

    const threads = groupMessagesByThread(messages);
    const threadMessages = threads.get("thread-A");

    // TASK-1794: Newest messages first
    expect(threadMessages?.[0].id).toBe("msg-3");
    expect(threadMessages?.[1].id).toBe("msg-2");
    expect(threadMessages?.[2].id).toBe("msg-1");
  });

  it("should handle messages with received_at only (newest first)", () => {
    const messages = [
      createMockMessage({
        id: "msg-2",
        thread_id: "thread-A",
        received_at: "2024-01-16T15:00:00Z",
      }),
      createMockMessage({
        id: "msg-1",
        thread_id: "thread-A",
        received_at: "2024-01-16T14:00:00Z",
      }),
    ];

    const threads = groupMessagesByThread(messages);
    const threadMessages = threads.get("thread-A");

    // TASK-1794: Newest messages first
    expect(threadMessages?.[0].id).toBe("msg-2");
    expect(threadMessages?.[1].id).toBe("msg-1");
  });

  it("should return empty map for empty input", () => {
    const threads = groupMessagesByThread([]);
    expect(threads.size).toBe(0);
  });
});

describe("extractPhoneFromThread", () => {
  const createMockMessage = (overrides: Partial<Communication> = {}): Communication => ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as Communication);

  it("should extract from field for inbound messages", () => {
    const messages = [
      createMockMessage({
        direction: "inbound",
        participants: JSON.stringify({
          from: "+14155550100",
          to: ["+14155550101"],
        }),
      }),
    ];

    expect(extractPhoneFromThread(messages)).toBe("+14155550100");
  });

  it("should extract to field for outbound messages", () => {
    const messages = [
      createMockMessage({
        direction: "outbound",
        participants: JSON.stringify({
          from: "+14155550101",
          to: ["+14155550100"],
        }),
      }),
    ];

    expect(extractPhoneFromThread(messages)).toBe("+14155550100");
  });

  it("should fallback to sender field", () => {
    const messages = [
      createMockMessage({
        sender: "John Doe <john@example.com>",
      }),
    ];

    expect(extractPhoneFromThread(messages)).toBe(
      "John Doe <john@example.com>"
    );
  });

  it("should return Unknown when no identifiable info", () => {
    const messages = [createMockMessage()];
    expect(extractPhoneFromThread(messages)).toBe("Unknown");
  });

  it("should handle invalid JSON in participants", () => {
    const messages = [
      createMockMessage({
        participants: "invalid json",
        sender: "fallback@example.com",
      }),
    ];

    expect(extractPhoneFromThread(messages)).toBe("fallback@example.com");
  });

  it("should try multiple messages until phone found", () => {
    const messages = [
      createMockMessage({ id: "msg-1" }),
      createMockMessage({
        id: "msg-2",
        direction: "inbound",
        participants: JSON.stringify({
          from: "+14155550200",
          to: ["+14155550101"],
        }),
      }),
    ];

    expect(extractPhoneFromThread(messages)).toBe("+14155550200");
  });

  // BACKLOG-510/513: User identifier exclusion tests
  describe("user identifier exclusion (BACKLOG-510/513)", () => {
    it("should exclude user's outbound 'from' field when extracting phone", () => {
      // Scenario: User sends message (outbound), their phone is in 'from'
      // The function should identify the user's phone and exclude it
      // Then return the recipient (external phone) from 'to'
      const userPhone = "+14155550001"; // User's own phone number
      const externalPhone = "+14155550099"; // External contact

      const messages = [
        createMockMessage({
          id: "msg-1",
          direction: "outbound",
          participants: JSON.stringify({
            from: userPhone, // User's phone (should be excluded)
            to: [externalPhone], // External contact (should be returned)
            chat_members: [externalPhone], // Doesn't include user
          }),
        }),
      ];

      expect(extractPhoneFromThread(messages)).toBe(externalPhone);
    });

    it("should exclude user's inbound 'to' field when extracting phone", () => {
      // Scenario: User receives message (inbound), their phone is in 'to'
      // The function should identify the user's phone and exclude it
      // Then return the sender (external phone) from 'from'
      const userPhone = "+14155550001"; // User's own phone number
      const externalPhone = "+14155550088"; // External contact

      const messages = [
        createMockMessage({
          id: "msg-1",
          direction: "inbound",
          participants: JSON.stringify({
            from: externalPhone, // External contact (should be returned)
            to: [userPhone], // User's phone (should be excluded)
            chat_members: [externalPhone], // Doesn't include user
          }),
        }),
      ];

      expect(extractPhoneFromThread(messages)).toBe(externalPhone);
    });

    it("should use chat_members fallback when from/to are 'unknown'", () => {
      // Scenario: Messages have 'unknown' in from/to fields
      // Should fall back to chat_members array to find external phone
      const externalPhone = "+14155550077";

      const messages = [
        createMockMessage({
          id: "msg-1",
          direction: "inbound",
          participants: JSON.stringify({
            from: "unknown",
            to: ["unknown"],
            chat_members: [externalPhone], // Fallback source
          }),
        }),
      ];

      expect(extractPhoneFromThread(messages)).toBe(externalPhone);
    });

    it("should correctly identify user across mixed inbound/outbound messages", () => {
      // Scenario: Thread has both sent and received messages
      // User identification should work across the entire thread
      const userPhone = "+14155550001";
      const externalPhone = "+14155550066";

      const messages = [
        // Inbound message: external sends to user
        createMockMessage({
          id: "msg-1",
          direction: "inbound",
          participants: JSON.stringify({
            from: externalPhone,
            to: [userPhone],
            chat_members: [externalPhone],
          }),
        }),
        // Outbound message: user sends to external
        createMockMessage({
          id: "msg-2",
          direction: "outbound",
          participants: JSON.stringify({
            from: userPhone,
            to: [externalPhone],
            chat_members: [externalPhone],
          }),
        }),
      ];

      // Should return external phone, not user's phone
      expect(extractPhoneFromThread(messages)).toBe(externalPhone);
    });

    it("should not exclude valid external phones that happen to be in from field of inbound", () => {
      // Edge case: Don't over-exclude - inbound 'from' is external, should be returned
      const externalPhone = "+14155550055";
      const userPhone = "+14155550001";

      const messages = [
        createMockMessage({
          id: "msg-1",
          direction: "inbound",
          participants: JSON.stringify({
            from: externalPhone, // This is the external contact, NOT user
            to: [userPhone], // User's phone
            chat_members: [externalPhone],
          }),
        }),
      ];

      // External phone in 'from' of inbound should be returned
      expect(extractPhoneFromThread(messages)).toBe(externalPhone);
    });
  });
});

describe("sortThreadsByRecent", () => {
  const createMockMessage = (overrides: Partial<Communication> = {}): Communication => ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as Communication);

  it("should sort threads by most recent message first", () => {
    const threads = new Map<string, Communication[]>([
      [
        "thread-old",
        [
          createMockMessage({
            id: "old-msg",
            sent_at: "2024-01-15T10:00:00Z",
          }),
        ],
      ],
      [
        "thread-new",
        [
          createMockMessage({
            id: "new-msg",
            sent_at: "2024-01-17T10:00:00Z",
          }),
        ],
      ],
      [
        "thread-middle",
        [
          createMockMessage({
            id: "mid-msg",
            sent_at: "2024-01-16T10:00:00Z",
          }),
        ],
      ],
    ]);

    const sorted = sortThreadsByRecent(threads);

    expect(sorted[0][0]).toBe("thread-new");
    expect(sorted[1][0]).toBe("thread-middle");
    expect(sorted[2][0]).toBe("thread-old");
  });

  it("should use first message (newest) in thread for sorting", () => {
    // Messages within threads are sorted newest-first by groupMessagesByThread,
    // so msgs[0] is the newest message in each thread.
    const threads = new Map<string, Communication[]>([
      [
        "thread-A",
        [
          // Newest first (sorted by groupMessagesByThread)
          createMockMessage({ id: "a2", sent_at: "2024-01-15T11:00:00Z" }),
          createMockMessage({ id: "a1", sent_at: "2024-01-15T10:00:00Z" }),
        ],
      ],
      [
        "thread-B",
        [
          // Newest first (sorted by groupMessagesByThread)
          createMockMessage({ id: "b2", sent_at: "2024-01-15T12:00:00Z" }),
          createMockMessage({ id: "b1", sent_at: "2024-01-15T09:00:00Z" }),
        ],
      ],
    ]);

    const sorted = sortThreadsByRecent(threads);

    // thread-B has the most recent message (12:00 at index 0)
    expect(sorted[0][0]).toBe("thread-B");
    expect(sorted[1][0]).toBe("thread-A");
  });

  it("should sort by newest message, not oldest (BACKLOG-175 regression)", () => {
    // This test catches the specific bug: if sortThreadsByRecent used
    // msgs[msgs.length - 1] (oldest) instead of msgs[0] (newest),
    // the sort order would be wrong.
    //
    // Thread A: oldest=Jan 14, newest=Jan 16
    // Thread B: oldest=Jan 13, newest=Jan 17
    //
    // Correct (by newest): B first (Jan 17 > Jan 16)
    // Buggy (by oldest):   A first (Jan 14 > Jan 13)
    const threads = new Map<string, Communication[]>([
      [
        "thread-A",
        [
          // Newest first
          createMockMessage({ id: "a-new", sent_at: "2024-01-16T10:00:00Z" }),
          createMockMessage({ id: "a-old", sent_at: "2024-01-14T10:00:00Z" }),
        ],
      ],
      [
        "thread-B",
        [
          // Newest first
          createMockMessage({ id: "b-new", sent_at: "2024-01-17T10:00:00Z" }),
          createMockMessage({ id: "b-old", sent_at: "2024-01-13T10:00:00Z" }),
        ],
      ],
    ]);

    const sorted = sortThreadsByRecent(threads);

    // Thread B should be first because its newest message (Jan 17) is more recent
    expect(sorted[0][0]).toBe("thread-B");
    expect(sorted[1][0]).toBe("thread-A");
  });

  it("should handle empty threads map", () => {
    const threads = new Map<string, Communication[]>();
    const sorted = sortThreadsByRecent(threads);
    expect(sorted).toEqual([]);
  });

  it("should use received_at as fallback", () => {
    const threads = new Map<string, Communication[]>([
      [
        "thread-sent",
        [
          createMockMessage({
            id: "sent-msg",
            sent_at: "2024-01-15T10:00:00Z",
          }),
        ],
      ],
      [
        "thread-received",
        [
          createMockMessage({
            id: "received-msg",
            received_at: "2024-01-16T10:00:00Z",
          }),
        ],
      ],
    ]);

    const sorted = sortThreadsByRecent(threads);

    expect(sorted[0][0]).toBe("thread-received");
  });
});
