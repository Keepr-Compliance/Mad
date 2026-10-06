/**
 * @jest-environment node
 *
 * Live (founder, 2026-10-05): Google Messages GROUP chat names were neither
 * searchable (Attach messages) nor shown on the thread card. The page sends
 * the title; Keepr kept it only per message. Now the cache commit writes a
 * group's own name to message_thread_names — the table and statement the
 * Mac / iPhone import uses, which search and the cards already read.
 *
 * Real SQL on the production schema (run under Electron's Node locally).
 *
 * Mutations (each red): no thread name recorded; an unnamed group given its
 * members' names as a name; a 1:1 chat named; the clear leaving the name.
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
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import { batchInsertMessages, findRcsContentDuplicates, getMessageIdMap, insertReactionRows, rcsClearDbOps, rcsAutoDeleteDbOps } from "../db/syncDbService";
import { recordRcsThreadName } from "../db/rcsChatPeopleDbService";
import { getMessageContacts } from "../db/messageDbService";
import { getCommunicationsWithMessages } from "../db/communicationDbService";
import {
  peopleFrom,
  rcsChatHash,
  rcsGroupThreadName,
  storeCacheChatSync,
  RCS_THREAD_PREFIX,
  type RcsIncomingChat,
  type RcsChatPeople,
} from "../rcsImportStore";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-group-names";
const TXN = "txn-group-names";
const NUM_A = "+15555550111";
const NUM_B = "+15555550112";
const NUM_C = "+15555550113";
let db: DatabaseType;

const deps = {
  batchInsertMessages,
  getMessageIdMap,
  insertReactionRows,
  findContentDuplicates: findRcsContentDuplicates,
  recordThreadName: recordRcsThreadName,
};

const group: RcsChatPeople = peopleFrom(
  [{ name: "Ana Example", number: NUM_A }, { name: "Ben Example", number: NUM_B }, { name: "Cy Example", number: NUM_C }],
  [NUM_A, NUM_B, NUM_C],
);
const threadOf = (p: RcsChatPeople) => `${RCS_THREAD_PREFIX}${rcsChatHash(p.numbers)}`;

function chat(title: string, people: RcsChatPeople = group): RcsIncomingChat {
  void people;
  return {
    conversationId: "conv-" + title.length,
    title,
    messages: [{ msgId: "m1", direction: "inbound", sender: "x", text: "hello group", sentAt: "2026-09-20T10:00:00.000Z", transport: "rcs" }],
  };
}

const nameRow = (threadId: string) =>
  (db.prepare("SELECT display_name AS n FROM message_thread_names WHERE user_id = ? AND thread_id = ?").get(USER, threadId) as { n: string } | undefined)?.n ?? null;

const store = (title: string, people: RcsChatPeople = group) => db.transaction(() => storeCacheChatSync(chat(title, people), USER, deps, people))();

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'group-names@example.test', 'google', 'oauth-group-names')").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(TXN, USER, "1 Test St");
  setDb(db);
});

afterEach(() => {
  db?.close();
});

describe("Google Messages group names (live)", () => {
  it("a named group: searchable in Attach messages and the thread card's title", async () => {
    store("Closing Team");
    expect(nameRow(threadOf(group))).toBe("Closing Team");
    // Attach messages: the contact roster carries the group name.
    const roster = getMessageContacts(USER);
    expect(roster.some((r) => r.threadNames.includes("Closing Team"))).toBe(true);
    // The thread card: the loader joins the name onto the thread's messages.
    const m = db.prepare("SELECT id, thread_id AS t FROM messages WHERE user_id = ?").get(USER) as { id: string; t: string };
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id) VALUES (?, ?, ?, ?, ?)").run("comm-1", USER, TXN, m.id, m.t);
    const rows = (await getCommunicationsWithMessages(TXN, "text")) as unknown as Array<{ thread_display_name?: string }>;
    expect(rows[0].thread_display_name).toBe("Closing Team");
  });

  it("an unnamed group (Google shows the members' names joined) gets no name; a rename back removes it", () => {
    store("Ana, Ben and Cy");
    expect(nameRow(threadOf(group))).toBeNull();
    store("Closing Team");
    expect(nameRow(threadOf(group))).toBe("Closing Team");
    store("Ana Example, Ben Example +1");
    expect(nameRow(threadOf(group))).toBeNull();
  });

  it("a 1:1 chat is never given a thread name", () => {
    const one = peopleFrom([{ name: "Ana Example", number: NUM_A }], [NUM_A]);
    store("Closing Team", one); // a title that would qualify for a group
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_thread_names").get()).toEqual({ n: 0 });
  });

  it("the clears remove Google Messages names only (all; per thread)", () => {
    store("Closing Team");
    db.prepare("INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, 'macos-chat-1', 'Mac Group')").run(USER);
    rcsAutoDeleteDbOps().deletePeople?.(USER, [threadOf(group)]);
    expect(nameRow(threadOf(group))).toBeNull();
    store("Closing Team");
    rcsClearDbOps().deletePeople?.(USER);
    expect(nameRow(threadOf(group))).toBeNull();
    expect(nameRow("macos-chat-1")).toBe("Mac Group");
  });

  it("rcsGroupThreadName: what counts as a group's own name", () => {
    expect(rcsGroupThreadName("  Closing Team ", group)).toBe("Closing Team");
    expect(rcsGroupThreadName("", group)).toBeNull();
    expect(rcsGroupThreadName("+1 555-555-0111", group)).toBeNull();
    expect(rcsGroupThreadName("Ana, Ben & Cy", group)).toBeNull();
    expect(rcsGroupThreadName("ana example, ben example and cy example", group)).toBeNull();
    expect(rcsGroupThreadName("Ana, Ben +2 more", group)).toBeNull();
    expect(rcsGroupThreadName("Ana and the Closing Team", group)).toBe("Ana and the Closing Team");
  });
});
