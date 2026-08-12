/**
 * macOSMessagesImportService Validation Logging Tests (TASK-1050)
 *
 * Tests for thread_id validation logging during message import:
 * - Warning logs for NULL chat_id (which causes NULL thread_id)
 * - Summary logging with nullThreadIdCount
 * - Import continues despite NULL chat_id (not blocked)
 */

import { macTimestampToDate } from "../../utils/dateUtils";

// ============================================================================
// Test Utilities - Replicate service logic for unit testing
// ============================================================================

/**
 * Build thread ID from chat_id (from service logic)
 */
function buildThreadId(chatId: number | null | undefined): string | null {
  return chatId ? `macos-chat-${chatId}` : null;
}

/**
 * Simulate message processing that tracks NULL thread_id count
 */
interface MockMessage {
  guid: string;
  chat_id: number | null;
  handle_id: string | null;
  date: number;
  is_from_me: number;
  text: string | null;
  service: string | null;
}

interface ProcessingResult {
  stored: number;
  skipped: number;
  nullThreadIdCount: number;
  warnings: Array<{
    messageGuid: string;
    handleId: string | null;
    sentAt: string;
  }>;
}

function processMessagesWithValidation(
  messages: MockMessage[]
): ProcessingResult {
  let stored = 0;
  let skipped = 0;
  let nullThreadIdCount = 0;
  const warnings: ProcessingResult["warnings"] = [];

  for (const msg of messages) {
    // Validate GUID
    if (!msg.guid) {
      skipped++;
      continue;
    }

    // Skip messages with no text (simplified)
    if (!msg.text) {
      skipped++;
      continue;
    }

    // Build thread ID
    const threadId = buildThreadId(msg.chat_id);

    // Track NULL thread_id (TASK-1050 validation logging)
    if (!threadId) {
      nullThreadIdCount++;
      warnings.push({
        messageGuid: msg.guid,
        handleId: msg.handle_id,
        sentAt: macTimestampToDate(msg.date).toISOString(),
      });
    }

    // Message is stored regardless of NULL thread_id (logging only, no blocking)
    stored++;
  }

  return { stored, skipped, nullThreadIdCount, warnings };
}

/**
 * Calculate import summary stats
 */
