/**
 * @jest-environment node
 *
 * BACKLOG-3731 PR-B — the import records why it skipped a text attachment,
 * and the submit pre-flight words each reason truthfully (and never lists a
 * link preview).
 *
 * Everything here runs the REAL producers against the REAL `schema.sql`:
 *   - messages are inserted by the import's own statement (`prepareInsertMessage`)
 *     with the metadata the import builds (`{source, originalId, service}`);
 *   - `storeAttachments` (private, bound to the singleton) runs over chat.db
 *     rows shaped as `RawMacAttachment` — the projection of
 *     `MACOS_MESSAGE_ATTACHMENTS_SQL` — pointing at REAL files on disk;
 *   - the pre-flight is fed exactly what the submit feeds it: `SELECT *` from
 *     `messages`, and the shared text lookup (`selectTextAttachmentsForMessages`)
 *     filtered to rows with a storage path, as `getTransactionAttachments` does.
 * Only `app.getPath` and free-space (`statfs`) are simulated.
 *
 * Run with the real sqlite driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file> --no-bail
 */

import * as os from "os";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType;

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb },
}));
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => ""),
}));
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { MAX_ATTACHMENT_SIZE } from "../macOSMessagesImportService/types";
import type { RawMacAttachment } from "../macOSMessagesImportService/types";
import { prepareInsertMessage, prepareRecordAttachmentSkips } from "../db/messageImportForceSql";
import { selectTextAttachmentsForMessages } from "../db/textAttachmentLookupSql";
import type { SubmissionAttachment } from "../db/submissionDbService";
import { runSubmissionPreflight, setPreflightStatForTests } from "../submissionPreflight";
import type { Attachment, Message } from "../../types/models";

const USER = "user-3731";
const THREAD = "chat-3731";

type StoreAttachmentsFn = (
  userId: string,
  attachments: RawMacAttachment[],
  messageIdMap: Map<string, string>,
) => Promise<{ stored: number; skipped: number; updated: number }>;

const storeAttachments = (
  macOSMessagesImportService as unknown as { storeAttachments: StoreAttachmentsFn }
).storeAttachments.bind(macOSMessagesImportService) as StoreAttachmentsFn;

let scratchDir: string;
let sourceDir: string;
let rowSeq = 0;

function openRealSchema(): DatabaseType {
  const db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(
    fsSync.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"),
  );
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(USER, "agent@example.test", "oauth-3731");
  return db;
}

/** A text as the import writes it (macOSMessagesImportService storeMessages). */
function insertText(guid: string, sentAt: string, hasAttachments: boolean): string {
  const id = `local-${guid}`;
  prepareInsertMessage(mockDb, { mode: "delta" }).run(
    id,
    USER,
    "imessage",
    guid,
    "inbound",
    "",
    JSON.stringify({ from: "+15550100", to: ["me"] }),
    "15550100",
    THREAD,
    sentAt,
    hasAttachments ? 1 : 0,
    "attachment_only",
    JSON.stringify({ source: "macos_messages", originalId: 1, service: "iMessage" }),
    null,
    null,
  );
  return id;
}

/** A chat.db attachment row (`RawMacAttachment`), optionally with a real file. */
async function chatDbRow(
  guid: string,
  name: string,
  opts: { write?: boolean; totalBytes?: number; mode?: number } = {},
): Promise<RawMacAttachment> {
  const filePath = nodePath.join(sourceDir, `${++rowSeq}-${name}`);
  let size = opts.totalBytes ?? 0;
  if (opts.write !== false) {
    await fs.writeFile(filePath, `bytes of ${name} #${rowSeq}`);
    if (opts.mode !== undefined) await fs.chmod(filePath, opts.mode);
    if (opts.totalBytes === undefined) size = (await fs.stat(filePath)).size;
  }
  return {
    attachment_id: rowSeq,
    message_id: rowSeq,
    message_guid: guid,
    guid: `att-${rowSeq}`,
    filename: filePath,
    mime_type: null,
    transfer_name: name,
    total_bytes: size,
    is_outgoing: 0,
  };
}

/** What the submit hands the pre-flight for these texts. */
async function preflightFor(messageIds: string[]) {
  const messages = mockDb
    .prepare(`SELECT * FROM messages WHERE id IN (${messageIds.map(() => "?").join(",")})`)
    .all(...messageIds) as Message[];
  const attachments = selectTextAttachmentsForMessages<SubmissionAttachment>(mockDb, messageIds)
    .filter(({ row }) => typeof row.storage_path === "string")
    .map(({ row, resolved_message_id }) => ({ ...row, resolved_message_id }));
  return runSubmissionPreflight({
    messages,
    emails: [],
    attachments: attachments as unknown as Attachment[],
    undownloadedEmailAttachments: [],
    textLabel: () => "Paul Example",
  });
}

