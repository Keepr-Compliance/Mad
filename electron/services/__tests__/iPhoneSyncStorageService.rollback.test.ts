/**
 * iPhoneSyncStorageService - ACID Rollback Unit Tests
 *
 * Tests for the rollback logic added in TASK-2110b:
 * - rollbackSession() (tested indirectly through persistSyncResult)
 * - Cancel signal at different phases (before, between, during)
 * - Content-addressed file safety (orphaned file detection)
 * - cancelledResult() output format
 * - Error-path behavior (exception vs cancel)
 * - Partial failures with rollback
 * - Successful batch commit with messages, contacts, and attachments
 *
 * TASK-2115: Expanded coverage for ACID rollback edge cases
 */

// Polyfill setImmediate for Jest (used by yieldToEventLoop)
if (typeof globalThis.setImmediate === "undefined") {
  (globalThis as unknown as Record<string, unknown>).setImmediate = (fn: () => void) => setTimeout(fn, 0);
}

// Mock electron before any imports
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
  },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      unlink: jest.fn().mockResolvedValue(undefined),
      mkdir: jest.fn().mockResolvedValue(undefined),
      stat: jest.fn().mockResolvedValue({ size: 1024 }),
      copyFile: jest.fn().mockResolvedValue(undefined),
    },
    createReadStream: jest.fn(),
  };
});

jest.mock("../databaseService");
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: {
    resolveAttachmentPath: jest.fn(),
  },
}));
jest.mock("../../utils/messageTypeDetector", () => ({
  detectMessageType: jest.fn().mockReturnValue("text"),
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import fs from "fs";
import databaseService from "../databaseService";
import * as externalContactDb from "../db/externalContactDbService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";
import type { iOSContact } from "../../types/iosContacts";

// Type the mocks
const mockDbService = databaseService as jest.Mocked<typeof databaseService>;
const mockExternalContactDb = externalContactDb as jest.Mocked<typeof externalContactDb>;
const mockFsPromises = fs.promises as jest.Mocked<typeof fs.promises>;

// ============================================
// Test Fixtures
// ============================================

function makeSyncResult(overrides?: Partial<SyncResult>): SyncResult {
  return {
    success: true,
    messages: [],
    contacts: [],
    conversations: [],
    error: null,
    duration: 100,
    ...overrides,
  };
}

function makeMessage(id: number, guid: string): iOSMessage {
  return {
    id,
    guid,
    text: `Test message ${id}`,
    handle: "+15555550112",
    isFromMe: false,
    date: new Date("2024-01-01T10:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    attachments: [],
    chatId: 1,
    service: "iMessage",
  } as iOSMessage;
}

// NOTE: this fixture predates the current `iOSConversation` shape — it carries
// guid/displayName/lastMessageDate/messageCount instead of chatIdentifier/
// lastMessage. persistSyncResult only reads `chatId` and `messages`, so the
// payload is left exactly as the tests were written against it.
function makeConversation(chatId: number, messages: iOSMessage[]): iOSConversation {
  return {
    chatId,
    guid: `chat-guid-${chatId}`,
    displayName: "Test Chat",
    participants: ["+15555550112"],
    lastMessageDate: new Date("2024-01-01T10:00:00Z"),
    messageCount: messages.length,
    isGroupChat: false,
    messages,
  } as unknown as iOSConversation;
}

function makeContact(id: number): iOSContact {
  return {
    id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    displayName: `First${id} Last${id}`,
    organization: null,
    phoneNumbers: [{ label: "mobile", number: "+15555550112", normalizedNumber: "+15555550112" }],
    emails: [{ label: "home", email: `test${id}@example.com` }],
    // The BACKLOG-2407 capture-only fields (externalUuid, externalIdentifier,
    // externalModificationTag, modifiedAt, createdAt, storeId) are intentionally
    // omitted rather than invented — nothing in this suite reads or asserts them.
  } as iOSContact;
}

// ============================================
// Setup
// ============================================

beforeEach(() => {
  jest.clearAllMocks();

  // Default mock implementations for database service
  mockDbService.getExistingMessageExternalIds.mockReturnValue(new Set<string>());
  mockDbService.batchInsertMessages.mockReturnValue({ stored: 0, skipped: 0 });
  mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
    deleted: 0,
    orphanedFiles: [],
  });
  mockDbService.deleteMessagesBySessionId.mockReturnValue(0);
  mockExternalContactDb.deleteBySessionId.mockReturnValue(0);
  mockExternalContactDb.upsertFromiPhone.mockReturnValue(0);
});

// ============================================
// 1. rollbackSession() via persistSyncResult()
// ============================================

describe("rollbackSession (via persistSyncResult)", () => {
  it("should call rollback and return cancelled result when cancel signal is set after messages phase", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1"), makeMessage(2, "guid-2")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 2, skipped: 0 });
    // Simulate cancel happening after messages are stored
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 2, skipped: 0 };
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
      deleted: 0,
      orphanedFiles: [],
    });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(2);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-123",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");
    expect(result.messagesStored).toBe(0);

    // Verify rollback was called
    expect(mockDbService.deleteAttachmentsBySessionId).toHaveBeenCalledWith("session-123");
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-123");
    expect(mockExternalContactDb.deleteBySessionId).toHaveBeenCalledWith("user-1", "session-123");
  });

  it("should delete orphaned files from disk during rollback", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Cancel after messages phase
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
      deleted: 3,
      orphanedFiles: ["/mock/path/file1.jpg", "/mock/path/file2.png", "/mock/path/file3.pdf"],
    });

    await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-456",
      cancelSignal
    );

    // Verify each orphaned file was deleted
    expect(mockFsPromises.unlink).toHaveBeenCalledTimes(3);
    expect(mockFsPromises.unlink).toHaveBeenCalledWith("/mock/path/file1.jpg");
    expect(mockFsPromises.unlink).toHaveBeenCalledWith("/mock/path/file2.png");
    expect(mockFsPromises.unlink).toHaveBeenCalledWith("/mock/path/file3.pdf");
  });

  it("should skip rollback when no sessionId is provided", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Cancel after messages phase but with no sessionId
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      undefined, // no sessionId
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // rollback should NOT call delete methods (no sessionId)
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
    expect(mockExternalContactDb.deleteBySessionId).not.toHaveBeenCalled();
  });

  it("should handle rollback errors gracefully (log but don't throw)", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Cancel after messages
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    // Make rollback throw
    mockDbService.deleteAttachmentsBySessionId.mockImplementation(() => {
      throw new Error("DB locked");
    });

    // Should NOT throw - rollback catches errors internally
    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-err",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");
  });
});

