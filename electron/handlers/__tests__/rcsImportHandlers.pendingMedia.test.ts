/**
 * @jest-environment node
 */
/**
 * SR M (T4-style) — handler level, REAL SQL (run under Electron's Node): the
 * pending media read (a media toggle switched ON) stays pending until the
 * cache commit SAVES; a failed or discarded commit leaves it pending, so the
 * next Sync reads every chat for media again.
 *
 * Mutations that turn this red:
 *   PM1 the commit step not clearing the flag                   → "cleared when saved"
 *   PM2 a rolled-back commit (failed after the clear) keeping it cleared → "a failed commit"
 *   PM3 cleared for a run that did not ask for the media read    → "not asked"
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
import { rcsStagingDbOps } from "../../services/db/syncDbService";
import { hasPendingMediaRead, setRcsMediaOptions } from "../../services/db/rcsMediaDbService";
import { RcsCacheStaging, type RcsStagingFs } from "../../services/rcsCacheStaging";
import { peopleFrom, rcsChatHash, type RcsIncomingChat } from "../../services/rcsImportStore";

/* eslint-disable @typescript-eslint/no-require-imports */
const { commitWriter, cacheCommitInsideTransaction } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-pm";
const JOB = "21111111-2222-4333-8444-555555555555"; // pii-allow-uuid: invented, not from any live row
const READ = { fullRead: true, floorISO: "2026-08-01T00:00:00.000Z", mediaPending: true };
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
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-pm-"));
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
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-pm@example.test', 'google', 'oauth-pm')").run(USER);
  setDb(db);
  staging = new RcsCacheStaging(rcsStagingDbOps(), files);
  // The user switched "Download photos from all chats" off, then back on.
  setRcsMediaOptions(USER, { photosAllChats: false });
  setRcsMediaOptions(USER, { photosAllChats: true });
  expect(hasPendingMediaRead(USER)).toBe(true);
  staging.stageChat(JOB, USER, chat(), people, rcsChatHash(people.numbers));
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the pending media read clears only when the commit saves (SR M)", () => {
  const inside = (read: typeof READ | undefined) => () => cacheCommitInsideTransaction(USER, read, true, 0, "since");

  it("cleared when saved (PM1)", async () => {
    await staging.commit(JOB, USER, ALL, commitWriter, inside(READ));
    expect(hasPendingMediaRead(USER)).toBe(false);
  });

  it("a failed commit leaves it pending (PM2)", async () => {
    // 3671 P3: the run's records are their own transaction; its failure is
    // reported (the chats stay) and rolls the clear back.
    const r = await staging.commit(JOB, USER, ALL, commitWriter, () => {
      inside(READ)();
      throw new Error("disk I/O error");
    });
    expect(r.runRecordFailed).toBe(true);
    expect(hasPendingMediaRead(USER)).toBe(true);
  });

  it("a discarded run (cancel / error) leaves it pending", async () => {
    await staging.discard(JOB);
    expect(hasPendingMediaRead(USER)).toBe(true);
  });

  it("a run that was not the media read leaves it pending (PM3)", async () => {
    await staging.commit(JOB, USER, ALL, commitWriter, inside({ ...READ, mediaPending: false }));
    expect(hasPendingMediaRead(USER)).toBe(true);
  });
});
