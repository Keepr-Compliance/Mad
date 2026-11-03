/**
 * @jest-environment node
 *
 * BACKLOG-3343 — an iPhone sync interrupted partway (crash, force-quit, power loss
 * or an error) must not leave a half-saved session behind.
 *
 * Real `persistSyncResult`, real `rollbackSession`, real `recoverInterruptedSessions`,
 * real sqlite driver, shipped `schema.sql`, `foreign_keys = ON`. Session rows are
 * written by the real producers (storeMessages / storeContacts through
 * persistSyncResult; the attachment row by `databaseService.insertAttachment`, the
 * writer storeAttachments calls, with the argument shape it passes).
 *
 * "Next launch" (relaunch()) is a FRESH module registry (jest.isolateModules) on a
 * SECOND connection to the same database file, with the writer connection left
 * OPEN. Nothing held in memory by the first registry (liveSessions, a Map, a
 * pending promise) can reach it — only what is committed to the file. The
 * process-death version (SIGKILL) is iPhoneSyncStorageService.sigkillRestart-3343.
 *
 * Controls (SR plan review pm_comments 90d03930 on BACKLOG-3343):
 *   C1 crash after messages            C2 crash during attachments
 *   C3 finished session kept           C4 error partway rolls back
 *   C5 failed error-path rollback is finished at the next launch
 *   C6 a session live in this process is never swept
 *   C7 rows from older builds (no marker) are never swept
 *   C8 a throw AFTER the commit point keeps the sync and reports success
 *   C9 contact matching asked for mid-sweep runs only after the rows are gone
 *   C10 a sweep whose marker read throws rejects (authHandlers catches it)
 *
 * Runs on the Node-ABI driver, which `npm test` (and so CI) switches to. Locally:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Without a loadable driver the suite is skipped with a warning — except on CI,
 * where it fails, so it can never go green by not running.
 */

