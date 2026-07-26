/**
 * Tests for threadMergeUtils
 * TASK-2025: Verifies display-layer thread merging for same-contact threads.
 */

import {
  mergeThreadsByContact,
  getContactMergeKey,
  getHandleMergeKey,
  mergeItemsByKey,
} from "../threadMergeUtils";
import type { MessageLike } from "../../components/transactionDetailsModule/components/MessageThreadCard";
import type { Communication } from "@/types";

/**
 * Helper to create a mock message
 */
function createMessage(overrides: Partial<Communication>): MessageLike {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    user_id: "user-1",
    channel: "sms",
    body_text: "Test message",
    sent_at: "2024-01-15T10:00:00Z",
    direction: "inbound",
    thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as MessageLike;
}

describe("mergeThreadsByContact", () => {
  describe("basic merging", () => {
    it("should merge threads from the same contact (same phone, different service)", () => {
      // Thread 1: SMS from +14155550100
      const smsMessages = [
        createMessage({
          id: "sms-1",
          thread_id: "macos-chat-1",
          channel: "sms",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      // Thread 2: iMessage from +14155550100
      const imessageMessages = [
        createMessage({
          id: "imsg-1",
          thread_id: "macos-chat-2",
          channel: "imessage",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", smsMessages],
        ["macos-chat-2", imessageMessages],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      // Should produce one merged thread
      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(2); // 2 messages combined
      expect(result[0][2]).toEqual(["macos-chat-1", "macos-chat-2"]); // Both original IDs
    });

    it("should merge threads from same contact via phone and iCloud email", () => {
      // Thread 1: SMS from phone number
      const phoneMessages = [
        createMessage({
          id: "phone-1",
          thread_id: "macos-chat-1",
          channel: "sms",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      // Thread 2: iMessage from iCloud email
      const emailMessages = [
        createMessage({
          id: "email-1",
          thread_id: "macos-chat-3",
          channel: "imessage",
          sent_at: "2024-01-17T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "madison@icloud.com", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", phoneMessages],
        ["macos-chat-3", emailMessages],
      ];

      // Both phone and email resolve to same contact
      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
        "madison@icloud.com": "Madison Jones",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      // Should produce one merged thread
      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(2);
      expect(result[0][2]).toEqual(["macos-chat-1", "macos-chat-3"]);
    });

    it("should NOT merge threads from different contacts", () => {
      const thread1 = [
        createMessage({
          id: "msg-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const thread2 = [
        createMessage({
          id: "msg-2",
          thread_id: "macos-chat-2",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550200", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", thread1],
        ["macos-chat-2", thread2],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
        "+14155550200": "Jane Smith",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      // Should produce two separate threads
      expect(result).toHaveLength(2);
    });
  });

  describe("group chat exclusion", () => {
    it("should NOT merge group chats", () => {
      const groupMessages = [
        createMessage({
          id: "group-1",
          thread_id: "macos-chat-group",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({
            from: "+14155550100",
            to: ["me"],
            chat_members: ["+14155550100", "+14155550200"],
          }),
        }),
      ];

      const singleMessages = [
        createMessage({
          id: "single-1",
          thread_id: "macos-chat-single",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-group", groupMessages],
        ["macos-chat-single", singleMessages],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
        "+14155550200": "Jane Smith",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      // Group chat should remain separate, single thread stays as-is
      expect(result).toHaveLength(2);
    });
  });

  describe("chronological ordering", () => {
    it("should sort merged messages by date (newest first)", () => {
      const smsMessages = [
        createMessage({
          id: "sms-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
        createMessage({
          id: "sms-2",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-17T10:00:00Z",
          direction: "outbound",
          participants: JSON.stringify({ from: "me", to: ["+14155550100"] }),
        }),
      ];

      const imessageMessages = [
        createMessage({
          id: "imsg-1",
          thread_id: "macos-chat-2",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", smsMessages],
        ["macos-chat-2", imessageMessages],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(3);

      // Messages should be sorted newest first
      const dates = result[0][1].map((m) => m.sent_at);
      expect(dates).toEqual([
        "2024-01-17T10:00:00Z",
        "2024-01-16T10:00:00Z",
        "2024-01-15T10:00:00Z",
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty thread list", () => {
      const result = mergeThreadsByContact([], {});
      expect(result).toHaveLength(0);
    });

    it("should handle threads with no contact name resolution", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", messages],
      ];

      // No contact names -- should still produce output (unmerged)
      const result = mergeThreadsByContact(threads, {});

      expect(result).toHaveLength(1);
      expect(result[0][2]).toEqual(["macos-chat-1"]);
    });

    it("should merge by normalized phone when no contact name exists", () => {
      // Same phone number, different formats
      const thread1 = [
        createMessage({
          id: "msg-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const thread2 = [
        createMessage({
          id: "msg-2",
          thread_id: "macos-chat-2",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "4155550100", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", thread1],
        ["macos-chat-2", thread2],
      ];

      // No contact names -- but same normalized phone
      const result = mergeThreadsByContact(threads, {});

      // Should merge because the normalized phone numbers match
      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(2);
    });

    it("should leave single-thread contacts unaffected", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
        createMessage({
          id: "msg-2",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "outbound",
          participants: JSON.stringify({ from: "me", to: ["+14155550100"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", messages],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(2);
      expect(result[0][2]).toEqual(["macos-chat-1"]); // Only one original ID
    });

    it("should correctly handle email-handle threads without contact names", () => {
      // With the bug, normalizePhone("madison@icloud.com") returns "" (empty)
      // which would cause all email-handle threads to merge incorrectly.
      // With the fix, email handles are preserved as-is (lowercased).
      const emailThread1 = [
        createMessage({
          id: "email-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "madison@icloud.com", to: ["me"] }),
        }),
      ];

      const emailThread2 = [
        createMessage({
          id: "email-2",
          thread_id: "macos-chat-2",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "jane@gmail.com", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", emailThread1],
        ["macos-chat-2", emailThread2],
      ];

      // No contact names -- relies on normalizePhone for merge key
      const result = mergeThreadsByContact(threads, {});

      // Should remain as 2 separate threads (different email handles)
      expect(result).toHaveLength(2);
    });

    it("should merge email-handle threads from the same email (case-insensitive)", () => {
      const emailThread1 = [
        createMessage({
          id: "email-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "Madison@iCloud.com", to: ["me"] }),
        }),
      ];

      const emailThread2 = [
        createMessage({
          id: "email-2",
          thread_id: "macos-chat-2",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "madison@icloud.com", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", emailThread1],
        ["macos-chat-2", emailThread2],
      ];

      // No contact names -- should merge via handle: key (lowercased email)
      const result = mergeThreadsByContact(threads, {});

      // Should merge into 1 thread (same email after lowercasing)
      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(2);
    });

    it("should handle messages without participants gracefully", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          thread_id: "macos-chat-1",
          sent_at: "2024-01-15T10:00:00Z",
          participants: undefined,
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", messages],
      ];

      // Should not crash, thread should pass through unmergeable
      const result = mergeThreadsByContact(threads, {});
      expect(result).toHaveLength(1);
    });

    // BACKLOG-2263: the founder's exact repro — one contact, four raw threads
    // across mixed +1 / bare-phone / iCloud-email handles → ONE merged entry.
    it("should merge FOUR threads for one contact across +1/bare/email handles", () => {
      const mk = (id: string, from: string, chat: string, when: string): MessageLike[] => [
        createMessage({
          id,
          thread_id: chat,
          channel: from.includes("@") ? "imessage" : "sms",
          sent_at: when,
          direction: "inbound",
          participants: JSON.stringify({ from, to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["chat-sms-plus1", mk("m1", "+14155550100", "chat-sms-plus1", "2024-01-15T10:00:00Z")],
        ["chat-imsg-plus1", mk("m2", "+14155550100", "chat-imsg-plus1", "2024-01-16T10:00:00Z")],
        ["chat-sms-bare", mk("m3", "4155550100", "chat-sms-bare", "2024-01-17T10:00:00Z")],
        ["chat-imsg-email", mk("m4", "romina@icloud.com", "chat-imsg-email", "2024-01-18T10:00:00Z")],
      ];

      // Contact record maps the +1 phone and the email to the same person; the
      // bare phone resolves via normalized-phone equality.
      const contactNames: Record<string, string> = {
        "+14155550100": "Romina",
        "romina@icloud.com": "Romina",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(4); // all 4 messages combined
      // Exact-identity: all four original thread ids present (order-independent).
      expect([...result[0][2]].sort()).toEqual(
        ["chat-imsg-email", "chat-imsg-plus1", "chat-sms-bare", "chat-sms-plus1"].sort()
      );
    });

    it("should merge three threads from the same contact", () => {
      const smsThread = [
        createMessage({
          id: "sms-1",
          thread_id: "macos-chat-1",
          channel: "sms",
          sent_at: "2024-01-15T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const imessagePhoneThread = [
        createMessage({
          id: "imsg-1",
          thread_id: "macos-chat-2",
          channel: "imessage",
          sent_at: "2024-01-16T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
        }),
      ];

      const imessageEmailThread = [
        createMessage({
          id: "imsg-email-1",
          thread_id: "macos-chat-3",
          channel: "imessage",
          sent_at: "2024-01-17T10:00:00Z",
          direction: "inbound",
          participants: JSON.stringify({ from: "madison@icloud.com", to: ["me"] }),
        }),
      ];

      const threads: [string, MessageLike[]][] = [
        ["macos-chat-1", smsThread],
        ["macos-chat-2", imessagePhoneThread],
        ["macos-chat-3", imessageEmailThread],
      ];

      const contactNames: Record<string, string> = {
        "+14155550100": "Madison Jones",
        "madison@icloud.com": "Madison Jones",
      };

      const result = mergeThreadsByContact(threads, contactNames);

      // All three should merge into one
      expect(result).toHaveLength(1);
      expect(result[0][1]).toHaveLength(3);
      expect(result[0][2]).toEqual(["macos-chat-1", "macos-chat-2", "macos-chat-3"]);
    });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-2263: the identity helpers that every conversation surface shares.
// ---------------------------------------------------------------------------

describe("getHandleMergeKey", () => {
  it("keys a resolved handle by contact name (case-insensitive)", () => {
    expect(getHandleMergeKey("+14155550100", { "+14155550100": "Romina" })).toBe("contact:romina");
  });

  it("resolves a bare phone to the same name via normalized-phone equality", () => {
    // Different string format, same underlying number → same identity key.
    expect(getHandleMergeKey("4155550100", { "+14155550100": "Romina" })).toBe("contact:romina");
  });

  it("resolves an email handle to the contact name (case-insensitive)", () => {
    expect(getHandleMergeKey("Romina@iCloud.com", { "romina@icloud.com": "Romina" })).toBe(
      "contact:romina"
    );
  });

  it("falls back to a normalized phone key when no name is known", () => {
    expect(getHandleMergeKey("+1 (415) 555-0100", {})).toBe("phone:4155550100");
    // Two different formats of the same number produce the SAME key.
    expect(getHandleMergeKey("4155550100", {})).toBe("phone:4155550100");
  });

  it("falls back to a lowercased handle key for unknown emails", () => {
    expect(getHandleMergeKey("Romina@iCloud.com", {})).toBe("handle:romina@icloud.com");
  });
});

describe("getContactMergeKey", () => {
  const oneToOne: MessageLike[] = [
    {
      id: "x1",
      thread_id: "t1",
      direction: "inbound",
      participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
    } as MessageLike,
  ];
  const group: MessageLike[] = [
    {
      id: "g1",
      thread_id: "tg",
      direction: "inbound",
      participants: JSON.stringify({
        from: "+14155550100",
        to: ["me"],
        chat_members: ["+14155550100", "+14155550200"],
      }),
    } as MessageLike,
  ];

  it("returns a non-null identity key for a 1:1 thread", () => {
    expect(getContactMergeKey(oneToOne, { "+14155550100": "Romina" })).toBe("contact:romina");
  });

  it("returns null for a real group chat (2+ distinct people)", () => {
    expect(
      getContactMergeKey(group, { "+14155550100": "Romina", "+14155550200": "Alex" })
    ).toBeNull();
  });
});

describe("mergeItemsByKey", () => {
  interface Item {
    id: string;
    key: string | null;
    ids: string[];
  }
  const combine = (a: Item, b: Item): Item => ({ ...a, ids: [...a.ids, ...b.ids] });

  it("merges items sharing a key and preserves first-seen order", () => {
    const items: Item[] = [
      { id: "a", key: "k1", ids: ["a"] },
      { id: "b", key: "k2", ids: ["b"] },
      { id: "c", key: "k1", ids: ["c"] },
    ];
    const merged = mergeItemsByKey(items, (i) => i.key, combine);
    expect(merged).toHaveLength(2);
    expect(merged[0].ids).toEqual(["a", "c"]); // k1 folded, first-seen order kept
    expect(merged[1].ids).toEqual(["b"]);
  });

  it("never merges null-keyed items (group chats) and appends them after merged groups", () => {
    const items: Item[] = [
      { id: "g1", key: null, ids: ["g1"] },
      { id: "a", key: "k1", ids: ["a"] },
      { id: "g2", key: null, ids: ["g2"] },
      { id: "c", key: "k1", ids: ["c"] },
    ];
    const merged = mergeItemsByKey(items, (i) => i.key, combine);
    // One merged k1 group + two untouched null-keyed items.
    expect(merged).toHaveLength(3);
    expect(merged[0].ids).toEqual(["a", "c"]);
    expect(merged.filter((m) => m.key === null).map((m) => m.id)).toEqual(["g1", "g2"]);
  });
});
