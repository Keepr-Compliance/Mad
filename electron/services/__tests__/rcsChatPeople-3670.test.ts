/**
 * @jest-environment node
 */
/**
 * BACKLOG-3670 — people found in texts (Google Messages), against the REAL SQL
 * on the production schema. Run under Electron's Node (real SQLite build).
 *
 * Mutation controls (each turns a test red):
 *   P1 people not recorded by the cache commit / the transaction Sync     → "recorded"
 *   P2 a group keyed on one member, or a chat keyed on a name             → "one row per member number"
 *   P3 suppression by name (the 2618 rule) applied to number rows         → "never by name"
 *   P4 a contact's phone (last 10, any format) or a REMOVED contact not suppressing → "suppressed by number"
 *   P5 a Don't-sync chat / the own number not excluded                    → "Don't-sync and own number"
 *   P6 Force re-import / auto-delete not clearing the people              → "cleared with the texts"
 *   P7 the macOS list changed for a user with no Google Messages people  → "exactly the old list"
 *   P8 an imported msg_tel person loses the phone (twin not suppressed)   → "import keeps the phone"
 *   P9 the switch off still showing them                                  → "only when asked"
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop }, logService: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../contactLinkingScheduler", () => ({ __esModule: true, requestContactLinking: jest.fn() }));

import { setDb } from "../db/core/dbConnection";
import {
  batchInsertMessages,
  findRcsContentDuplicates,
  getMessageIdMap,
  insertReactionRows,
  rcsAutoDeleteDbOps,
  rcsClearDbOps,
  repointLegacyRcsRemoval,
} from "../db/syncDbService";
import { chatPeopleRows, getTextDerivedPeople, recordRcsChatPeople } from "../db/rcsChatPeopleDbService";
import { createContactsBatch, getImportedContactsByUserId, searchContactsForSelection } from "../db/contactDbService";
import { importChat, peopleFrom, rcsChatHash, storeCacheChatSync, type RcsIncomingChat } from "../rcsImportStore";
import { clearGoogleMessagesWebData, clearUnlinkedOldChats } from "../rcsClearService";
import { shapeImportValues } from "../../utils/contactImportValues";
import { validateContactData } from "../../utils/validation";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3670";
const NUM_A = "+15555550101";
const NUM_B = "+15555550102";
const NUM_C = "+15555550103";
const OWN = "+15555550100";

let db: DatabaseType;

const record = (u: string, h: string, rows: Array<{ number: string; name: string | null }>, at: string | null) =>
  recordRcsChatPeople(u, h, rows, at);

const storeDeps = {
  batchInsertMessages,
  getMessageIdMap,
  insertReactionRows,
  findContentDuplicates: findRcsContentDuplicates,
  repointLegacyRemoval: repointLegacyRcsRemoval,
  recordPeople: record,
};

function chat(conv: string, title: string, sentAt = "2026-09-20T10:00:00.000Z"): RcsIncomingChat {
  return { conversationId: conv, title, messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hello", sentAt, transport: "rcs" }] };
}

const ids = (userId = USER) => getTextDerivedPeople(userId).map((p) => p.id);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-3670@example.test', 'google', 'oauth-3670')").run(USER);
  setDb(db);
});

afterEach(() => {
  db?.close();
});

function addContact(id: string, name: string, phoneE164: string, display: string | null, removed = false): void {
  db.prepare(
    `INSERT INTO contacts (id, user_id, display_name, source, is_imported${removed ? ", removed_at" : ""}) VALUES (?, ?, ?, 'manual', 1${removed ? ", '2026-09-01T00:00:00.000Z'" : ""})`,
  ).run(id, USER, name);
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES (?, ?, ?, ?)").run(`p-${id}`, id, phoneE164, display);
}

describe("people found in texts (BACKLOG-3670)", () => {
  it("chatPeopleRows: one row per member number; 1:1 title fallback; never a name as a key (P2)", () => {
    const group = peopleFrom([{ name: "Test Contact A", number: NUM_A }, { name: "", number: NUM_B }], [NUM_A, NUM_B]);
    expect(chatPeopleRows(group, "Test Group")).toEqual([
      { number: NUM_A, name: "Test Contact A" },
      { number: NUM_B, name: null }, // a group title is never a member's name
    ]);
    const solo = peopleFrom([{ name: "", number: NUM_C }], [NUM_C]);
    expect(chatPeopleRows(solo, "Test Contact C")).toEqual([{ number: NUM_C, name: "Test Contact C" }]);
    expect(chatPeopleRows(solo, "(555) 555-0103")).toEqual([{ number: NUM_C, name: null }]);
    expect(chatPeopleRows({ numbers: ["Test Shop", "72975"], names: [] }, "x")).toEqual([]);
  });

  it("recorded by the cache commit and by a transaction Sync (P1)", async () => {
    storeCacheChatSync(chat("conv-a", "Test Contact A"), USER, storeDeps, peopleFrom([{ name: "Test Contact A", number: NUM_A }], [NUM_A]));
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('tx-1', ?, '1 Test Street')").run(USER);
    await importChat(chat("conv-b", "Test Contact B"), "tx-1", {
      ...storeDeps,
      getTransactionUserId: async () => USER,
      linkMessages: async () => undefined,
      linkWithoutCount: async () => undefined,
    }, peopleFrom([{ name: "Test Contact B", number: NUM_B }], [NUM_B]));
    const people = getTextDerivedPeople(USER);
    expect(people.map((p) => [p.id, p.display_name, p.phone, p.source, p.is_message_derived])).toEqual([
      ["msg_tel_+15555550101", "Test Contact A", NUM_A, "messages", 1],
      ["msg_tel_+15555550102", "Test Contact B", NUM_B, "messages", 1],
    ]);
    expect(people[0].communication_count).toBe(1);
  });

  it("no name → the formatted number; one row per number across chats", () => {
    record(USER, "h1", [{ number: NUM_A, name: null }], "2026-09-01T00:00:00.000Z");
    record(USER, "h2", [{ number: NUM_A, name: null }], "2026-09-02T00:00:00.000Z");
    const people = getTextDerivedPeople(USER);
    expect(people).toHaveLength(1);
    expect(people[0].display_name).toBe("+1 (555) 555-0101");
    expect(people[0].last_communication_at).toBe("2026-09-02T00:00:00.000Z");
  });

  it("suppressed by number: last 10 digits, any format, a removed contact too (P4)", () => {
    record(USER, "h1", [{ number: NUM_A, name: "Test Contact A" }, { number: NUM_B, name: "Test Contact B" }, { number: NUM_C, name: "Test Contact C" }], "2026-09-01T00:00:00.000Z");
    addContact("c-a", "Test Contact D", "5555550101", null); // bare national digits
    addContact("c-b", "Test Contact E", "+1 555-555-0102", "(555) 555-0102", true); // removed (BACKLOG-2365)
    expect(ids()).toEqual(["msg_tel_+15555550103"]);
  });

  it("never by name: a saved contact with the same name does not hide the number (P3)", async () => {
    record(USER, "h1", [{ number: NUM_A, name: "Test Contact A" }], "2026-09-01T00:00:00.000Z");
    // A hand-typed contact (no crosswalk row): the 2618 rule would hide a
    // same-named macOS row — it must not hide a number row.
    addContact("c-x", "Test Contact A", "+15555550199", null);
    expect(ids()).toEqual(["msg_tel_+15555550101"]);
    const merged = (await getImportedContactsByUserId(USER, { textPeople: true })).map((c) => c.id);
    expect(merged).toContain("msg_tel_+15555550101");
    expect(searchContactsForSelection(USER, "Test Contact", 50, { textPeople: true }).map((c) => c.id)).toContain("msg_tel_+15555550101");
  });

  it("Don't-sync chats and the user's own number are left out (P5)", () => {
    record(USER, "h-off", [{ number: NUM_A, name: "Test Contact A" }], "2026-09-01T00:00:00.000Z");
    record(USER, "h-on", [{ number: NUM_B, name: "Test Contact B" }, { number: OWN, name: null }], "2026-09-01T00:00:00.000Z");
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash) VALUES ('x1', ?, 'h-off')").run(USER);
    db.prepare("INSERT INTO rcs_cache_state (user_id, own_number) VALUES (?, ?)").run(USER, OWN);
    expect(ids()).toEqual(["msg_tel_+15555550102"]);
  });

  it("cleared with the texts: Force re-import and auto-delete (P6)", () => {
    record(USER, "h1", [{ number: NUM_A, name: null }], "2026-09-01T00:00:00.000Z");
    record(USER, "h2", [{ number: NUM_B, name: null }], "2026-09-01T00:00:00.000Z");
    const ops = rcsAutoDeleteDbOps();
    clearUnlinkedOldChats(USER, "2026-10-01T00:00:00.000Z", { ...ops, unlinkedOldThreads: () => ["gmweb2-h1"] }, {
      attachmentsRoot: "/nowhere", resolve: (p) => p, deleteFile: () => false,
    });
    expect(ids()).toEqual(["msg_tel_+15555550102"]);
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), { attachmentsRoot: "/nowhere", resolve: (p) => p, deleteFile: () => false });
    expect(ids()).toEqual([]);
  });

  it("the macOS list is exactly the old list for a user with no Google Messages people (P7)", async () => {
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
       VALUES ('mac-1', ?, 'sms', 'mac-guid-1', 'inbound', 'hi', '{"from":"Test Mac Sender","to":["me"]}', 't-mac', '2026-09-20T10:00:00.000Z')`,
    ).run(USER);
    const off = await getImportedContactsByUserId(USER);
    const on = await getImportedContactsByUserId(USER, { textPeople: true });
    expect(on).toEqual(off);
    expect(on.map((c) => c.id)).toEqual(["msg_test mac sender"]);
  });

  it("only when asked: the Settings switch off shows none (P9)", async () => {
    record(USER, "h1", [{ number: NUM_A, name: "Test Contact A" }], "2026-09-01T00:00:00.000Z");
    expect((await getImportedContactsByUserId(USER)).map((c) => c.id)).toEqual([]);
    expect((await getImportedContactsByUserId(USER, { textPeople: true })).map((c) => c.id)).toEqual(["msg_tel_+15555550101"]);
    expect(searchContactsForSelection(USER, "Contact", 50).map((c) => c.id)).toEqual([]);
    expect(searchContactsForSelection(USER, "Contact", 50, { textPeople: true }).map((c) => c.id)).toEqual(["msg_tel_+15555550101"]);
    expect(searchContactsForSelection(USER, "0101", 50, { textPeople: true }).map((c) => c.id)).toEqual(["msg_tel_+15555550101"]);
  });

  it("import keeps the phone: the contact made from a msg_tel person suppresses its twin (P8)", () => {
    record(USER, "h1", [{ number: NUM_A, name: "Test Contact A" }], "2026-09-01T00:00:00.000Z");
    const person = getTextDerivedPeople(USER)[0];
    // The contacts:import door's own steps: shape, validate, write.
    const shaped = shapeImportValues({ ...person, isFromDatabase: false });
    const valid = validateContactData(shaped.forValidation, false);
    expect(valid.phone).toBeTruthy();
    expect(shaped.allPhones).toEqual([NUM_A]);
    createContactsBatch([
      { user_id: USER, display_name: valid.name ?? "", phone: valid.phone ?? undefined, source: "manual", is_imported: true, allPhones: shaped.allPhones, origin: { kind: "derived" } },
    ]);
    expect(count("SELECT COUNT(*) AS n FROM contact_phones WHERE phone_e164 = ?", NUM_A)).toBe(1);
    expect(ids()).toEqual([]);
  });

  it("rcsChatHash keys a chat by its numbers (sanity)", () => {
    expect(rcsChatHash([NUM_A])).toBe(rcsChatHash([NUM_A]));
  });
});

const count = (q: string, ...p: unknown[]): number => (db.prepare(q).get(...p) as { n: number }).n;