// ============================================
// 2. Cancel signal timing
// ============================================

describe("cancel signal timing", () => {
  it("should return cancelled result immediately when cancelled before messages phase", async () => {
    const cancelSignal = { cancelled: true }; // Already cancelled

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages: [makeMessage(1, "guid-1")] }),
      undefined,
      undefined,
      "session-pre",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");
    expect(result.messagesStored).toBe(0);
    expect(result.contactsStored).toBe(0);
    expect(result.attachmentsStored).toBe(0);

    // No DB operations should have been called at all
    expect(mockDbService.getExistingMessageExternalIds).not.toHaveBeenCalled();
    expect(mockDbService.batchInsertMessages).not.toHaveBeenCalled();

    // No rollback needed since nothing was stored
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
  });

  it("should cancel between messages and contacts, rolling back messages", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Cancel after storeMessages completes (batchInsertMessages triggers cancel)
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(1);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations, contacts: [makeContact(1)] }),
      undefined,
      undefined,
      "session-mid1",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // Rollback should have been called
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-mid1");

    // Contacts should NOT have been stored (cancel happened before contact phase)
    expect(mockExternalContactDb.upsertFromiPhone).not.toHaveBeenCalled();
  });

  it("should cancel between contacts and attachments, rolling back messages + contacts", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];
    const contacts = [makeContact(1)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });

    // Cancel after storeContacts completes
    mockExternalContactDb.upsertFromiPhone.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return 1;
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(1);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(1);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations, contacts }),
      undefined,
      undefined,
      "session-mid2",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // Both messages and contacts should be rolled back
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-mid2");
    expect(mockExternalContactDb.deleteBySessionId).toHaveBeenCalledWith("user-1", "session-mid2");
  });
});

// ============================================
// 3. Content-addressed file safety
// ============================================

