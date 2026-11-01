/**
 * @jest-environment node
 *
 * BACKLOG-2552 — cancelling an iPhone sync must undo the WHOLE session or none of it.
 *
 * Real `rollbackSession`, real sqlite driver, shipped `schema.sql`. Session rows are
 * written by the real producers: messages + contacts by the real `persistSyncResult`
 * (storeMessages / storeContacts, no backupPath), the attachment row by the real
 * writer storeAttachments calls (`databaseService.insertAttachment`) with the same
 * argument shape it passes (iPhoneSyncStorageService.ts storeAttachments).
 *
 * Every INSERT/UPDATE/DELETE statement prepared during the rollback is instrumented:
 * it records `db.inTransaction`, the COMMITTED state seen through a second
 * connection (what a process death at that instant would leave), and throws at
 * write k.
 *
 * This suite is the load-bearing control for 2552. writeAtomicity.guard cannot
 * see a two-transaction wrong fix (any unit containing `dbTransaction` clears it).
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

const mockUserData = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-2552-ud-"));
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
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";
import type { iOSContact } from "../../types/iosContacts";

const USER = "user-2552";
const SESSION = "session-2552";

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
      throw new Error(`[2552] real sqlite driver must load on CI: ${String(error).slice(0, 200)}`);
    }
    process.stderr.write(
      `[2552] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
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
    phoneNumbers: [{ label: "mobile", number: "+15555550112", normalizedNumber: "+15555550112" }],
    emails: [{ label: "home", email: `test${id}@example.test` }],
  } as iOSContact;
}

interface State { attachments: number; messages: number; contacts: number }
interface WriteRecord { sql: string; inTransaction: boolean; committedBefore: State }

let db: DatabaseType;
let reader: DatabaseType;
let dir: string;
let attachmentFile: string;

function committed(r: DatabaseType): State {
  const n = (q: string) => (r.prepare(q).get(SESSION) as { c: number }).c;
  return {
    attachments: n("SELECT COUNT(*) c FROM attachments WHERE sync_session_id = ?"),
    messages: n("SELECT COUNT(*) c FROM messages WHERE sync_session_id = ?"),
    contacts: n("SELECT COUNT(*) c FROM external_contacts WHERE sync_session_id = ?"),
  };
}

async function seed(): Promise<void> {
  dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-2552-db-"));
  const file = nodePath.join(dir, "mad.db");
  db = new Driver!(file) as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Production opens every connection with foreign_keys ON (databaseService.ts:927).
  db.pragma("foreign_keys = ON");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
    USER, "u2552@example.test", "oauth-2552",
  );
  setDb(db);

  const messages = [makeMessage(1, "guid-2552-a"), makeMessage(2, "guid-2552-b")];
  const result: SyncResult = {
    success: true,
    messages,
    contacts: [makeContact(1)],
    conversations: [makeConversation(messages)],
    error: null,
    duration: 1,
  } as unknown as SyncResult;
  const persisted = await iPhoneSyncStorageService.persistSyncResult(USER, result, undefined, undefined, SESSION);
  if (!persisted.success || persisted.messagesStored !== 2 || persisted.contactsStored !== 1) {
    throw new Error(`producer did not store the fixture: ${JSON.stringify(persisted)}`);
  }

  const msgId = (db.prepare("SELECT id FROM messages WHERE external_id = ?").get("guid-2552-a") as { id: string }).id;
  const attDir = nodePath.join(mockUserData, "message-attachments");
  nodeFs.mkdirSync(attDir, { recursive: true });
  attachmentFile = nodePath.join(attDir, "deadbeef2552.jpg");
  nodeFs.writeFileSync(attachmentFile, "x");
  databaseService.insertAttachment({
    id: "att-2552",
    messageId: msgId,
    externalMessageId: "guid-2552-a",
    filename: "IMG_2552.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1,
    storagePath: attachmentFile,
    sessionId: SESSION,
  });

  reader = new Driver!(file, { readonly: true }) as DatabaseType;
  const seeded = committed(reader);
  if (seeded.attachments !== 1 || seeded.messages !== 2 || seeded.contacts !== 1) {
    throw new Error(`fixture not as expected: ${JSON.stringify(seeded)}`);
  }
}

function instrument(throwAtWrite: number | null): WriteRecord[] {
  const writes: WriteRecord[] = [];
  const originalPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (sqlText: string) => {
    const stmt = originalPrepare(sqlText);
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sqlText)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...args: unknown[]) => {
        const index = writes.length;
        writes.push({ sql: sqlText.trim().slice(0, 40), inTransaction: db.inTransaction, committedBefore: committed(reader) });
        if (throwAtWrite === index) throw new Error(`injected crash at write ${index}`);
        return realRun(...args);
      };
    }
    return stmt;
  };
  return writes;
}

const rollback = (): Promise<void> =>
  (iPhoneSyncStorageService as unknown as { rollbackSession: (u: string, s?: string) => Promise<void> })
    .rollbackSession(USER, SESSION);

afterEach(() => {
  jest.clearAllMocks();
  reader?.close();
  db?.close();
  nodeFs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => nodeFs.rmSync(mockUserData, { recursive: true, force: true }));

maybe("BACKLOG-2552: rollbackSession under a crash at write k", () => {
  it("no crash: the whole session is removed", async () => {
    await seed();
    const writes = instrument(null);
    await rollback();
    process.stderr.write(`[2552] clean: ${writes.length} writes ${JSON.stringify(writes.map((w) => [w.sql, w.inTransaction]))}\n`);
    expect(committed(reader)).toEqual({ attachments: 0, messages: 0, contacts: 0 });
    expect(nodeFs.existsSync(attachmentFile)).toBe(false);
  });

  it.each([0, 1, 2, 3, 4])("crash at write %i: the session is either fully present or fully gone", async (k) => {
    await seed();
    const writes = instrument(k);
    let threw = false;
    try { await rollback(); } catch { threw = true; }
    const after = committed(reader);
    const fileThere = nodeFs.existsSync(attachmentFile);
    process.stderr.write(`[2552] crash@${k}: after=${JSON.stringify(after)} file=${fileThere} threw=${threw} ` +
      `inTx=${JSON.stringify(writes.map((w) => w.inTransaction))}\n`);
    const full = { attachments: 1, messages: 2, contacts: 1 };
    // A failed rollback must not surface as a sync error: the caller returns the
    // normal "cancelled" result only if rollbackSession resolves.
    expect(threw).toBe(false);
    expect(after).toEqual(full);
    // The row still points at the file, so the file must still be on disk.
    expect(fileThere).toBe(true);
    // A failed rollback is reported, not only logged.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sentry = require("@sentry/electron/main") as { captureException: jest.Mock };
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