function metadataOf(id: string): Record<string, unknown> {
  const row = mockDb.prepare(`SELECT metadata FROM messages WHERE id = ?`).get(id) as {
    metadata: string;
  };
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

beforeEach(async () => {
  mockDb = openRealSchema();
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3731-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3731-src-"));
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26,
    bsize: 4096,
    blocks: 1e8,
    bfree: 5e7,
    bavail: 5e7,
    files: 1000,
    ffree: 900,
  } as fsSync.StatsFs);
  setPreflightStatForTests(null);
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockDb.close();
  // chmod 000 fixtures must be readable again to be removed.
  for (const entry of await fs.readdir(sourceDir)) {
    await fs.chmod(nodePath.join(sourceDir, entry), 0o644).catch(() => undefined);
  }
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("BACKLOG-3731 — founder Sep-24 shape: 5 downloaded photos + 3 link previews", () => {
  it("produces ZERO not-included items, and all 5 photos are sendable", async () => {
    // e912e34a: 3 link-preview texts (2, 1 and 2 payload files) + 5 photo texts.
    const L1 = insertText("guid-L1", "2026-09-24T17:04:00.000Z", true);
    const L2 = insertText("guid-L2", "2026-09-24T17:08:00.000Z", true);
    const L3 = insertText("guid-L3", "2026-09-24T17:09:00.000Z", true);
    const photos = [
      insertText("guid-P1", "2026-09-24T18:32:00.000Z", true),
      insertText("guid-P2", "2026-09-24T18:32:30.000Z", true),
      insertText("guid-P3", "2026-09-24T18:36:00.000Z", true),
      insertText("guid-P4", "2026-09-24T18:48:00.000Z", true),
      insertText("guid-P5", "2026-09-24T18:51:00.000Z", true),
    ];
    const rows = [
      await chatDbRow("guid-L1", "A1.pluginPayloadAttachment"),
      await chatDbRow("guid-L1", "A2.pluginPayloadAttachment"),
      await chatDbRow("guid-L2", "B1.pluginPayloadAttachment"),
      await chatDbRow("guid-L3", "C1.pluginPayloadAttachment"),
      await chatDbRow("guid-L3", "C2.pluginPayloadAttachment"),
      await chatDbRow("guid-P1", "IMG_0001.jpg"),
      await chatDbRow("guid-P2", "IMG_0002.jpg"),
      await chatDbRow("guid-P3", "IMG_0003.jpg"),
      await chatDbRow("guid-P4", "IMG_0004.jpg"),
      await chatDbRow("guid-P5", "Screenshot.png"),
    ];

    const result = await storeAttachments(USER, rows, new Map());
    expect(result.stored).toBe(5);

    // The import's actual output for a link-preview text.
    expect(metadataOf(L1)).toEqual({
      source: "macos_messages",
      originalId: 1,
      service: "iMessage",
      attachmentSkips: [
        { name: "A1.pluginPayloadAttachment", reason: "link_preview" },
        { name: "A2.pluginPayloadAttachment", reason: "link_preview" },
      ],
    });
    // A stored photo's text gets no skip record.
    expect(metadataOf(photos[0]).attachmentSkips).toBeUndefined();

    const preflight = await preflightFor([L1, L2, L3, ...photos]);
    expect(preflight.notIncluded).toEqual([]);
    expect(preflight.sendable).toHaveLength(5);
  });
});

describe("BACKLOG-3731 — each import skip reason reaches the pre-flight", () => {
  it("never downloaded / over 100 MB / unsupported type / unreadable", async () => {
    const missing = insertText("guid-missing", "2026-09-25T10:00:00.000Z", true);
    const big = insertText("guid-big", "2026-09-25T10:01:00.000Z", true);
    const vcf = insertText("guid-vcf", "2026-09-25T10:02:00.000Z", true);
    const locked = insertText("guid-locked", "2026-09-25T10:03:00.000Z", true);
    const rows = [
      await chatDbRow("guid-missing", "IMG_9000.HEIC", { write: false, totalBytes: 2048 }),
      await chatDbRow("guid-big", "Tour.mov", { totalBytes: MAX_ATTACHMENT_SIZE + 1 }),
      await chatDbRow("guid-vcf", "Agent.vcf"),
      await chatDbRow("guid-locked", "Offer.pdf"),
    ];
    // Permission denied on the source file. Simulated at fs.access, because
    // chmod 000 does not make a file unreadable on Windows CI.
    const lockedPath = rows[3].filename as string;
    const realAccess = fsSync.promises.access.bind(fsSync.promises);
    jest.spyOn(fsSync.promises, "access").mockImplementation(async (p, mode) => {
      if (p === lockedPath) {
        throw Object.assign(new Error(`EACCES: permission denied, access '${lockedPath}'`), {
          code: "EACCES",
        });
      }
      return realAccess(p, mode);
    });
    await storeAttachments(USER, rows, new Map());

    expect(metadataOf(missing).attachmentSkips).toEqual([
      { name: "IMG_9000.HEIC", reason: "not_downloaded" },
    ]);
    expect(metadataOf(big).attachmentSkips).toEqual([{ name: "Tour.mov", reason: "too_large" }]);
    expect(metadataOf(vcf).attachmentSkips).toEqual([
      { name: "Agent.vcf", reason: "unsupported_type" },
    ]);
    expect(metadataOf(locked).attachmentSkips).toEqual([
      { name: "Offer.pdf", reason: "unreadable" },
    ]);

    const preflight = await preflightFor([missing, big, vcf, locked]);
    expect(preflight.notIncluded.map((i) => [i.key, i.filename, i.reason, i.threadId])).toEqual([
      [`skip:${missing}:0`, "IMG_9000.HEIC", "text_attachment_not_downloaded_by_messages", THREAD],
      [`skip:${big}:0`, "Tour.mov", "text_attachment_too_large_to_import", THREAD],
      [`skip:${vcf}:0`, "Agent.vcf", "text_attachment_type_not_imported", THREAD],
      [`skip:${locked}:0`, "Offer.pdf", "text_attachment_unreadable", THREAD],
    ]);
  });

  it("a link preview and a missing photo on ONE text: only the photo is listed", async () => {
    const both = insertText("guid-both", "2026-09-25T11:00:00.000Z", true);
    await storeAttachments(
      USER,
      [
        await chatDbRow("guid-both", "P.pluginPayloadAttachment"),
        await chatDbRow("guid-both", "IMG_7777.HEIC", { write: false, totalBytes: 10 }),
      ],
      new Map(),
    );
    const preflight = await preflightFor([both]);
    expect(preflight.notIncluded.map((i) => [i.key, i.filename, i.reason])).toEqual([
      [`skip:${both}:1`, "IMG_7777.HEIC", "text_attachment_not_downloaded_by_messages"],
    ]);
  });

  it("a text with NO recorded reason (imported before this) is still listed, neutrally", async () => {
    // has_attachments set, no attachment row, and no chat.db row reaches the
    // import (e.g. a NULL-filename attachment, filtered by the import SQL).
    const old = insertText("guid-old", "2026-09-25T12:00:00.000Z", true);
    const preflight = await preflightFor([old]);
    expect(preflight.notIncluded.map((i) => [i.key, i.reason])).toEqual([
      [`msg:${old}`, "text_attachment_not_on_this_computer"],
    ]);
  });

  it("once Messages downloads the file, the next sync stores it and nothing is listed", async () => {
    const later = insertText("guid-later", "2026-09-25T13:00:00.000Z", true);
    const row = await chatDbRow("guid-later", "IMG_5555.jpg", { write: false, totalBytes: 10 });
    await storeAttachments(USER, [row], new Map());
    expect((await preflightFor([later])).notIncluded.map((i) => i.reason)).toEqual([
      "text_attachment_not_downloaded_by_messages",
    ]);

    await fs.writeFile(row.filename as string, "now downloaded");
    await storeAttachments(USER, [row], new Map());
    const preflight = await preflightFor([later]);
    expect(preflight.notIncluded).toEqual([]);
    expect(preflight.sendable).toHaveLength(1);
  });

  it("a re-sync over the same history writes nothing new (no-op update)", async () => {
    const id = insertText("guid-idem", "2026-09-25T14:00:00.000Z", true);
    const row = await chatDbRow("guid-idem", "L.pluginPayloadAttachment");
    await storeAttachments(USER, [row], new Map());
    const before = metadataOf(id);
    await storeAttachments(USER, [row], new Map());
    expect(metadataOf(id)).toEqual(before);
    // The import's own statement reports no change for the same value...
    const record = prepareRecordAttachmentSkips(mockDb, { mode: "delta" });
    expect(record.run({ skips: JSON.stringify(before.attachmentSkips), id }).changes).toBe(0);
    // ...and replaces a different one whole.
    const next = [{ name: "X.vcf", reason: "unsupported_type" }];
    expect(record.run({ skips: JSON.stringify(next), id }).changes).toBe(1);
    expect(metadataOf(id).attachmentSkips).toEqual(next);
    expect(metadataOf(id).source).toBe("macos_messages");
  });

  it("a cancelled sync does not overwrite a message's skips with a partial list", async () => {
    const id = insertText("guid-two", "2026-09-25T15:00:00.000Z", true);
    const rows = [
      await chatDbRow("guid-two", "IMG_1.HEIC", { write: false, totalBytes: 10 }),
      await chatDbRow("guid-two", "IMG_2.HEIC", { write: false, totalBytes: 10 }),
    ];
    await storeAttachments(USER, rows, new Map());
    const full = metadataOf(id).attachmentSkips;
    expect(full).toHaveLength(2);

    // Second sync: the user cancels after the first attachment was checked.
    const service = macOSMessagesImportService as unknown as {
      abortController: AbortController | null;
    };
    const controller = new AbortController();
    service.abortController = controller;
    const realAccess = fsSync.promises.access.bind(fsSync.promises);
    jest.spyOn(fsSync.promises, "access").mockImplementation(async (p, mode) => {
      controller.abort();
      return realAccess(p, mode);
    });
    try {
      await storeAttachments(USER, rows, new Map());
    } finally {
      service.abortController = null;
    }
    expect(metadataOf(id).attachmentSkips).toEqual(full);
  });
});