describe("content-addressed file safety", () => {
  it("should only delete orphaned files, not files shared across sessions", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Cancel after messages
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    // deleteAttachmentsBySessionId returns ONLY orphaned files
    // Files shared with other sessions are NOT in this list
    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
      deleted: 5,
      orphanedFiles: ["/mock/path/orphan1.jpg"], // Only 1 of 5 is orphaned
    });

    await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-files",
      cancelSignal
    );

    // Only the orphaned file should be unlinked
    expect(mockFsPromises.unlink).toHaveBeenCalledTimes(1);
    expect(mockFsPromises.unlink).toHaveBeenCalledWith("/mock/path/orphan1.jpg");
  });

  it("should handle file deletion errors gracefully (file already deleted)", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
      deleted: 2,
      orphanedFiles: ["/mock/path/already-gone.jpg", "/mock/path/exists.jpg"],
    });

    // First file fails (already deleted), second succeeds
    (mockFsPromises.unlink as jest.Mock)
      .mockRejectedValueOnce(new Error("ENOENT: no such file"))
      .mockResolvedValueOnce(undefined);

    // Should NOT throw
    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-enoent",
      cancelSignal
    );

    expect(result.success).toBe(false);
    // Both unlink calls should have been attempted
    expect(mockFsPromises.unlink).toHaveBeenCalledTimes(2);
  });
});

// ============================================
// 4. cancelledResult()
// ============================================

describe("cancelledResult (via persistSyncResult)", () => {
  it("should return PersistResult with success=false and all counts 0", async () => {
    const cancelSignal = { cancelled: true };

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult(),
      undefined,
      undefined,
      "session-cancel",
      cancelSignal
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        messagesStored: 0,
        messagesSkipped: 0,
        contactsStored: 0,
        contactsSkipped: 0,
        attachmentsStored: 0,
        attachmentsSkipped: 0,
        error: "Sync cancelled by user",
      })
    );
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

// ============================================
// 5. Successful persistence (no cancel)
// ============================================

describe("persistSyncResult without cancel", () => {
  it("should return success when no cancel signal is set", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });
    mockExternalContactDb.upsertFromiPhone.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-ok"
    );

    expect(result.success).toBe(true);
    expect(result.messagesStored).toBe(1);
    expect(result.error).toBeUndefined();

    // No rollback should have been called
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
  });

  it("should store messages and contacts with correct counts", async () => {
    const messages = [makeMessage(1, "guid-1"), makeMessage(2, "guid-2"), makeMessage(3, "guid-3")];
    const conversations = [makeConversation(1, messages)];
    const contacts = [makeContact(1), makeContact(2)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 3, skipped: 0 });
    mockExternalContactDb.upsertFromiPhone.mockReturnValue(2);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations, contacts }),
      undefined,
      undefined,
      "session-full"
    );

    expect(result.success).toBe(true);
    expect(result.messagesStored).toBe(3);
    expect(result.messagesSkipped).toBe(0);
    expect(result.contactsStored).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // No rollback should have been called
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
    expect(mockExternalContactDb.deleteBySessionId).not.toHaveBeenCalled();
  });

  it("should handle mixed stored/skipped messages correctly", async () => {
    const messages = [makeMessage(1, "guid-1"), makeMessage(2, "guid-2")];
    const conversations = [makeConversation(1, messages)];

    // 1 stored, 1 skipped (duplicate)
    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 1 });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-mixed"
    );

    expect(result.success).toBe(true);
    expect(result.messagesStored).toBe(1);
    expect(result.messagesSkipped).toBe(1);
  });

  it("should pass sessionId to batchInsertMessages for tagging", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });

    await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-tag-123"
    );

    // sessionId should be passed to batchInsertMessages for DB tagging
    expect(mockDbService.batchInsertMessages).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      "session-tag-123",
      undefined // no cancel signal
    );
  });

  it("should work correctly without sessionId or cancelSignal", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations })
      // no backupPath, no onProgress, no sessionId, no cancelSignal
    );

    expect(result.success).toBe(true);
    expect(result.messagesStored).toBe(1);
  });
});

// ============================================
// 6. Error-path behavior (exception vs cancel)
// ============================================

describe("error-path behavior (exception handling)", () => {
  it("should return error result when storeMessages throws (no rollback on error)", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Simulate an exception during message storage
    mockDbService.getExistingMessageExternalIds.mockImplementation(() => {
      throw new Error("Database corruption");
    });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-err-msg"
    );

    // Error path: returns failure but does NOT trigger rollback
    expect(result.success).toBe(false);
    expect(result.error).toBe("Database corruption");
    expect(result.messagesStored).toBe(0);
    expect(result.contactsStored).toBe(0);
    expect(result.attachmentsStored).toBe(0);

    // Rollback should NOT be called on exceptions (only on cancel)
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
    expect(mockExternalContactDb.deleteBySessionId).not.toHaveBeenCalled();
  });

  it("should return error result when batchInsertMessages throws", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockImplementation(() => {
      throw new Error("Disk full");
    });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-err-batch"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Disk full");
    expect(result.messagesStored).toBe(0);

    // No rollback on exception
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
  });

  it("should return error result when storeContacts throws after messages succeed", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];
    const contacts = [makeContact(1)];

    // Messages succeed
    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });

    // Contacts throw
    mockExternalContactDb.upsertFromiPhone.mockImplementation(() => {
      throw new Error("Contact table locked");
    });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations, contacts }),
      undefined,
      undefined,
      "session-err-contacts"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Contact table locked");
    // On exception, all counts reset to 0 (try/catch returns zeroed result)
    expect(result.messagesStored).toBe(0);
    expect(result.contactsStored).toBe(0);

    // No rollback on exception (rollback only for cancel)
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
  });

  it("should not throw when unknown error type is caught", async () => {
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    // Throw a non-Error object
    mockDbService.getExistingMessageExternalIds.mockImplementation(() => {
      throw "string error"; // eslint-disable-line no-throw-literal
    });

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-err-unknown"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown error");
  });
});

