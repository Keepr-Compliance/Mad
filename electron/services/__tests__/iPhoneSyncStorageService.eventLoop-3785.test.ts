/**
 * @jest-environment node
 *
 * BACKLOG-3785 — the attachment phase of an iPhone sync must not block the main
 * event loop while it resolves message ids and existing attachment records.
 *
 * Field evidence (2.40.0-beta.1/beta.2, ~670k stored messages, ~65k attachments):
 * "Processing N attachments" -> first attachment progress tick was ~33-40 s with
 * no yield. The setup loaded EVERY message row of the user (getMessageIdMap) and
 * EVERY attachment record to resolve the ids of this sync's attachments.
 *
 * This suite runs the REAL sqlite driver against the REAL `schema.sql`, seeds a
 * synthetic 200k-message store whose 20k attachments are already stored (the
 * incremental-sync case), runs `storeAttachments`, and measures the longest
 * event-loop stall with `monitorEventLoopDelay`. Real driver: run under Electron —
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 */

import * as nodePath from "path";
import * as nodeFs from "fs";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: {
    getPath: jest
      .fn()
      .mockReturnValue(
        jest.requireActual<typeof import("path")>("path").join(
          jest.requireActual<typeof import("os")>("os").tmpdir(),
          "keepr-3785-eventloop",
        ),
      ),
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));
// The storage service reaches the db layer only through databaseService. Route
// every call storeAttachments can make to the REAL db modules, so production SQL runs.
jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  const attachments = jest.requireActual("../db/attachmentDbService");
  return {
    __esModule: true,
    default: {
      getMessageIdMap: (userId: string) => sync.getMessageIdMap(userId),
      getMessageIdsByExternalIds: (userId: string, ids: string[]) => sync.getMessageIdsByExternalIds(userId, ids),
      getExistingAttachmentRecords: () => sync.getExistingAttachmentRecords(),
      getExistingAttachmentRecordsForMessages: (ids: string[]) => sync.getExistingAttachmentRecordsForMessages(ids),
      getAttachmentStoragePaths: () => attachments.getAttachmentStoragePaths(),
      insertAttachment: (params: unknown) => sync.insertAttachment(params),
    },
  };
});

import { setDb } from "../db/core/dbConnection";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { iOSMessage } from "../../types/iosMessages";

const USER = "user-3785";
const MESSAGES = 200_000;
const WITH_ATTACHMENT_EVERY = 10; // 20k attachments

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(
      nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    );
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(
      `[3785] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}

const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const DB_DIR = nodePath.join(jest.requireActual<typeof import("os")>("os").tmpdir(), "keepr-3785-eventloop-db");
const KEY_HEX = "3785".repeat(16);

function openEncrypted(): DatabaseType {
  const opened = new Driver!(nodePath.join(DB_DIR, "mad.db"));
  opened.pragma(`key = "x'${KEY_HEX}'"`);
  opened.pragma("cipher_compatibility = 4");
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = NORMAL");
  return opened;
}

const guidFor = (i: number): string => `GUID-${String(i).padStart(7, "0")}`;
const filenameFor = (i: number): string => `IMG_${i}.jpg`;

function makeMessage(i: number): iOSMessage {
  const hasAttachment = i % WITH_ATTACHMENT_EVERY === 0;
  return {
    id: i,
    guid: guidFor(i),
    text: `message body ${i}`,
    handle: "+15555550100",
    isFromMe: i % 2 === 0,
    date: new Date(1_700_000_000_000 + i * 1000),
    dateRead: null,
    dateDelivered: null,
    service: "iMessage",
    attachments: hasAttachment
      ? [{ id: i, guid: `ATT-${i}`, filename: `Library/SMS/Attachments/${filenameFor(i)}`, mimeType: "image/jpeg", transferName: filenameFor(i) }]
      : [],
  };
}

maybe("BACKLOG-3785: storeAttachments setup keeps the main event loop responsive (real driver)", () => {
  let db: DatabaseType;

  beforeAll(() => {
    // Production shape: an ENCRYPTED file database opened the way databaseService
    // opens it (key + cipher_compatibility 4 + WAL), reopened cold after seeding so
    // the measured reads decrypt pages instead of hitting a warm cache.
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(DB_DIR, { recursive: true });
    db = openEncrypted();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3785@example.test",
      "oauth-3785",
    );
    const insMessage = db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
        participants_flat, thread_id, sent_at, has_attachments, message_type, metadata, created_at)
       VALUES (?, ?, 'imessage', ?, 'inbound', ?, '{}', '15555550100', 'ios-chat-1', ?, ?, 'text', '{}', CURRENT_TIMESTAMP)`,
    );
    const insAttachment = db.prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at)
       VALUES (?, ?, ?, ?, 'image/jpeg', 1024, ?, CURRENT_TIMESTAMP)`,
    );
    const body = "x".repeat(600);
    db.transaction(() => {
      for (let i = 0; i < MESSAGES; i++) {
        const hasAttachment = i % WITH_ATTACHMENT_EVERY === 0;
        insMessage.run(`msg-${i}`, USER, guidFor(i), body, new Date(1_700_000_000_000 + i * 1000).toISOString(), hasAttachment ? 1 : 0);
        if (hasAttachment) {
          insAttachment.run(`att-${i}`, `msg-${i}`, guidFor(i), filenameFor(i), `/att/${String(i).padStart(64, "0")}.jpg`);
        }
      }
    })();
    db.close();
    db = openEncrypted();
    setDb(db);
  }, 120_000);

  afterAll(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
  });

  it("an incremental sync whose 20k attachments are all stored: every one skipped as already stored, no long stall", async () => {
    const messages: iOSMessage[] = [];
    for (let i = 0; i < MESSAGES; i++) messages.push(makeMessage(i));

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    // The histogram records nothing until its timer has fired once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const result = await (
      iPhoneSyncStorageService as unknown as {
        storeAttachments: (
          userId: string,
          messages: iOSMessage[],
          backupPath: string,
        ) => Promise<{ stored: number; skipped: number; skippedByReason: Record<string, number> }>;
      }
    ).storeAttachments(USER, messages, "/backup-3785");
    await new Promise((resolve) => setTimeout(resolve, 50));
    histogram.disable();
    const maxBlockMs = Math.round(histogram.max / 1e6);
    const wallMs = Date.now() - started;
    // tests/setup.js silences console; the measurement is the point, so stderr.
    process.stderr.write(
      `[3785] storeAttachments ${MESSAGES} msgs / ${MESSAGES / WITH_ATTACHMENT_EVERY} atts: ` +
        `wall=${wallMs}ms maxEventLoopDelay=${maxBlockMs}ms\n`,
    );

    expect(result.stored).toBe(0);
    expect(result.skippedByReason.alreadyStored).toBe(MESSAGES / WITH_ATTACHMENT_EVERY);
    expect(result.skipped).toBe(MESSAGES / WITH_ATTACHMENT_EVERY);
    // Measured on an arm64 Mac: 24 ms with the yields, 344 ms with them removed,
    // 639 ms before this change. A slower CI runner stretches both, so the bound
    // is 250 ms OR a quarter of the run, whichever is larger: without yields the
    // longest stall is most of the run (344 of 413 ms), so it still fails.
    expect(maxBlockMs).toBeLessThan(Math.max(250, wallMs * 0.25));
  }, 180_000);
});
