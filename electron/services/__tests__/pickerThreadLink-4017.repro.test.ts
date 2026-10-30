/**
 * @jest-environment node
 *
 * BACKLOG-4017 REPRO, inverted with the fix. A conversation auto-linked to a deal at
 * THREAD level (a communications row with thread_id, message_id NULL) leaves
 * messages.transaction_id NULL. Before the fix the attach-texts picker
 * (getMessagesByContact) offered texts the deal already shows. Now that deal's picker
 * leaves them out. The contact roster (MESSAGE_ROSTER_SQL) is per user and still
 * lists the contact (founder decision, option B).
 *
 * REAL schema.sql, real driver, every write through the real producer:
 *   1. autoLinkCommunicationsForContact({ contactId, transactionId })   - the deal's auto-link
 *   2. expandAttachedThreadsForUser(userId)                             - "thread expansion"
 *   3. unlinkTextThreads(transactionId, [thread])                       - remove conversation
 * Reads: getMessagesByContact, MESSAGE_ROSTER_SQL (picker), getCommunicationsWithMessages
 * (the deal's Texts tab).
 *
 * Real driver: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <file>
 * Reserved 555-01xx numbers, .test addresses. Message row shape: iPhoneSyncStorageService.ts:574-577.
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  const m = { info: noop, warn: noop, error: noop, debug: noop };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../db/core/dbConnection";
import { autoLinkCommunicationsForContact, expandAttachedThreadsForUser, resetExpansionWatermarksForTests } from "../autoLinkService";
import { getMessagesByContact } from "../db/messageDbService";
import { MESSAGE_ROSTER_SQL } from "../db/messageRosterDb";
import { getCommunicationsWithMessages } from "../db/communicationDbService";
import { unlinkTextThreads } from "../transactionTextThreadsService";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[4017] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "40170000-0000-4000-8000-0000000000aa"; // pii-allow-uuid: invented, not from any live row
const TXN = "40170000-0000-4000-8000-0000000000bb"; // pii-allow-uuid: invented, not from any live row
const PHONE = "+12065550117";
const THREAD = "ios-chat-4017";
const IDS = ["m-4017-1", "m-4017-2"];

let db: DatabaseType;

function insertText(id: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
     VALUES (?, ?, ?, 'imessage', 'inbound', ?, ?, ?, ?, 'text', ?)`,
  ).run(id, USER, `g-${id}`, JSON.stringify({ from: PHONE, to: ["me"] }), PHONE.slice(1), THREAD, sentAt, `body ${id}`);
}

const column = (): Array<string | null> =>
  (db.prepare("SELECT transaction_id FROM messages WHERE thread_id = ? ORDER BY id").all(THREAD) as Array<{ transaction_id: string | null }>).map((r) => r.transaction_id);
const picker = (): string[] => getMessagesByContact(USER, PHONE, TXN).map((m) => m.id).sort();
const roster = (): string[] => (db.prepare(MESSAGE_ROSTER_SQL).all(USER) as Array<{ contact: string }>).map((r) => r.contact);
const dealTexts = async (): Promise<string[]> =>
  (await getCommunicationsWithMessages(TXN, "text")).map((c) => (c as unknown as { message_id?: string; id: string }).message_id ?? c.id).sort();

maybe("BACKLOG-4017 repro: a thread-level auto-link leaves the texts in the attach picker", () => {
  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, '1 Probe Way', 'active', '2020-01-01T00:00:00Z')").run(TXN, USER);
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c1', ?, 'Party', 'manual')").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('cp1', 'c1', ?, ?)").run(PHONE, PHONE.slice(1));
    db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('tc1', ?, 'c1')").run(TXN);
    insertText(IDS[0], "2025-01-01T10:00:00Z");
    insertText(IDS[1], "2025-01-02T10:00:00Z");
    setDb(db);
    resetExpansionWatermarksForTests();
  });
  afterEach(() => db.close());

  it("BEFORE: nothing linked -> picker and roster offer the texts", () => {
    expect(column()).toEqual([null, null]);
    expect(picker()).toEqual(IDS);
    expect(roster()).toContain(PHONE);
  });

  it("FIXED: after auto-link the deal shows the texts and its picker no longer offers them", async () => {
    const res = await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    expect(res.messagesLinked).toBe(1); // one thread
    const rows = db.prepare("SELECT message_id, email_id, thread_id FROM communications WHERE transaction_id = ?").all(TXN);
    expect(rows).toEqual([{ message_id: null, email_id: null, thread_id: THREAD }]);
    expect(await dealTexts()).toHaveLength(2); // the deal's Texts tab shows both
    expect(column()).toEqual([null, null]);
    expect(picker()).toEqual([]); // was IDS before BACKLOG-4017
    expect(roster()).toContain(PHONE); // unchanged by design: the roster is per user (option B)
  });

  it("thread expansion still never touches a thread-level link; the picker keys on the thread row instead", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    const exp = await expandAttachedThreadsForUser(USER);
    expect(exp.pairsExamined).toBe(0); // LINKED_THREAD_PAIRS_SQL requires c.message_id IS NOT NULL
    expect(exp.messagesLinked).toBe(0);
    expect(column()).toEqual([null, null]);
    expect(picker()).toEqual([]); // was IDS before BACKLOG-4017
  });

  it("removing the conversation leaves the texts in the picker (unchanged by any fix)", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    await unlinkTextThreads(TXN, [THREAD]);
    expect(db.prepare("SELECT COUNT(*) n FROM communications WHERE transaction_id = ?").get(TXN)).toEqual({ n: 0 });
    expect(column()).toEqual([null, null]);
    expect(picker()).toEqual(IDS);
  });
});