// ============================================
// 7. Partial success then cancel (rollback correctness)
// ============================================

describe("partial success then cancel", () => {
  it("should roll back messages stored in first batch when cancel triggers mid-way", async () => {
    const messages: iOSMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push(makeMessage(i, `guid-${i}`));
    }
    const conversations = [makeConversation(1, messages)];
    const cancelSignal = { cancelled: false };

    // Simulate: batchInsertMessages stores some messages then cancel triggers
    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 7, skipped: 3 }; // Some stored, some duplicates
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(7); // Should delete the 7 stored
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-partial",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // Rollback should delete the 7 messages that were stored
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-partial");
  });

  it("should roll back both messages and contacts when cancel after contacts phase", async () => {
    const messages = [makeMessage(1, "guid-1"), makeMessage(2, "guid-2")];
    const conversations = [makeConversation(1, messages)];
    const contacts = [makeContact(1), makeContact(2), makeContact(3)];
    const cancelSignal = { cancelled: false };

    // Messages succeed
    mockDbService.batchInsertMessages.mockReturnValue({ stored: 2, skipped: 0 });

    // Contacts succeed, then cancel triggers
    mockExternalContactDb.upsertFromiPhone.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return 3; // All 3 contacts stored
    });

    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(2);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(3);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations, contacts }),
      undefined,
      undefined,
      "session-partial-contacts",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // Both messages and contacts should be rolled back
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-partial-contacts");
    expect(mockExternalContactDb.deleteBySessionId).toHaveBeenCalledWith("user-1", "session-partial-contacts");

    // Attachments should also be rolled back (session-level cleanup)
    expect(mockDbService.deleteAttachmentsBySessionId).toHaveBeenCalledWith("session-partial-contacts");
  });

  it("should report correct duration in cancelled result", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });
    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(1);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-duration",
      cancelSignal
    );

    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration).toBe("number");
  });
});

// ============================================
// 8. Rollback order verification
// ============================================

describe("rollback execution order", () => {
  it("should delete attachments before messages before contacts during rollback", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });

    const callOrder: string[] = [];

    mockDbService.deleteAttachmentsBySessionId.mockImplementation(() => {
      callOrder.push("deleteAttachments");
      return { deleted: 0, orphanedFiles: [] };
    });
    mockDbService.deleteMessagesBySessionId.mockImplementation(() => {
      callOrder.push("deleteMessages");
      return 1;
    });
    mockExternalContactDb.deleteBySessionId.mockImplementation(() => {
      callOrder.push("deleteContacts");
      return 0;
    });

    await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      undefined,
      "session-order",
      cancelSignal
    );

    // Verify order: attachments -> messages -> contacts
    expect(callOrder).toEqual(["deleteAttachments", "deleteMessages", "deleteContacts"]);
  });
});

// ============================================
// 9. Cancel during attachments phase
// ============================================

