/**
 * BACKLOG-3784 — skipped attachments still report progress and yield.
 *
 * Every skip in `storeAttachments` `continue`s. Before this change the progress
 * report and the event-loop yield sat after the try/catch, so a run of skipped
 * attachments (an incremental sync where every attachment is already stored)
 * neither reported progress nor yielded the main process's event loop.
 * Same throttle: every 100th item and the last.
 */

if (typeof globalThis.setImmediate === "undefined") {
  (globalThis as unknown as Record<string, unknown>).setImmediate = (fn: () => void) =>
    setTimeout(fn, 0);
}

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/mock/userData") },
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
  iOSMessagesParser: { resolveAttachmentPath: jest.fn() },
}));
jest.mock("../../utils/messageTypeDetector", () => ({
  detectMessageType: jest.fn().mockReturnValue("text"),
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import databaseService from "../databaseService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { iOSMessage } from "../../types/iosMessages";

const mockDb = databaseService as jest.Mocked<typeof databaseService>;

type StoreAttachments = (
  userId: string,
  messages: iOSMessage[],
  backupPath: string,
  onProgress?: (current: number, total: number) => void,
) => Promise<{ stored: number; skipped: number }>;

function messagesWithAttachments(count: number): iOSMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    guid: `guid-${i + 1}`,
    text: "",
    handle: "+15555550112",
    isFromMe: false,
    date: new Date("2024-01-01T10:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    chatId: 1,
    service: "iMessage",
    attachments: [
      {
        id: i + 1,
        filename: `~/Library/a${i + 1}.jpg`,
        transferName: `a${i + 1}.jpg`,
        mimeType: "image/jpeg",
        fileSize: 1024,
        isSticker: false,
      },
    ],
  })) as unknown as iOSMessage[];
}

describe("BACKLOG-3784: storeAttachments progress for skipped items", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getAttachmentStoragePaths.mockReturnValue([]);
  });

  it("reports progress and yields on the throttle when every attachment is skipped", async () => {
    // No message id for any guid -> every attachment takes the first `continue`.
    mockDb.getMessageIdMap.mockReturnValue(new Map());
    mockDb.getExistingAttachmentRecords.mockReturnValue(new Set());
    const immediate = jest.spyOn(globalThis, "setImmediate");

    const progress: Array<[number, number]> = [];
    const store = (
      iPhoneSyncStorageService as unknown as { storeAttachments: StoreAttachments }
    ).storeAttachments.bind(iPhoneSyncStorageService);
    const result = await store("user-1", messagesWithAttachments(250), "/mock/backup", (c, t) =>
      progress.push([c, t]),
    );

    expect(result).toEqual({ stored: 0, skipped: 250 });
    expect(progress).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ]);
    expect(immediate).toHaveBeenCalledTimes(3);
    immediate.mockRestore();
  });

  it("an already-stored attachment (the incremental case) also counts toward progress", async () => {
    const messages = messagesWithAttachments(100);
    mockDb.getMessageIdMap.mockReturnValue(
      new Map(messages.map((m) => [m.guid, `internal-${m.id}`])),
    );
    mockDb.getExistingAttachmentRecords.mockReturnValue(
      new Set(messages.map((m) => `internal-${m.id}:a${m.id}.jpg`)),
    );

    const progress: Array<[number, number]> = [];
    const store = (
      iPhoneSyncStorageService as unknown as { storeAttachments: StoreAttachments }
    ).storeAttachments.bind(iPhoneSyncStorageService);
    const result = await store("user-1", messages, "/mock/backup", (c, t) => progress.push([c, t]));

    expect(result).toEqual({ stored: 0, skipped: 100 });
    expect(progress).toEqual([[100, 100]]);
  });
});
