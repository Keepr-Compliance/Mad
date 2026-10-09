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
// BACKLOG-3816: the attachment writer is the at-rest module; this suite's fs mock
// cannot run real encryption, so the writer is stubbed (encryption is covered by
// atRest.attachmentWriters-3816.test.ts).
jest.mock("../atRest/attachmentWriter", () => ({
  ...jest.requireActual("../atRest/attachmentWriter"),
  plaintextSize: jest.fn().mockResolvedValue(1024),
  hashPlaintext: jest.fn().mockResolvedValue({ sha256: "abc123", size: 1024 }),
  sealFileFrom: jest.fn().mockResolvedValue({ sha256: "abc123", plaintextSize: 1024 }),
}));
jest.mock("../databaseService");
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn(), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/messageTypeDetector", () => ({
  detectMessageType: jest.fn().mockReturnValue("text"),
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import { hashPlaintext, plaintextSize } from "../atRest/attachmentWriter";
import databaseService from "../databaseService";
import { iOSMessagesParser } from "../iosMessagesParser";
import {
  iPhoneSyncStorageService,
  attachmentSkipFields,
  type AttachmentSkipCounts,
} from "../iPhoneSyncStorageService";
import type { iOSMessage } from "../../types/iosMessages";

const mockDb = databaseService as jest.Mocked<typeof databaseService>;

type StoreAttachments = (
  userId: string,
  messages: iOSMessage[],
  backupPath: string,
  onProgress?: (current: number, total: number) => void,
) => Promise<{ stored: number; skipped: number; skippedByReason: AttachmentSkipCounts }>;

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

    expect(result).toMatchObject({ stored: 0, skipped: 250 });
    expect(result.skippedByReason.noMessage).toBe(250);
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

    expect(result).toMatchObject({ stored: 0, skipped: 100 });
    expect(result.skippedByReason.alreadyStored).toBe(100);
    expect(progress).toEqual([[100, 100]]);
  });
});

describe("BACKLOG-3784: skipped attachments are counted per reason", () => {
  /** One attachment whose name encodes which skip path it should take. */
  function msg(id: number, name: string): iOSMessage {
    return {
      ...messagesWithAttachments(1)[0],
      id,
      guid: `guid-${id}`,
      attachments: [
        { id, filename: `~/Library/${name}`, transferName: name, mimeType: null, fileSize: 1, isSticker: false },
      ],
    } as unknown as iOSMessage;
  }

  it("each reason has its own count and the counts sum to the skipped total", async () => {
    // Distinct counts per reason (1..7) so collapsing reasons cannot pass.
    const plan: Array<[string, number]> = [
      ["nomsg", 1],
      ["unsupported", 2],
      ["already", 3],
      ["rejected", 4],
      ["missing", 5],
      ["big", 6],
      ["boom", 7],
    ];
    const messages: iOSMessage[] = [];
    let id = 0;
    for (const [kind, n] of plan) {
      for (let k = 0; k < n; k++) {
        id++;
        messages.push(msg(id, kind === "unsupported" ? `${kind}-${id}.xyz` : `${kind}-${id}.jpg`));
      }
    }
    mockDb.getMessageIdMap.mockReturnValue(
      new Map(
        messages
          .filter((m) => !m.attachments[0].transferName!.startsWith("nomsg"))
          .map((m) => [m.guid, `internal-${m.id}`]),
      ),
    );
    mockDb.getExistingAttachmentRecords.mockReturnValue(
      new Set(
        messages
          .filter((m) => m.attachments[0].transferName!.startsWith("already"))
          .map((m) => `internal-${m.id}:${m.attachments[0].transferName}`),
      ),
    );
    (iOSMessagesParser.resolveAttachmentPath as jest.Mock).mockImplementation(
      (_backup: string, filename: string) => (filename.includes("rejected") ? null : `/mock/backup/${filename.split("/").pop()}`),
    );
    // BACKLOG-3816: size and hash now come from the at-rest writer (plaintext size/hash).
    (plaintextSize as jest.Mock).mockImplementation(async (p: string) => {
      if (p.includes("missing")) throw new Error("ENOENT");
      if (p.includes("big")) return 51 * 1024 * 1024;
      return 10;
    });
    (hashPlaintext as jest.Mock).mockImplementation(async () => {
      throw new Error("read failed");
    });

    const store = (
      iPhoneSyncStorageService as unknown as { storeAttachments: StoreAttachments }
    ).storeAttachments.bind(iPhoneSyncStorageService);
    const result = await store("user-1", messages, "/mock/backup");

    expect(result.stored).toBe(0);
    expect(result.skippedByReason).toEqual({
      noMessage: 1,
      unsupportedType: 2,
      alreadyStored: 3,
      rejectedPath: 4,
      notInBackup: 5,
      tooLarge: 6,
      error: 7,
    });
    const sum = Object.values(result.skippedByReason).reduce((a, b) => a + b, 0);
    expect(result.skipped).toBe(28);
    expect(sum).toBe(result.skipped);
  });

  it("flattens to sync-outcome fields, counts only", () => {
    expect(
      attachmentSkipFields(28, {
        noMessage: 1,
        unsupportedType: 2,
        alreadyStored: 3,
        rejectedPath: 4,
        notInBackup: 5,
        tooLarge: 6,
        error: 7,
      }),
    ).toEqual({
      attachmentsSkipped: 28,
      attachmentsSkippedNoMessage: 1,
      attachmentsSkippedUnsupportedType: 2,
      attachmentsSkippedAlreadyStored: 3,
      attachmentsSkippedRejectedPath: 4,
      attachmentsSkippedNotInBackup: 5,
      attachmentsSkippedTooLarge: 6,
      attachmentsSkippedError: 7,
    });
    expect(attachmentSkipFields(3, undefined)).toEqual({ attachmentsSkipped: 3 });
  });
});