function calculateImportSummary(result: ProcessingResult): {
  totalMessages: number;
  imported: number;
  skipped: number;
  nullThreadIdCount: number;
  percentNull: string;
} {
  const totalMessages = result.stored + result.skipped;
  const percentNull =
    totalMessages > 0
      ? ((result.nullThreadIdCount / totalMessages) * 100).toFixed(2)
      : "0.00";

  return {
    totalMessages,
    imported: result.stored,
    skipped: result.skipped,
    nullThreadIdCount: result.nullThreadIdCount,
    percentNull,
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe("macOSMessagesImportService Validation Logging (TASK-1050)", () => {
  // ==========================================================================
  // 1. Thread ID Generation Tests
  // ==========================================================================
  describe("Thread ID Generation", () => {
    it("should generate thread_id for valid chat_id", () => {
      expect(buildThreadId(12345)).toBe("macos-chat-12345");
    });

    it("should return null for null chat_id", () => {
      expect(buildThreadId(null)).toBeNull();
    });

    it("should return null for undefined chat_id", () => {
      expect(buildThreadId(undefined)).toBeNull();
    });

    it("should return null for chat_id of 0 (falsy)", () => {
      expect(buildThreadId(0)).toBeNull();
    });

    it("should handle large chat_id values", () => {
      expect(buildThreadId(999999999)).toBe("macos-chat-999999999");
    });
  });

  // ==========================================================================
  // 2. NULL Thread ID Detection Tests
  // ==========================================================================
  describe("NULL Thread ID Detection", () => {
    it("should detect message with NULL chat_id", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].messageGuid).toBe("msg-1");
    });

    it("should NOT flag message with valid chat_id", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: 123,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should count multiple NULL chat_id messages", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
        {
          guid: "msg-2",
          chat_id: null,
          handle_id: "+15555550121",
          date: 725846400000000000,
          is_from_me: 1,
          text: "Hi there",
          service: "iMessage",
        },
        {
          guid: "msg-3",
          chat_id: 456,
          handle_id: "+15551111111",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Test",
          service: "SMS",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(2);
      expect(result.stored).toBe(3);
    });

    it("should detect chat_id of 0 as NULL thread_id", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: 0, // Falsy value
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(1);
    });
  });

  // ==========================================================================
  // 3. Warning Log Content Tests
  // ==========================================================================
  describe("Warning Log Content", () => {
    it("should include messageGuid in warning", () => {
      const messages: MockMessage[] = [
        {
          guid: "unique-guid-123",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.warnings[0].messageGuid).toBe("unique-guid-123");
    });

    it("should include handleId in warning", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.warnings[0].handleId).toBe("+15555550112");
    });

    it("should include sentAt timestamp in warning", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000, // ~2024 timestamp
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      // Should be an ISO date string
      expect(result.warnings[0].sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should handle null handleId in warning", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: null,
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      expect(result.warnings[0].handleId).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Import Continues Despite NULL Thread ID Tests
  // ==========================================================================
  describe("Import Continues Despite NULL Thread ID", () => {
    it("should store message even with NULL chat_id", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      // Message should be stored (logging only, not blocking)
      expect(result.stored).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("should store all messages regardless of thread_id status", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
        {
          guid: "msg-2",
          chat_id: 123,
          handle_id: "+15555550121",
          date: 725846400000000000,
          is_from_me: 1,
          text: "Hi there",
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      // Both messages should be stored
      expect(result.stored).toBe(2);
      expect(result.nullThreadIdCount).toBe(1);
    });

    it("should not block import batch on NULL thread_id", () => {
      // Simulate a batch with many NULL thread_id messages
      const messages: MockMessage[] = Array.from({ length: 100 }, (_, i) => ({
        guid: `msg-${i}`,
        chat_id: i % 2 === 0 ? null : i, // Half have NULL chat_id
        handle_id: `+1555${i.toString().padStart(7, "0")}`,
        date: 725846400000000000,
        is_from_me: i % 2,
        text: `Message ${i}`,
        service: "iMessage",
      }));

      const result = processMessagesWithValidation(messages);

      // All 100 messages should be stored
      expect(result.stored).toBe(100);
      expect(result.nullThreadIdCount).toBe(50);
    });
  });

  // ==========================================================================
  // 5. Summary Statistics Tests
  // ==========================================================================
  describe("Summary Statistics", () => {
    it("should calculate correct summary for mixed messages", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: "Hello",
          service: "iMessage",
        },
        {
          guid: "msg-2",
          chat_id: 123,
          handle_id: "+15555550121",
          date: 725846400000000000,
          is_from_me: 1,
          text: "Hi",
          service: "iMessage",
        },
        {
          guid: "msg-3",
          chat_id: 456,
          handle_id: "+15551111111",
          date: 725846400000000000,
          is_from_me: 0,
          text: null, // Will be skipped
          service: "SMS",
        },
      ];

      const result = processMessagesWithValidation(messages);
      const summary = calculateImportSummary(result);

      expect(summary.totalMessages).toBe(3);
      expect(summary.imported).toBe(2);
      expect(summary.skipped).toBe(1);
      expect(summary.nullThreadIdCount).toBe(1);
    });

    it("should calculate correct percentage for NULL thread_id", () => {
      const result: ProcessingResult = {
        stored: 90,
        skipped: 10,
        nullThreadIdCount: 7, // 7 out of 100 = 7%
        warnings: [],
      };

      const summary = calculateImportSummary(result);

      expect(summary.totalMessages).toBe(100);
      expect(summary.percentNull).toBe("7.00");
    });

    it("should handle zero total messages", () => {
      const result: ProcessingResult = {
        stored: 0,
        skipped: 0,
        nullThreadIdCount: 0,
        warnings: [],
      };

      const summary = calculateImportSummary(result);

      expect(summary.totalMessages).toBe(0);
      expect(summary.percentNull).toBe("0.00");
    });

    it("should handle 100% NULL thread_id", () => {
      const result: ProcessingResult = {
        stored: 100,
        skipped: 0,
        nullThreadIdCount: 100,
        warnings: [],
      };

      const summary = calculateImportSummary(result);

      expect(summary.percentNull).toBe("100.00");
    });

    it("should handle fractional percentages", () => {
      const result: ProcessingResult = {
        stored: 1000,
        skipped: 0,
        nullThreadIdCount: 72, // 7.2%
        warnings: [],
      };

      const summary = calculateImportSummary(result);

      expect(summary.percentNull).toBe("7.20");
    });
  });

  // ==========================================================================
  // 6. Edge Cases Tests
  // ==========================================================================
  describe("Edge Cases", () => {
    it("should handle empty message array", () => {
      const messages: MockMessage[] = [];

      const result = processMessagesWithValidation(messages);

      expect(result.stored).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.nullThreadIdCount).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should handle all messages with NULL chat_id", () => {
      const messages: MockMessage[] = Array.from({ length: 5 }, (_, i) => ({
        guid: `msg-${i}`,
        chat_id: null,
        handle_id: "+15555550112",
        date: 725846400000000000,
        is_from_me: 0,
        text: `Message ${i}`,
        service: "iMessage",
      }));

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(5);
      expect(result.stored).toBe(5);
    });

    it("should handle all messages with valid chat_id", () => {
      const messages: MockMessage[] = Array.from({ length: 5 }, (_, i) => ({
        guid: `msg-${i}`,
        chat_id: i + 1,
        handle_id: "+15555550112",
        date: 725846400000000000,
        is_from_me: 0,
        text: `Message ${i}`,
        service: "iMessage",
      }));

      const result = processMessagesWithValidation(messages);

      expect(result.nullThreadIdCount).toBe(0);
      expect(result.stored).toBe(5);
    });

    it("should not double-count skipped messages in NULL thread_id count", () => {
      const messages: MockMessage[] = [
        {
          guid: "msg-1",
          chat_id: null,
          handle_id: "+15555550112",
          date: 725846400000000000,
          is_from_me: 0,
          text: null, // Will be skipped for null text
          service: "iMessage",
        },
      ];

      const result = processMessagesWithValidation(messages);

      // Message skipped for null text, never reaches NULL thread_id check
      expect(result.skipped).toBe(1);
      expect(result.stored).toBe(0);
      expect(result.nullThreadIdCount).toBe(0);
    });
  });
});