import * as os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const mockUserData = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3343-ud-"));
jest.mock("electron", () => ({ app: { getPath: jest.fn(() => mockUserData) } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import { setDb } from "../db/core/dbConnection";
import databaseService from "../databaseService";
import * as scheduler from "../contactLinkingScheduler";
import * as openSessions from "../db/iphoneSyncOpenSessionDbService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";
import type { iOSContact } from "../../types/iosContacts";

const USER = "user-3343";
const SESSION = "session-3343";
const DONE = "session-3343-done";
const OTHER = "session-3343-b";

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(
      nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    );
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    if (process.env.CI) {
      throw new Error(`[3343] real sqlite driver must load on CI: ${String(error).slice(0, 200)}`);
    }
    process.stderr.write(
      `[3343] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

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
  } as unknown as iOSMessage;
}
function makeConversation(messages: iOSMessage[]): iOSConversation {
  return {
    chatId: 1,
    chatIdentifier: "+15555550112",
    participants: ["+15555550112"],
    messages,
    lastMessage: new Date("2024-01-01T10:00:00Z"),
    isGroupChat: false,
  } as iOSConversation;
}
function makeContact(id: number): iOSContact {
  return {
    id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    displayName: `First${id} Last${id}`,
    organization: null,
    phoneNumbers: [{ label: "mobile", number: `+1555555011${id}`, normalizedNumber: `+1555555011${id}` }],
    emails: [{ label: "home", email: `test${id}@example.test` }],
  } as iOSContact;
}
/** One sync's payload: two messages (`<tag>-a`, `<tag>-b`) and one contact. */
function result(tag: string, contactId: number, withAttachment = false): SyncResult {
  const messages = [makeMessage(1, `${tag}-a`), makeMessage(2, `${tag}-b`)];
  if (withAttachment) {
    (messages[0] as unknown as { attachments: unknown[] }).attachments = [{ filename: "a.jpg", mimeType: "image/jpeg" }];
  }
  return {
    success: true,
    messages,
    contacts: [makeContact(contactId)],
    conversations: [makeConversation(messages)],
    error: null,
    duration: 1,
  } as unknown as SyncResult;
}

interface Rows {
  attachments: string[];
  messages: string[];
  contacts: string[];
}

let db: DatabaseType;
let reader: DatabaseType;
let dir: string;
let file: string;

/** Committed rows of one session, as id sets (read through a separate connection). */
function rows(session: string): Rows {
  const ids = (q: string) => (reader.prepare(q).all(session) as Array<{ id: string }>).map((r) => r.id).sort();
  return {
    attachments: ids("SELECT id FROM attachments WHERE sync_session_id = ?"),
    messages: ids("SELECT external_id AS id FROM messages WHERE sync_session_id = ?"),
    contacts: ids("SELECT external_record_id AS id FROM external_contacts WHERE sync_session_id = ?"),
  };
}
const EMPTY: Rows = { attachments: [], messages: [], contacts: [] };
const markers = (): string[] =>
  (reader.prepare("SELECT session_id FROM iphone_sync_open_sessions ORDER BY session_id").all() as Array<{
    session_id: string;
  }>).map((r) => r.session_id);

function open(): void {
  dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3343-db-"));
  file = nodePath.join(dir, "mad.db");
  db = new Driver!(file) as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Production opens every connection with foreign_keys ON (databaseService.ts).
  db.pragma("foreign_keys = ON");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
    USER,
    "u3343@example.test",
    "oauth-3343",
  );
  setDb(db);
  reader = new Driver!(file, { readonly: true }) as DatabaseType;
}

/** A finished session that every sweep must leave alone. */
async function finishedSession(): Promise<void> {
  const p = await iPhoneSyncStorageService.persistSyncResult(USER, result("done", 9), undefined, undefined, DONE);
  if (!p.success || p.messagesStored !== 2) throw new Error(`finished fixture not stored: ${JSON.stringify(p)}`);
}
const DONE_ROWS: Rows = { attachments: [], messages: ["done-a", "done-b"], contacts: ["9"] };

/** One attachment row + its file for `session`, by the writer storeAttachments calls. */
function addAttachment(session: string, guid: string): string {
  const msgId = (db.prepare("SELECT id FROM messages WHERE external_id = ?").get(guid) as { id: string }).id;
  const attDir = nodePath.join(mockUserData, "message-attachments");
  nodeFs.mkdirSync(attDir, { recursive: true });
  const filePath = nodePath.join(attDir, `${session}.jpg`);
  nodeFs.writeFileSync(filePath, "x");
  databaseService.insertAttachment({
    id: `att-${session}`,
    messageId: msgId,
    externalMessageId: guid,
    filename: "IMG_3343.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1,
    storagePath: filePath,
    sessionId: session,
  });
  return filePath;
}

interface Relaunched {
  svc: typeof iPhoneSyncStorageService;
  dbService: typeof databaseService;
  scheduler: typeof scheduler;
  conn: DatabaseType;
}
/** A new process: fresh module registry, second connection, writer left open. */
function relaunched(): Relaunched {
  const conn = new Driver!(file) as DatabaseType;
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  let out!: Relaunched;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    require("../db/core/dbConnection").setDb(conn);
    out = {
      svc: require("../iPhoneSyncStorageService").iPhoneSyncStorageService,
      dbService: require("../databaseService").default,
      scheduler: require("../contactLinkingScheduler"),
      conn,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out;
}
const relaunched_: DatabaseType[] = [];
async function relaunch(): Promise<{ found: number; recovered: number; durationMs: number }> {
  const r = relaunched();
  relaunched_.push(r.conn);
  return r.svc.recoverInterruptedSessions();
}

const tick = () => new Promise((r) => setTimeout(r, 200));
type Svc = Record<string, (...a: unknown[]) => unknown>;
const svc = iPhoneSyncStorageService as unknown as Svc;

afterEach(() => {
  jest.restoreAllMocks();
  scheduler.__resetContactLinkingScheduler();
  for (const c of relaunched_.splice(0)) {
    try {
      c.close();
    } catch {
      /* closed */
    }
  }
  try {
    reader?.close();
  } catch {
    /* closed */
  }
  try {
    db?.close();
  } catch {
    /* closed */
  }
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  nodeFs.rmSync(mockUserData, { recursive: true, force: true });
});

maybe("BACKLOG-3343 interrupted iPhone sync sessions", () => {
  jest.setTimeout(30000);

  it("C1 crash after messages: the next launch removes exactly that session (rows + attachment file)", async () => {
    open();
    await finishedSession();
    jest.spyOn(svc, "storeContacts").mockImplementation(() => new Promise(() => {}));
    void iPhoneSyncStorageService.persistSyncResult(USER, result("s1", 1), undefined, undefined, SESSION);
    await tick();
    const attFile = addAttachment(SESSION, "s1-a");
    const before = rows(SESSION);
    expect(before).toEqual({ attachments: [`att-${SESSION}`], messages: ["s1-a", "s1-b"], contacts: [] });
    expect(markers()).toEqual([SESSION]);
    expect(nodeFs.existsSync(attFile)).toBe(true);

    const r = await relaunch();

    expect(r).toMatchObject({ found: 1, recovered: 1 });
    expect(rows(SESSION)).toEqual(EMPTY);
    expect(markers()).toEqual([]);
    expect(nodeFs.existsSync(attFile)).toBe(false);
    expect(rows(DONE)).toEqual(DONE_ROWS);
  });

  it("C2 crash during attachments: the next launch removes messages, contacts and the attachment", async () => {
    open();
    jest.spyOn(svc, "storeAttachments").mockImplementation(() => new Promise(() => {}));
    void iPhoneSyncStorageService.persistSyncResult(USER, result("s2", 1, true), "/no/backup", undefined, SESSION);
    await tick();
    const attFile = addAttachment(SESSION, "s2-a");
    expect(rows(SESSION)).toEqual({ attachments: [`att-${SESSION}`], messages: ["s2-a", "s2-b"], contacts: ["1"] });

    await relaunch();

    expect(rows(SESSION)).toEqual(EMPTY);
    expect(markers()).toEqual([]);
    expect(nodeFs.existsSync(attFile)).toBe(false);
  });

  it("C3 a finished session is never removed, with no handler code after it", async () => {
    open();
    const p = await iPhoneSyncStorageService.persistSyncResult(USER, result("s3", 1), undefined, undefined, SESSION);
    expect(p.success).toBe(true);
    expect(markers()).toEqual([]);

    const r = await relaunch();

    expect(r.found).toBe(0);
    expect(rows(SESSION)).toEqual({ attachments: [], messages: ["s3-a", "s3-b"], contacts: ["1"] });
  });

  it("C4 an error partway rolls the session back, closes the marker, and says 'error'", async () => {
    open();
    jest.clearAllMocks();
    const rb = jest.spyOn(svc, "rollbackSession");
    jest.spyOn(svc, "storeContacts").mockRejectedValue(new Error("injected contacts failure") as never);

    const p = await iPhoneSyncStorageService.persistSyncResult(USER, result("s4", 1), undefined, undefined, SESSION);

    expect(p.success).toBe(false);
    expect(rows(SESSION)).toEqual(EMPTY);
    expect(markers()).toEqual([]);
    expect(rb.mock.calls.map((c) => c[2])).toEqual(["error"]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sentry = require("@sentry/electron/main") as { captureMessage: jest.Mock };
    expect(sentry.captureMessage.mock.calls.map((c) => c[0])).toEqual(["iPhone sync error - rolling back"]);
  });

  it("C5 a rollback that fails on the error path leaves the marker; the next launch finishes it", async () => {
    open();
    jest.spyOn(svc, "storeContacts").mockRejectedValue(new Error("injected contacts failure") as never);
    jest.spyOn(databaseService, "deleteMessagesBySessionId").mockImplementationOnce(() => {
      throw new Error("injected rollback failure");
    });

    const p = await iPhoneSyncStorageService.persistSyncResult(USER, result("s5", 1), undefined, undefined, SESSION);

    expect(p.success).toBe(false);
    expect(rows(SESSION)).toEqual({ attachments: [], messages: ["s5-a", "s5-b"], contacts: [] });
    expect(markers()).toEqual([SESSION]);

    const r = await relaunch();

    expect(r).toMatchObject({ found: 1, recovered: 1 });
    expect(rows(SESSION)).toEqual(EMPTY);
    expect(markers()).toEqual([]);
  });

  it("C6 a session persisting in this process is never swept", async () => {
    open();
    jest.spyOn(svc, "storeContacts").mockImplementation(() => new Promise(() => {}));
    void iPhoneSyncStorageService.persistSyncResult(USER, result("s6", 1), undefined, undefined, SESSION);
    await tick();
    expect(markers()).toEqual([SESSION]);

    const r = await iPhoneSyncStorageService.recoverInterruptedSessions();

    expect(r.found).toBe(0);
    expect(rows(SESSION).messages).toEqual(["s6-a", "s6-b"]);
    expect(markers()).toEqual([SESSION]);
    (iPhoneSyncStorageService as unknown as { liveSessions: Set<string> }).liveSessions.clear();
  });

  it("C7 rows from older builds (sync_session_id set, no marker) are never swept", async () => {
    open();
    await iPhoneSyncStorageService.persistSyncResult(USER, result("s7", 1), undefined, undefined, SESSION);
    db.prepare("DELETE FROM iphone_sync_open_sessions").run();

    const r = await relaunch();

    expect(r.found).toBe(0);
    expect(rows(SESSION)).toEqual({ attachments: [], messages: ["s7-a", "s7-b"], contacts: ["1"] });
  });

  it("C8 a throw after the commit point keeps the sync, closes the marker and reports success", async () => {
    open();
    const rb = jest.spyOn(svc, "rollbackSession");
    // DEFENSIVE (SR (b)): no post-commit throw is known to be emittable today, so the
    // throw is synthetic — from the first statement after the "finished" marker.
    const injected = jest.spyOn(scheduler, "requestContactLinking").mockImplementation(() => {
      throw new Error("injected post-commit failure");
    });

    const p = await iPhoneSyncStorageService.persistSyncResult(USER, result("s8", 1), undefined, undefined, SESSION);

    expect(injected).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ success: true, messagesStored: 2, contactsStored: 1 });
    expect(rb).not.toHaveBeenCalled();
    expect(rows(SESSION)).toEqual({ attachments: [], messages: ["s8-a", "s8-b"], contacts: ["1"] });
    expect(markers()).toEqual([]);
  });

  it("C9 contact matching asked for mid-sweep runs only after every interrupted session is gone", async () => {
    open();
    jest.spyOn(svc, "storeAttachments").mockImplementation(() => new Promise(() => {}));
    void iPhoneSyncStorageService.persistSyncResult(USER, result("s9a", 1, true), "/no/backup", undefined, SESSION);
    void iPhoneSyncStorageService.persistSyncResult(USER, result("s9b", 2, true), "/no/backup", undefined, OTHER);
    await tick();
    expect(rows(SESSION).contacts).toEqual(["1"]);
    expect(rows(OTHER).contacts).toEqual(["2"]);
    expect(markers()).toEqual([SESSION, OTHER].sort());

    const next = relaunched();
    relaunched_.push(next.conn);
    const seen: Rows[] = [];
    next.scheduler.configureContactLinking({
      run: () => {
        const a = rows(SESSION);
        const b = rows(OTHER);
        seen.push({
          attachments: [...a.attachments, ...b.attachments],
          messages: [...a.messages, ...b.messages],
          contacts: [...a.contacts, ...b.contacts],
        });
      },
    });
    // A renderer read asks for an immediate pass while the sweep is rolling back the
    // FIRST session (db-ready has already been broadcast).
    const realDelete = next.dbService.deleteMessagesBySessionId.bind(next.dbService);
    jest.spyOn(next.dbService, "deleteMessagesBySessionId").mockImplementation((u: string, s: string) => {
      if (seen.length === 0) void next.scheduler.runContactLinkingNow(USER);
      return realDelete(u, s);
    });

    const r = await next.svc.recoverInterruptedSessions();
    expect(r).toMatchObject({ found: 2, recovered: 2 });
    // The held pass is re-armed on release and fires after the quiet period.
    await new Promise((res) => setTimeout(res, scheduler.QUIET_PERIOD_MS + 400));

    expect(seen).toEqual([EMPTY]);
  });

  it("C10 a sweep whose marker read throws rejects, so the caller can report it", async () => {
    open();
    jest.spyOn(openSessions, "listOpen").mockImplementation(() => {
      throw new Error("injected marker read failure");
    });
    await expect(iPhoneSyncStorageService.recoverInterruptedSessions()).rejects.toThrow("injected marker read failure");
  });
});