describe("cancel during attachments phase", () => {
  it("should roll back all data when cancel signal triggers after attachments phase", async () => {
    const cancelSignal = { cancelled: false };
    const msg1 = makeMessage(1, "guid-1");
    // Add an attachment to the message
    msg1.attachments = [{
      id: 1,
      filename: "~/Library/test.jpg",
      transferName: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: 1024,
      isSticker: false,
    }] as unknown as iOSMessage["attachments"];

    const messages = [msg1];
    const conversations = [makeConversation(1, messages)];

    // Messages succeed
    mockDbService.batchInsertMessages.mockReturnValue({ stored: 1, skipped: 0 });
    // Contacts succeed
    mockExternalContactDb.upsertFromiPhone.mockReturnValue(0);

    // Attachment storage needs additional mocks
    mockDbService.getMessageIdMap.mockReturnValue(new Map([["guid-1", "internal-id-1"]]));
    mockDbService.getAttachmentStoragePaths.mockReturnValue([]);
    mockDbService.getExistingAttachmentRecords.mockReturnValue(new Set());
    mockDbService.insertAttachment.mockImplementation(() => {
      // Cancel triggers during attachment storage
      cancelSignal.cancelled = true;
    });

    // Mock iOSMessagesParser for attachment resolution
    const { iOSMessagesParser } = require("../iosMessagesParser");
    iOSMessagesParser.resolveAttachmentPath.mockReturnValue("/mock/backup/test.jpg");

    // Mock crypto for streaming hash
    const mockStream = {
      on: jest.fn().mockImplementation(function (this: Record<string, unknown>, event: string, cb: (...args: unknown[]) => void) {
        if (event === "data") cb(Buffer.from("test"));
        if (event === "end") cb();
        return this;
      }),
    };
    (fs.createReadStream as jest.Mock).mockReturnValue(mockStream);

    // Rollback mocks
    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({
      deleted: 1,
      orphanedFiles: ["/mock/userData/message-attachments/abc123.jpg"],
    });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(1);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      "/mock/backup",
      undefined,
      "session-att-cancel",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");

    // All rollback methods should have been called
    expect(mockDbService.deleteAttachmentsBySessionId).toHaveBeenCalledWith("session-att-cancel");
    expect(mockDbService.deleteMessagesBySessionId).toHaveBeenCalledWith("user-1", "session-att-cancel");
    expect(mockExternalContactDb.deleteBySessionId).toHaveBeenCalledWith("user-1", "session-att-cancel");

    // Orphaned files should be cleaned up
    expect(mockFsPromises.unlink).toHaveBeenCalledWith("/mock/userData/message-attachments/abc123.jpg");
  });
});

// ============================================
// 10. Empty data edge cases
// ============================================

describe("empty data edge cases", () => {
  it("should succeed with empty messages, contacts, and conversations", async () => {
    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages: [], contacts: [], conversations: [] }),
      undefined,
      undefined,
      "session-empty"
    );

    expect(result.success).toBe(true);
    expect(result.messagesStored).toBe(0);
    expect(result.contactsStored).toBe(0);
    expect(result.attachmentsStored).toBe(0);

    // batchInsertMessages should not be called with empty messages
    // (storeMessages returns early for empty array)
    expect(mockDbService.batchInsertMessages).not.toHaveBeenCalled();
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
  });

  it("should not trigger rollback when cancelled with empty sync data", async () => {
    const cancelSignal = { cancelled: true };

    const result = await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages: [], contacts: [], conversations: [] }),
      undefined,
      undefined,
      "session-empty-cancel",
      cancelSignal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sync cancelled by user");
    // No rollback needed (cancel before any storage started)
    expect(mockDbService.deleteAttachmentsBySessionId).not.toHaveBeenCalled();
    expect(mockDbService.deleteMessagesBySessionId).not.toHaveBeenCalled();
  });
});

// ============================================
// 11. Progress callback during cancel
// ============================================

describe("progress callback behavior", () => {
  it("should invoke progress callback before cancel takes effect", async () => {
    const cancelSignal = { cancelled: false };
    const messages = [makeMessage(1, "guid-1")];
    const conversations = [makeConversation(1, messages)];

    const progressCalls: Array<{ phase: string; current: number; total: number }> = [];

    mockDbService.batchInsertMessages.mockImplementation(() => {
      cancelSignal.cancelled = true;
      return { stored: 1, skipped: 0 };
    });
    mockDbService.deleteAttachmentsBySessionId.mockReturnValue({ deleted: 0, orphanedFiles: [] });
    mockDbService.deleteMessagesBySessionId.mockReturnValue(1);
    mockExternalContactDb.deleteBySessionId.mockReturnValue(0);

    await iPhoneSyncStorageService.persistSyncResult(
      "user-1",
      makeSyncResult({ messages, conversations }),
      undefined,
      (progress) => {
        progressCalls.push({ phase: progress.phase, current: progress.current, total: progress.total });
      },
      "session-progress",
      cancelSignal
    );

    // Messages phase progress should have been reported at least once
    const messageProgressCalls = progressCalls.filter(p => p.phase === "messages");
    expect(messageProgressCalls.length).toBeGreaterThanOrEqual(1);

    // Contacts phase should NOT have progress (cancelled before contacts)
    const contactProgressCalls = progressCalls.filter(p => p.phase === "contacts");
    expect(contactProgressCalls.length).toBe(0);
  });
});
