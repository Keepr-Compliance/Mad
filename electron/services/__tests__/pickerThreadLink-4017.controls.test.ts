/**
 * @jest-environment node
 *
 * BACKLOG-4017 CONTROLS. A conversation auto-linked to a deal at THREAD level (a
 * communications row with thread_id, message_id NULL and email_id NULL) leaves
 * messages.transaction_id NULL. The attach-texts picker (getMessagesByContact) for
 * THAT deal leaves those texts out; every other deal's picker still offers them
 * (founder decision: per deal). The contact roster (MESSAGE_ROSTER_SQL) is per user
 * and unchanged (option B).
 *
 * REAL schema.sql, real driver, every write through the real producer:
 *   1. autoLinkCommunicationsForContact({ contactId, transactionId })   - the deal's auto-link
 *   2. unlinkTextThreads(transactionId, [thread])                       - remove conversation
 * Reads: getMessagesByContact (picker), countContactTextsLinkedToDeal (picker empty
 * state), MESSAGE_ROSTER_SQL, getCommunicationsWithMessages (the deal's Texts tab).
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
import { autoLinkCommunicationsForContact, resetExpansionWatermarksForTests } from "../autoLinkService";
import { countContactTextsLinkedToDeal, getMessagesByContact } from "../db/messageDbService";
import { MESSAGE_ROSTER_SQL } from "../db/messageRosterDb";
import { createThreadCommunicationReference, getCommunicationsWithMessages } from "../db/communicationDbService";
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
const TXN_B = "40170000-0000-4000-8000-0000000000cc"; // pii-allow-uuid: invented, not from any live row
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

const picker = (tx: string = TXN): string[] => getMessagesByContact(USER, PHONE, tx).map((m) => m.id).sort();
const hiddenCount = (tx: string = TXN): number => countContactTextsLinkedToDeal(USER, PHONE, tx);
const roster = (): string[] => (db.prepare(MESSAGE_ROSTER_SQL).all(USER) as Array<{ contact: string }>).map((r) => r.contact);
const dealTexts = async (): Promise<string[]> =>
  (await getCommunicationsWithMessages(TXN, "text")).map((c) => (c as unknown as { message_id?: string; id: string }).message_id ?? c.id).sort();


function seedBase(): void {
  db = new (Database as NonNullable<typeof Database>)(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, '1 Probe Way', 'active', '2020-01-01T00:00:00Z')").run(TXN, USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, '2 Probe Way', 'active', '2020-01-01T00:00:00Z')").run(TXN_B, USER);
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

  it("K1 reported case: after auto-link this deal's picker no longer offers the deal's texts; the deal still shows them", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    expect(await dealTexts()).toHaveLength(2);
    expect(picker()).toEqual([]);
    expect(hiddenCount()).toBe(2);
  });

  it("K8 per deal: a chat linked to deal A stays in deal B's picker", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    expect(picker(TXN)).toEqual([]);
    expect(picker(TXN_B)).toEqual(IDS);
    expect(hiddenCount(TXN_B)).toBe(0);
  });

  it("K9 a chat linked to both deals is left out of both pickers", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('tc2', ?, 'c1')").run(TXN_B);
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN_B });
    expect(db.prepare("SELECT COUNT(*) n FROM communications WHERE thread_id = ? AND message_id IS NULL").get(THREAD)).toEqual({ n: 2 });
    expect(picker(TXN)).toEqual([]);
    expect(picker(TXN_B)).toEqual([]);
  });

  it("K10 the contact roster is per user and unchanged: the contact stays listed after the link", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    expect(roster()).toContain(PHONE);
  });

  it("K2 late sibling: a text arriving in the linked thread after the link is not offered either", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    insertText("m-4017-3", "2025-01-03T10:00:00Z"); // what a later sync writes: column NULL
    expect(await dealTexts()).toHaveLength(3);
    expect(picker()).toEqual([]);
    expect(picker(TXN_B)).toEqual([...IDS, "m-4017-3"]);
  });

  it("K3 removing the conversation puts the texts back in the picker", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    await unlinkTextThreads(TXN, [THREAD]);
    expect(picker()).toEqual(IDS);
    expect(hiddenCount()).toBe(0);
  });

  it("K4 an EMAIL link row carrying the same thread_id does not hide texts", () => {
    db.prepare("INSERT INTO emails (id, user_id, subject, thread_id) VALUES ('e1', ?, 's', ?)").run(USER, THREAD);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source) VALUES ('ce1', ?, ?, 'e1', ?, 'manual')").run(USER, TXN, THREAD);
    expect(picker()).toEqual(IDS);
    expect(hiddenCount()).toBe(0);
  });

  it("K5 a thread row whose deal no longer exists does not hide texts from an open deal's picker", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source) VALUES ('co1', ?, 'gone-deal', ?, 'auto')").run(USER, THREAD);
    expect(picker(TXN)).toEqual(IDS);
    expect(picker(TXN_B)).toEqual(IDS);
  });

  it("K11 another user's thread row for the same chat id and deal id does not hide texts", () => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source) VALUES ('cu1', 'other-user', ?, ?, 'auto')").run(TXN, THREAD);
    expect(picker()).toEqual(IDS);
  });

  it("K7 a text with no thread_id still reaches the picker's fallback read when the contact's only thread is linked", async () => {
    await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN });
    db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
       VALUES ('m-4017-nt', ?, 'g-nt', 'sms', 'inbound', ?, ?, NULL, '2025-02-01T10:00:00Z', 'text', 'no thread')`,
    ).run(USER, JSON.stringify({ from: PHONE, to: ["me"] }), PHONE.slice(1));
    expect(picker()).toEqual(["m-4017-nt"]);
  });

  it("K13 another chat linked to this deal does not hide this contact's unlinked group chat (outer row qualifier)", async () => {
    // A group member's text: only step 2 (thread messages) returns it, the contact
    // fallback does not, so an over-broad step 1 cannot be rescued by the fallback.
    db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
       VALUES ('m-4017-g', ?, 'g-g', 'imessage', 'inbound', ?, '12065550120', ?, '2025-01-04T10:00:00Z', 'text', 'member')`,
    ).run(USER, JSON.stringify({ from: "+12065550120", to: ["me", PHONE] }), THREAD);
    await createThreadCommunicationReference("ios-chat-4017-other", TXN, USER, "auto", 0.9);
    expect(picker()).toEqual([...IDS, "m-4017-g"]);
    expect(hiddenCount()).toBe(0);
  });

  it("K12 empty-state count: zero for a contact with no texts at all", () => {
    expect(countContactTextsLinkedToDeal(USER, "+12065550199", TXN)).toBe(0);
    expect(getMessagesByContact(USER, "+12065550199", TXN)).toEqual([]);
  });
});
