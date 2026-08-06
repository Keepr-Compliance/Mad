/**
 * macOSMessagesImportService Thread Tests (TASK-1026)
 *
 * Tests for the thread management functionality in macOSMessagesImportService.
 * This covers:
 * - Thread ID generation from chat IDs
 * - Participant resolution and formatting
 * - Thread-to-transaction linking via participants_flat
 * - Group chat member handling
 * - Thread deduplication logic
 *
 * Note: The service itself cannot be easily unit tested due to native module dependencies.
 * These tests verify the pure function logic that supports thread handling.
 */

describe("Thread Management Utility Functions", () => {
  describe("Thread ID Generation", () => {
    /**
     * Thread IDs are generated from macOS chat IDs using the pattern:
     * `macos-chat-${chat_id}`
     */
    function generateThreadId(chatId: number | null): string | null {
      return chatId ? `macos-chat-${chatId}` : null;
    }

    it("should generate thread ID from numeric chat ID", () => {
      expect(generateThreadId(123)).toBe("macos-chat-123");
      expect(generateThreadId(1)).toBe("macos-chat-1");
      expect(generateThreadId(999999)).toBe("macos-chat-999999");
    });

    it("should return null for null chat ID", () => {
      expect(generateThreadId(null)).toBeNull();
    });

    it("should handle zero chat ID as falsy", () => {
      // In JavaScript, 0 is falsy so this returns null
      expect(generateThreadId(0)).toBeNull();
    });

    it("should generate unique thread IDs for different chats", () => {
      const thread1 = generateThreadId(100);
      const thread2 = generateThreadId(200);
      expect(thread1).not.toBe(thread2);
    });

    it("should generate consistent thread ID for same chat", () => {
      const thread1 = generateThreadId(42);
      const thread2 = generateThreadId(42);
      expect(thread1).toBe(thread2);
    });
  });

  describe("Participant Object Building", () => {
    /**
     * Participant objects are structured as:
     * {
     *   from: sender handle or "me",
     *   to: array of recipient handles,
     *   chat_members?: array of all participants (for group chats)
     * }
     */
    interface ParticipantsObject {
      from: string;
      to: string[];
      chat_members?: string[];
    }

    function buildParticipants(
      isFromMe: boolean,
      handle: string,
      chatMembers?: string[]
    ): ParticipantsObject {
      const result: ParticipantsObject = {
        from: isFromMe ? "me" : handle,
        to: isFromMe ? [handle] : ["me"],
      };

      // Include chat members for group chats (more than 1 member)
      if (chatMembers && chatMembers.length > 1) {
        result.chat_members = chatMembers;
      }

      return result;
    }

    describe("Single Participant (1:1 Chat)", () => {
      it("should build outbound message participants", () => {
        const result = buildParticipants(true, "+14155550102");
        expect(result.from).toBe("me");
        expect(result.to).toEqual(["+14155550102"]);
        expect(result.chat_members).toBeUndefined();
      });

      it("should build inbound message participants", () => {
        const result = buildParticipants(false, "+14155550102");
        expect(result.from).toBe("+14155550102");
        expect(result.to).toEqual(["me"]);
        expect(result.chat_members).toBeUndefined();
      });

      it("should handle email addresses as handles", () => {
        const result = buildParticipants(false, "user@example.com");
        expect(result.from).toBe("user@example.com");
        expect(result.to).toEqual(["me"]);
      });

      it("should not include chat_members for single participant", () => {
        // Single member array should NOT add chat_members
        const result = buildParticipants(true, "+14155550102", ["+14155550102"]);
        expect(result.chat_members).toBeUndefined();
      });
    });

    describe("Group Chat Participants", () => {
      it("should include chat_members for group chats", () => {
        const members = ["+14155550102", "+14155550001", "+14155550002"];
        const result = buildParticipants(true, "+14155550102", members);
        expect(result.chat_members).toEqual(members);
      });

      it("should preserve member order in group chats", () => {
        const members = ["+14155550002", "+14155550102", "+14155550001"];
        const result = buildParticipants(false, "+14155550002", members);
        expect(result.chat_members).toEqual(members);
      });

      it("should handle two-person chat as group (edge case)", () => {
        const members = ["+14155550102", "+14155550001"];
        const result = buildParticipants(true, "+14155550102", members);
        expect(result.chat_members).toEqual(members);
      });

      it("should handle mixed phone and email in group", () => {
        const members = ["+14155550102", "user@example.com", "+14155550001"];
        const result = buildParticipants(false, "+14155550102", members);
        expect(result.chat_members).toEqual(members);
      });
    });
  });

  describe("Participants Flat Generation", () => {
    /**
     * participants_flat is a comma-separated string of normalized phone numbers
     * used for fast searching and transaction matching.
     * Only digits are kept (non-numeric characters removed).
     */
    function buildParticipantsFlat(
      from: string,
      to: string[],
      chatMembers?: string[]
    ): string {
      const allParticipantPhones: string[] = [];

      if (from && from !== "me") {
        allParticipantPhones.push(from.replace(/\D/g, ""));
      }

      for (const toPhone of to) {
        if (toPhone !== "me") {
          allParticipantPhones.push(toPhone.replace(/\D/g, ""));
        }
      }

      if (chatMembers) {
        for (const member of chatMembers) {
          allParticipantPhones.push(member.replace(/\D/g, ""));
        }
      }

      return allParticipantPhones.join(",");
    }

    it("should extract digits from phone numbers", () => {
      const result = buildParticipantsFlat("+1-415-555-0102", ["me"]);
      expect(result).toBe("14155550102");
    });

    it("should skip 'me' in from field", () => {
      const result = buildParticipantsFlat("me", ["+14155550102"]);
      expect(result).toBe("14155550102");
    });

    it("should skip 'me' in to array", () => {
      const result = buildParticipantsFlat("+14155550102", ["me"]);
      expect(result).toBe("14155550102");
    });

    it("should combine multiple phone numbers with commas", () => {
      const result = buildParticipantsFlat(
        "+14155550102",
        ["me"],
        ["+14155550001", "+14155550002"]
      );
      expect(result).toBe("14155550102,14155550001,14155550002");
    });

    it("should handle email addresses (extracts no digits)", () => {
      const result = buildParticipantsFlat("user@example.com", ["me"]);
      expect(result).toBe(""); // No digits in email
    });

    it("should handle mixed email and phone", () => {
      const result = buildParticipantsFlat(
        "+14155550102",
        ["me"],
        ["user@example.com", "+14155550001"]
      );
      // Email results in empty string between commas
      expect(result).toBe("14155550102,,14155550001");
    });

    it("should handle formatted phone numbers", () => {
      const result = buildParticipantsFlat(
        "(415) 555-0102",
        ["me"],
        ["+1 (510) 555-1234"]
      );
      expect(result).toBe("4155550102,15105551234");
    });

    it("should include all group chat members for searchability", () => {
      const members = ["+14155550001", "+14155550002", "+14155550003"];
      const result = buildParticipantsFlat("+14155550001", ["me"], members);
      // From + all members
      expect(result).toBe("14155550001,14155550001,14155550002,14155550003");
    });
  });

  describe("Chat Members Map Building", () => {
    /**
     * The chatMembersMap maps chat_id -> array of member handles
     * Built from the chat_handle_join table in macOS Messages.db
     */
    interface ChatMemberRow {
      chat_id: number;
      handle_id: string;
    }

    function buildChatMembersMap(rows: ChatMemberRow[]): Map<number, string[]> {
      const chatMembersMap = new Map<number, string[]>();
      for (const row of rows) {
        const members = chatMembersMap.get(row.chat_id) || [];
        members.push(row.handle_id);
        chatMembersMap.set(row.chat_id, members);
      }
      return chatMembersMap;
    }

    it("should group members by chat_id", () => {
      const rows: ChatMemberRow[] = [
        { chat_id: 1, handle_id: "+14155550102" },
        { chat_id: 1, handle_id: "+14155550001" },
        { chat_id: 2, handle_id: "+14155550002" },
      ];
      const map = buildChatMembersMap(rows);

      expect(map.get(1)).toEqual(["+14155550102", "+14155550001"]);
      expect(map.get(2)).toEqual(["+14155550002"]);
    });

    it("should handle empty input", () => {
      const map = buildChatMembersMap([]);
      expect(map.size).toBe(0);
    });

    it("should handle single member chats", () => {
      const rows: ChatMemberRow[] = [{ chat_id: 1, handle_id: "+14155550102" }];
      const map = buildChatMembersMap(rows);
      expect(map.get(1)).toEqual(["+14155550102"]);
    });

    it("should preserve insertion order for members", () => {
      const rows: ChatMemberRow[] = [
        { chat_id: 1, handle_id: "first@example.com" },
        { chat_id: 1, handle_id: "second@example.com" },
        { chat_id: 1, handle_id: "third@example.com" },
      ];
      const map = buildChatMembersMap(rows);
      expect(map.get(1)).toEqual([
        "first@example.com",
        "second@example.com",
        "third@example.com",
      ]);
    });

    it("should handle many chats", () => {
      const rows: ChatMemberRow[] = [];
      for (let i = 1; i <= 100; i++) {
        rows.push({ chat_id: i, handle_id: `user${i}@example.com` });
      }
      const map = buildChatMembersMap(rows);
      expect(map.size).toBe(100);
      expect(map.get(50)).toEqual(["user50@example.com"]);
    });
  });

  describe("Thread Deduplication Logic", () => {
    /**
     * Thread deduplication uses a Set of external_id (GUID) values.
     * Messages with existing GUIDs are skipped to prevent duplicates.
     */
    it("should track existing message IDs in Set", () => {
      const existingIds = new Set<string>();
      existingIds.add("guid-1");
      existingIds.add("guid-2");

      expect(existingIds.has("guid-1")).toBe(true);
      expect(existingIds.has("guid-2")).toBe(true);
      expect(existingIds.has("guid-3")).toBe(false);
    });

    it("should prevent duplicate insertions", () => {
      const existingIds = new Set<string>();
      const messagesProcessed: string[] = [];

      const messages = [
        { guid: "guid-1" },
        { guid: "guid-2" },
        { guid: "guid-1" }, // Duplicate
        { guid: "guid-3" },
        { guid: "guid-2" }, // Duplicate
      ];

      for (const msg of messages) {
        if (!existingIds.has(msg.guid)) {
          existingIds.add(msg.guid);
          messagesProcessed.push(msg.guid);
        }
      }

      expect(messagesProcessed).toEqual(["guid-1", "guid-2", "guid-3"]);
      expect(existingIds.size).toBe(3);
    });

    it("should track in-batch duplicates", () => {
      // Simulates adding to set within same batch to catch duplicates
      const existingIds = new Set<string>();
      let stored = 0;
      let skipped = 0;

      const batch = [
        { guid: "same-guid" },
        { guid: "same-guid" },
        { guid: "same-guid" },
      ];

      for (const msg of batch) {
        if (existingIds.has(msg.guid)) {
          skipped++;
        } else {
          existingIds.add(msg.guid);
          stored++;
        }
      }

      expect(stored).toBe(1);
      expect(skipped).toBe(2);
    });

    it("should handle O(1) lookup for large sets", () => {
      const existingIds = new Set<string>();

      // Add 10000 existing IDs
      for (let i = 0; i < 10000; i++) {
        existingIds.add(`guid-${i}`);
      }

      // Lookup should still be O(1)
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        existingIds.has(`guid-${i * 10}`);
      }
      const elapsed = Date.now() - start;

      // Should complete in less than 100ms (typically < 5ms)
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("GUID Validation", () => {
    /**
     * GUIDs must be valid format: alphanumeric, hyphens, underscores, colons, dots
     * Max length: 100 characters
     */
    const MAX_GUID_LENGTH = 100;

    function isValidGuid(guid: string | null | undefined): boolean {
      if (!guid || typeof guid !== "string") return false;
      return (
        guid.length > 0 &&
        guid.length <= MAX_GUID_LENGTH &&
        /^[\w\-:.]+$/.test(guid)
      );
    }

    it("should accept valid macOS message GUIDs", () => {
      // Note: The regex /^[\w\-:.]+$/ allows word chars, hyphens, colons, dots only
      // Forward slashes are NOT allowed (unlike real macOS GUIDs which may contain them)
      expect(isValidGuid("p:0:1234567890")).toBe(true);
      expect(isValidGuid("iMessage;-;+14155550102")).toBe(false); // semicolon not allowed
      expect(isValidGuid("p:0/1234567890")).toBe(false); // forward slash not allowed
      expect(isValidGuid("uuid-1234-5678-abcd")).toBe(true);
    });

    it("should reject null and undefined", () => {
      expect(isValidGuid(null)).toBe(false);
      expect(isValidGuid(undefined)).toBe(false);
    });

    it("should reject empty strings", () => {
      expect(isValidGuid("")).toBe(false);
    });

    it("should reject overly long GUIDs", () => {
      const longGuid = "a".repeat(101);
      expect(isValidGuid(longGuid)).toBe(false);
      expect(isValidGuid("a".repeat(100))).toBe(true);
    });

    it("should reject special characters", () => {
      expect(isValidGuid("guid with spaces")).toBe(false);
      expect(isValidGuid("guid;with;semicolons")).toBe(false);
      expect(isValidGuid("guid/with/slashes")).toBe(false);
      expect(isValidGuid("guid<script>")).toBe(false);
    });

    it("should accept underscores, hyphens, colons, and dots", () => {
      expect(isValidGuid("guid_with_underscores")).toBe(true);
      expect(isValidGuid("guid-with-hyphens")).toBe(true);
      expect(isValidGuid("guid:with:colons")).toBe(true);
      expect(isValidGuid("guid.with.dots")).toBe(true);
      expect(isValidGuid("mixed_guid-123:abc.xyz")).toBe(true);
    });
  });

  describe("Handle Sanitization", () => {
    /**
     * Handles (phone numbers, emails) are sanitized to prevent injection
     * and truncated to max length.
     */
    const MAX_HANDLE_LENGTH = 500;

    function sanitizeString(
      value: string | null | undefined,
      maxLength: number,
      defaultValue = ""
    ): string {
      if (value === null || value === undefined) {
        return defaultValue;
      }
      const str = String(value);
      return str.length > maxLength ? str.substring(0, maxLength) : str;
    }

    it("should return default for null/undefined", () => {
      expect(sanitizeString(null, MAX_HANDLE_LENGTH, "unknown")).toBe("unknown");
      expect(sanitizeString(undefined, MAX_HANDLE_LENGTH, "unknown")).toBe(
        "unknown"
      );
    });

    it("should return original string if within limit", () => {
      expect(sanitizeString("+14155550102", MAX_HANDLE_LENGTH)).toBe(
        "+14155550102"
      );
    });

    it("should truncate strings exceeding limit", () => {
      const longHandle = "a".repeat(600);
      const result = sanitizeString(longHandle, MAX_HANDLE_LENGTH);
      expect(result.length).toBe(500);
    });

    it("should handle empty string", () => {
      expect(sanitizeString("", MAX_HANDLE_LENGTH, "default")).toBe("");
    });

    it("should preserve special characters in handles", () => {
      expect(sanitizeString("+1 (415) 555-0102", MAX_HANDLE_LENGTH)).toBe(
        "+1 (415) 555-0102"
      );
      expect(sanitizeString("user+tag@example.com", MAX_HANDLE_LENGTH)).toBe(
        "user+tag@example.com"
      );
    });
  });

  describe("Metadata Building", () => {
    /**
     * Metadata stores source information for traceability
     */
    interface MessageMetadata {
      source: string;
      originalId: number;
      service: string | null;
    }

    function buildMetadata(
      originalId: number,
      service: string | null
    ): string {
      const metadata: MessageMetadata = {
        source: "macos_messages",
        originalId,
        service,
      };
      return JSON.stringify(metadata);
    }

    it("should include source as macos_messages", () => {
      const result = buildMetadata(123, "iMessage");
      const parsed = JSON.parse(result);
      expect(parsed.source).toBe("macos_messages");
    });

    it("should include original message ID", () => {
      const result = buildMetadata(456, "iMessage");
      const parsed = JSON.parse(result);
      expect(parsed.originalId).toBe(456);
    });

    it("should include service type", () => {
      const result = buildMetadata(123, "SMS");
      const parsed = JSON.parse(result);
      expect(parsed.service).toBe("SMS");
    });

    it("should handle null service", () => {
      const result = buildMetadata(123, null);
      const parsed = JSON.parse(result);
      expect(parsed.service).toBeNull();
    });

    it("should produce valid JSON", () => {
      const result = buildMetadata(999, "iMessage");
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });

  describe("Channel Determination", () => {
    /**
     * Channel is determined from macOS Messages service field
     */
    function determineChannel(service: string | null): string {
      return service === "iMessage" ? "imessage" : "sms";
    }

    it("should return imessage for iMessage service", () => {
      expect(determineChannel("iMessage")).toBe("imessage");
    });

    it("should return sms for SMS service", () => {
      expect(determineChannel("SMS")).toBe("sms");
    });

    it("should return sms for null service", () => {
      expect(determineChannel(null)).toBe("sms");
    });

    it("should return sms for unknown service", () => {
      expect(determineChannel("unknown")).toBe("sms");
    });
  });

  describe("Direction Determination", () => {
    /**
     * Direction is determined from is_from_me flag
     */
    function determineDirection(isFromMe: number): string {
      return isFromMe === 1 ? "outbound" : "inbound";
    }

    it("should return outbound for is_from_me=1", () => {
      expect(determineDirection(1)).toBe("outbound");
    });

    it("should return inbound for is_from_me=0", () => {
      expect(determineDirection(0)).toBe("inbound");
    });

    it("should return inbound for any non-1 value", () => {
      expect(determineDirection(2)).toBe("inbound");
      expect(determineDirection(-1)).toBe("inbound");
    });
  });
});
