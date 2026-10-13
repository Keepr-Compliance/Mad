/**
 * @jest-environment node
 */
/**
 * BACKLOG-3924 S1 — the HANDLER's real cache-commit writer (`commitWriter`)
 * never reads a user's whole message table or every attachment record.
 *
 * Drives RcsCacheStaging.commit with the exported `commitWriter` over the REAL
 * SQL (production schema). databaseService is a pass-through to the real
 * db functions, with the two full-table reads spied. A handler that wires a
 * keyed field back to a full read (e.g. `getMessageIdsByExternalIds: (u) =>
 * databaseService.getMessageIdMap(u)`) turns this red.
 *
 * Fixture shape transcribed from rcsCacheStaging-3658.test.ts.
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

const fullReads = { getMessageIdMap: 0, getExistingAttachmentRecords: 0 };

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => require("os").tmpdir(), getAppPath: () => require("os").tmpdir() },
  ipcMain: { handle: jest.fn() },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn() },
}));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: async () => null } }));
jest.mock("../../services/databaseService", () => {
  const syncDb = jest.requireActual("../../services/db/syncDbService");
  const people = jest.requireActual("../../services/db/rcsChatPeopleDbService");
  return {
    __esModule: true,
    default: {
      batchInsertMessages: (rows: unknown, n: number) => syncDb.batchInsertMessages(rows, n),
      insertReactionRows: (rows: unknown) => syncDb.insertReactionRows(rows),
      findRcsContentDuplicates: (u: string, rows: unknown) => syncDb.findRcsContentDuplicates(u, rows),
      recordRcsChatPeople: (...a: unknown[]) => people.recordRcsChatPeople(...a),
      recordRcsThreadName: (...a: unknown[]) => people.recordRcsThreadName(...a),
      getMessageIdsByExternalIds: (u: string, ids: string[]) => syncDb.getMessageIdsByExternalIds(u, ids),
      getExistingAttachmentRecordsForMessages: (ids: string[]) => syncDb.getExistingAttachmentRecordsForMessages(ids),
      insertAttachment: (p: unknown) => syncDb.insertAttachment(p),
      markMessageHasAttachments: (id: string) => syncDb.markMessageHasAttachments(id),
      getMessageIdMap: (u: string) => {
        fullReads.getMessageIdMap += 1;
        return syncDb.getMessageIdMap(u);
      },
      getExistingAttachmentRecords: () => {
        fullReads.getExistingAttachmentRecords += 1;
        return syncDb.getExistingAttachmentRecords();
      },
    },
  };
});

import { setDb } from "../../services/db/core/dbConnection";
import { rcsStagingDbOps } from "../../services/db/syncDbService";
import { peopleFrom, rcsChatHash, type RcsIncomingMessage } from "../../services/rcsImportStore";
import { RcsCacheStaging, type RcsStagingFs } from "../../services/rcsCacheStaging";

/* eslint-disable @typescript-eslint/no-require-imports */
const { commitWriter } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3924h";
const JOB = "33333333-4444-4555-8666-777777777777"; // pii-allow-uuid: invented, not from any live row
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

let db: DatabaseType;
let tmp: string;

beforeEach(() => {
  fullReads.getMessageIdMap = 0;
  fullReads.getExistingAttachmentRecords = 0;
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-handler-3924-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3924h@example.test', 'google', 'oauth-3924h')").run(USER);
  setDb(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("S1: a commit over several chats (with images) never reads the whole message or attachment table", async () => {
  const files: RcsStagingFs = {
    stagingRoot: nodePath.join(tmp, "rcs-cache-staging"),
    attachmentsDir: nodePath.join(tmp, "message-attachments"),
    mkdir: async (d) => {
      await fs.promises.mkdir(d, { recursive: true });
    },
    writeSealed: (p, data) => fs.promises.writeFile(p, data),
    exists: async (p) => fs.existsSync(p),
    move: (from, to) => fs.promises.rename(from, to),
    unlink: async (p) => {
      await fs.promises.unlink(p).catch(() => undefined);
    },
    removeDir: async (d) => {
      await fs.promises.rm(d, { recursive: true, force: true });
    },
    listDir: async (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  };
  const staging = new RcsCacheStaging(rcsStagingDbOps(), files);
  const N = 5;
  for (let c = 0; c < N; c++) {
    const n = `+1555555${String(2000 + c)}`;
    const people = peopleFrom([{ name: `Test Contact ${c}`, number: n }], [n]);
    const hash = rcsChatHash(people.numbers);
    const messages: RcsIncomingMessage[] = [0, 1, 2].map((i) => ({
      msgId: `c${c}m${i}`,
      direction: "inbound",
      sender: "x",
      text: `text c${c}m${i}`,
      sentAt: new Date(Date.UTC(2026, 8, 1) + (c * 3 + i) * 60000).toISOString(),
      transport: "rcs",
      ...(i === 0 ? { images: 1 } : {}),
    }));
    staging.stageChat(JOB, USER, { conversationId: `conv-${c}`, title: `Test Contact ${c}`, messages }, people, hash);
    await staging.stageImage(JOB, { conversationId: `conv-${c}`, msgId: `c${c}m0`, index: 0, mimeType: "image/png", base64: PNG }, hash);
  }

  const r = await staging.commit(JOB, USER, { floorMs: 0, cap: null, protectedSpans: [] }, commitWriter);

  expect(r).toMatchObject({ chats: N, stored: N * 3, imagesStored: N, imagesNoMessage: 0, chatsFailed: 0 });
  expect(fullReads).toEqual({ getMessageIdMap: 0, getExistingAttachmentRecords: 0 });
});
