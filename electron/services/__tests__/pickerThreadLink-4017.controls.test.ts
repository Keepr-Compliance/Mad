/**
 * @jest-environment node
 *
 * BACKLOG-4017 CONTROLS (proposed; red on today's code where noted). A conversation auto-linked to a deal at THREAD level
 * (a communications row with thread_id, message_id NULL) leaves messages.transaction_id
 * NULL, so the attach-texts picker (getMessagesByContact) and its contact roster
 * (MESSAGE_ROSTER_SQL) offer texts the deal already shows.
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
const picker = (): string[] => getMessagesByContact(USER, PHONE).map((m) => m.id).sort();
const roster = (): string[] => (db.prepare(MESSAGE_ROSTER_SQL).all(USER) as Array<{ contact: string }>).map((r) => r.contact);
const dealTexts = async (): Promise<string[]> =>
  (await getCommunicationsWithMessages(TXN, "text")).map((c) => (c as unknown as { message_id?: string; id: string }).message_id ?? c.id).sort();


function seedBase(): void {
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
}

maybe("BACKLOG-4017 controls", () => {
  beforeEach(seedBase);
  afterEach(() => db.close());

  it("K1 reported case: after auto-link the picker and roster no longer offer the deal's texts; the deal still shows them", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    expect(await dealTexts()).toHaveLength(2);
    expect(picker()).toEqual([]);
    expect(roster()).not.toContain(PHONE);
  });

  it("K2 late sibling: a text arriving in the linked thread after the link is not offered either", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    insertText("m-4017-3", "2025-01-03T10:00:00Z"); // what a later sync writes: column NULL
    expect(await dealTexts()).toHaveLength(3);
    expect(picker()).toEqual([]);
    expect(roster()).not.toContain(PHONE);
  });

  it("K3 removing the conversation puts the texts back in the picker", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    await unlinkTextThreads(TXN, [THREAD]);
    expect(picker()).toEqual(IDS);
    expect(roster()).toContain(PHONE);
  });

  it("K4 an EMAIL link row carrying the same thread_id does not hide texts", () => {
    db.prepare("INSERT INTO emails (id, user_id, subject, thread_id) VALUES ('e1', ?, 's', ?)").run(USER, THREAD);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source) VALUES ('ce1', ?, ?, 'e1', ?, 'manual')").run(USER, TXN, THREAD);
    expect(picker()).toEqual(IDS);
    expect(roster()).toContain(PHONE);
  });

  it("K5 a thread row whose deal no longer exists does not hide texts (same rule as the 3908 re-point)", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source) VALUES ('co1', ?, 'gone-deal', ?, 'auto')").run(USER, THREAD);
    expect(picker()).toEqual(IDS);
    expect(roster()).toContain(PHONE);
  });

  it("K7 a text with no thread_id still reaches the picker's fallback read when another thread is linked", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
       VALUES ('m-4017-nt', ?, 'g-nt', 'sms', 'inbound', ?, ?, NULL, '2025-02-01T10:00:00Z', 'text', 'no thread')`,
    ).run(USER, JSON.stringify({ from: PHONE, to: ["me"] }), PHONE.slice(1));
    expect(picker()).toEqual(["m-4017-nt"]);
  });
});
