/**
 * @jest-environment node
 */
/**
 * Live (Windows): the contact picker froze Keepr — the people found in texts
 * (BACKLOG-3670) were read with a query that compared a 5-deep
 * replace()/substr() of every person against every contact phone, plus a
 * correlated message count, synchronously on the main thread.
 *
 * Real SQL on the production schema (run under Electron's Node). Mutation
 * controls (each turns a test red):
 *   Q1 the old per-row SQL matching back                 → "under budget"
 *   Q2 a full SCAN of contact_phones or messages          → "query plans"
 *   Q3 the same answer lost (suppression / own number /
 *      Don't-sync / newest name / count)                  → "the same people"
 *   Q4 search applied after the cap (matches missed)      → "search before the cap"
 *   Q5 the cache not invalidated by a new contact          → "cache"
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

import { setDb } from "../db/core/dbConnection";
import { getTextDerivedPeople, recordRcsChatPeople, TEXT_PEOPLE_QUERIES, TEXT_PEOPLE_CAP } from "../db/rcsChatPeopleDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-perf";

let db: DatabaseType;

function num(i: number): string {
  return `+1555${String(1000000 + i).slice(-7)}`;
}

/** 5k chat people (2,500 numbers × 2 chats), 5k contacts with phones, 100k messages. */
function seedBig(): { people: number; contacts: number; messages: number } {
  const insPerson = db.prepare("INSERT INTO rcs_chat_people (user_id, chat_hash, number_e164, name, last_message_at) VALUES (?, ?, ?, ?, ?)");
  const insContact = db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)");
  const insPhone = db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES (?, ?, ?, ?)");
  const insMsg = db.prepare("INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, thread_id) VALUES (?, ?, 'sms', 'inbound', 'x', ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 2500; i++) {
      for (let c = 0; c < 2; c++) {
        insPerson.run(USER, `h-${i}-${c}`, num(i), c === 0 ? `Test Person ${i}` : null, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z`);
      }
    }
    // Contacts 2,000..6,999: 500 of the people are already contacts (suppressed).
    for (let i = 2000; i < 7000; i++) {
      insContact.run(`c-${i}`, USER, `Test Contact ${i}`);
      insPhone.run(`p-${i}`, `c-${i}`, num(i), null);
    }
    for (let k = 0; k < 100000; k++) {
      const i = k % 2500;
      insMsg.run(`m-${k}`, USER, "2026-09-10T10:00:00.000Z", `gmweb2-h-${i}-${k % 2}`);
    }
  })();
  return { people: 5000, contacts: 5000, messages: 100000 };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-perf@example.test', 'google', 'oauth-perf')").run(USER);
  setDb(db);
});
afterEach(() => db?.close());

describe("people found in texts: fast enough for the picker", () => {
  it("5k chat people / 5k contacts / 100k messages: under budget (cold), and a cached reopen is near-free", () => {
    seedBig();
    const t0 = performance.now();
    const people = getTextDerivedPeople(USER);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    getTextDerivedPeople(USER);
    const warm = performance.now() - t1;
    process.stderr.write(`[perf] text people: cold ${cold.toFixed(1)} ms, cached ${warm.toFixed(1)} ms, ${people.length} people
`);
    expect(people).toHaveLength(TEXT_PEOPLE_CAP);
    expect(cold).toBeLessThan(500);
    expect(warm).toBeLessThan(50);
  });

  it("query plans: no full SCAN of contact_phones or messages", () => {
    for (const [name, q] of Object.entries(TEXT_PEOPLE_QUERIES)) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params(USER)) as Array<{ detail: string }>).map((r) => r.detail);
      for (const step of plan) {
        expect([name, step, /^SCAN (cp|contact_phones|m|messages)\b/.test(step)]).toEqual([name, step, false]);
      }
    }
  });
});

describe("the same people as before", () => {
  function add(chat: string, number: string, name: string | null, at: string) {
    db.prepare("INSERT INTO rcs_chat_people (user_id, chat_hash, number_e164, name, last_message_at) VALUES (?, ?, ?, ?, ?)").run(USER, chat, number, name, at);
  }

  it("suppressed by any contact phone (E.164 or display, removed included) and the own number; Don't-sync left out; newest name; counts", () => {
    add("h-a", "+15555550101", "Test Person Old", "2026-09-01T10:00:00.000Z");
    add("h-a2", "+15555550101", "Test Person New", "2026-09-05T10:00:00.000Z");
    add("h-b", "+15555550102", null, "2026-09-04T10:00:00.000Z");
    add("h-c", "+15555550103", "Test Person C", "2026-09-03T10:00:00.000Z"); // a contact (display form)
    add("h-d", "+15555550104", "Test Person D", "2026-09-02T10:00:00.000Z"); // a removed contact
    add("h-own", "+15555550100", "Me", "2026-09-06T10:00:00.000Z"); // own number
    add("h-off", "+15555550105", "Test Person Off", "2026-09-07T10:00:00.000Z"); // Don't-sync chat
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('c1', ?, 'X', 'manual', 1)").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES ('p1', 'c1', '+15555550199', '(555) 555-0103')").run();
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported, removed_at) VALUES ('c2', ?, 'Y', 'manual', 1, '2026-09-01')").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES ('p2', 'c2', '15555550104', NULL)").run();
    db.prepare("INSERT INTO rcs_cache_state (user_id, own_number) VALUES (?, '+15555550100')").run(USER);
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash) VALUES ('x1', ?, 'h-off')").run(USER);
    const msg = db.prepare("INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, thread_id) VALUES (?, ?, 'sms', 'inbound', 'x', '2026-09-01', ?)");
    msg.run("m1", USER, "gmweb2-h-a");
    msg.run("m2", USER, "gmweb2-h-a2");
    msg.run("m3", USER, "gmweb2-h-a2");
    msg.run("m4", "someone-else", "gmweb2-h-b");
    const people = getTextDerivedPeople(USER);
    expect(people.map((p) => [p.id, p.display_name, p.last_communication_at, p.communication_count])).toEqual([
      ["msg_tel_+15555550101", "Test Person New", "2026-09-05T10:00:00.000Z", 3],
      ["msg_tel_+15555550102", "+1 (555) 555-0102", "2026-09-04T10:00:00.000Z", 0],
    ]);
  });

  it("search before the cap: a match beyond the newest 200 is found", () => {
    for (let i = 0; i < TEXT_PEOPLE_CAP + 50; i++) add(`h-${i}`, num(i), `Test Person ${i}`, `2026-09-01T10:${String(59 - (i % 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`);
    add("h-old", "+15555550198", "Test Person Zebra", "2020-01-01T00:00:00.000Z"); // the oldest
    expect(getTextDerivedPeople(USER).map((p) => p.display_name)).not.toContain("Test Person Zebra");
    expect(getTextDerivedPeople(USER, "Zebra").map((p) => p.display_name)).toEqual(["Test Person Zebra"]);
    expect(getTextDerivedPeople(USER, "5550198").map((p) => p.display_name)).toEqual(["Test Person Zebra"]);
  });

  it("cache: a new contact / new person / Don't-sync change is seen at once", () => {
    add("h-a", "+15555550101", "Test Person A", "2026-09-05T10:00:00.000Z");
    expect(getTextDerivedPeople(USER).map((p) => p.id)).toEqual(["msg_tel_+15555550101"]);
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('c1', ?, 'X', 'manual', 1)").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES ('p1', 'c1', '+15555550101', NULL)").run();
    expect(getTextDerivedPeople(USER)).toEqual([]);
    add("h-b", "+15555550102", "Test Person B", "2026-09-06T10:00:00.000Z");
    expect(getTextDerivedPeople(USER).map((p) => p.id)).toEqual(["msg_tel_+15555550102"]);
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash) VALUES ('x1', ?, 'h-b')").run(USER);
    expect(getTextDerivedPeople(USER)).toEqual([]);
  });
});

// SR on 351c5d02e: an in-place phone edit (contact_phones has no updated_at)
// and a message import refresh the cache. Mutations: the phone digits not in
// the fingerprint; no invalidation on import → red.
describe("cache freshness", () => {
  function add(chat: string, number: string, name: string | null, at: string) {
    db.prepare("INSERT INTO rcs_chat_people (user_id, chat_hash, number_e164, name, last_message_at) VALUES (?, ?, ?, ?, ?)").run(USER, chat, number, name, at);
  }

  it("a contact's phone edited in place: suppression follows at once", () => {
    add("h-a", "+15555550101", "Test Person A", "2026-09-05T10:00:00.000Z");
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('c1', ?, 'X', 'manual', 1)").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES ('p1', 'c1', '+15555550109', NULL)").run();
    expect(getTextDerivedPeople(USER).map((p) => p.id)).toEqual(["msg_tel_+15555550101"]);
    db.prepare("UPDATE contact_phones SET phone_e164 = '+15555550101' WHERE id = 'p1'").run();
    expect(getTextDerivedPeople(USER)).toEqual([]);
    db.prepare("UPDATE contact_phones SET phone_e164 = '+15555550109' WHERE id = 'p1'").run();
    expect(getTextDerivedPeople(USER).map((p) => p.id)).toEqual(["msg_tel_+15555550101"]);
    // Only the display form edited in place.
    db.prepare("UPDATE contact_phones SET phone_display = '(555) 555-0101' WHERE id = 'p1'").run();
    expect(getTextDerivedPeople(USER)).toEqual([]);
  });

  it("messages imported for a chat: the count is fresh (the store records the chat's people)", () => {
    add("h-a", "+15555550101", "Test Person A", "2026-09-05T10:00:00.000Z");
    expect(getTextDerivedPeople(USER)[0].communication_count).toBe(0);
    db.prepare("INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, thread_id) VALUES ('m1', ?, 'sms', 'inbound', 'x', '2026-09-06', 'gmweb2-h-a')").run(USER);
    // The import path: the chat's messages, then its people (same second).
    recordRcsChatPeople(USER, "h-a", [{ number: "+15555550101", name: "Test Person A" }], "2026-09-05T10:00:00.000Z");
    expect(getTextDerivedPeople(USER)[0].communication_count).toBe(1);
  });
});
