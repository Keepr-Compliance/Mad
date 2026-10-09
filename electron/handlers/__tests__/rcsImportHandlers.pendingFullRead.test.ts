/**
 * @jest-environment node
 */
/**
 * SR T4 — handler level, REAL SQL (run under Electron's Node): a chat switched
 * back on stays pending until the cache commit SAVES it; a failed or
 * discarded commit leaves it pending (read in full again next time).
 *
 * Mutations that turn this red:
 *   T4a the handler's commit writer not clearing the flag      → "cleared when saved"
 *   T4b the flag cleared outside the chat's commit transaction  → "a failed commit"
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

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

import { setDb } from "../../services/db/core/dbConnection";
import { rcsStagingDbOps, setRcsExclusion } from "../../services/db/syncDbService";
import { listPendingFullRead } from "../../services/db/rcsPendingFullSyncDbService";
import { RcsCacheStaging, type RcsStagingFs } from "../../services/rcsCacheStaging";
import { peopleFrom, rcsChatHash, type RcsIncomingChat } from "../../services/rcsImportStore";

/* eslint-disable @typescript-eslint/no-require-imports */
const { commitWriter } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-t4";
const JOB = "11111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
const NUM = "+15555550101";
const ALL = { floorMs: 0, cap: null, protectedSpans: [] };

let db: DatabaseType;
let tmp: string;
let staging: RcsCacheStaging;

function chat(): RcsIncomingChat {
  return {
    conversationId: "conv-back-on",
    title: "Test Contact A",
    messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hello", sentAt: "2026-09-20T10:00:00.000Z", transport: "rcs" }],
  };
}
const people = peopleFrom([{ name: "Test Contact A", number: NUM }], [NUM]);

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-t4-"));
  const files: RcsStagingFs = {
    stagingRoot: nodePath.join(tmp, "staging"),
    attachmentsDir: nodePath.join(tmp, "attachments"),
    mkdir: async (d) => void (await fs.promises.mkdir(d, { recursive: true })),
    writeSealed: (p, data) => fs.promises.writeFile(p, data),
    exists: async (p) => fs.existsSync(p),
    move: (from, to) => fs.promises.rename(from, to),
    unlink: async (p) => void (await fs.promises.unlink(p).catch(() => undefined)),
    removeDir: async (d) => void (await fs.promises.rm(d, { recursive: true, force: true })),
    listDir: async (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  };
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-t4@example.test', 'google', 'oauth-t4')").run(USER);
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), files);
  // The user switched the chat off, then back on.
  setRcsExclusion(USER, "conv-back-on", true);
  setRcsExclusion(USER, "conv-back-on", false);
  expect(listPendingFullRead(USER)).toEqual(["conv-back-on"]);
  staging.stageChat(JOB, USER, chat(), people, rcsChatHash(people.numbers));
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the pending full read clears only when the commit saves (SR T4)", () => {
  it("cleared when saved (T4a)", async () => {
    await staging.commit(JOB, USER, ALL, commitWriter);
    expect(listPendingFullRead(USER)).toEqual([]);
  });

  // SR F2 (2026-10-04): since 3671 P3 each chat commits in its own
  // transaction and a failure is REPORTED (chatsFailed), not thrown. The
  // chat's write failing inside its transaction rolls back the flag's
  // clearing with it — still pending.
  it("a failed commit leaves it pending (T4b)", async () => {
    const r = await staging.commit(JOB, USER, ALL, commitWriter, {
      perChat: () => {
        throw new Error("disk I/O error");
      },
    });
    expect(r).toMatchObject({ chats: 0, chatsFailed: 1 });
    expect(listPendingFullRead(USER)).toEqual(["conv-back-on"]);
  });

  // The chat SAVED and only the run's own records failed (reported as
  // runRecordFailed): the chat was read in full and is in Keepr, so its flag
  // is rightly cleared (it went with the chat's transaction).
  it("only the run records failed: the chat is saved, its flag cleared (T4c)", async () => {
    const r = await staging.commit(JOB, USER, ALL, commitWriter, () => {
      throw new Error("disk I/O error");
    });
    expect(r).toMatchObject({ chats: 1, chatsFailed: 0, runRecordFailed: true });
    expect(listPendingFullRead(USER)).toEqual([]);
  });

  it("a discarded run (cancel / error) leaves it pending", async () => {
    await staging.discard(JOB);
    expect(listPendingFullRead(USER)).toEqual(["conv-back-on"]);
  });
});
