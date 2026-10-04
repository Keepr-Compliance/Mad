/**
 * @jest-environment node
 */
/**
 * Group-sender names (bug): a Google Messages group's sender who is in the
 * phone's address book but not in Keepr's contacts showed as a bare number.
 * resolvePhoneNames' Source 4 names them from rcs_chat_people. Real SQL on
 * the production schema; run under Electron's Node (real SQLite build).
 *
 * Mutation controls (each turns a test red):
 *   G1 Source 4 removed                                   → "an rcs-only number"
 *   G2 Source 4 overwriting a real contact                → "a real contact wins"
 *   G3 the user filter dropped from the helper             → "another user's names"
 *   G4 Don't-sync chats not left out                       → "a Don't-sync chat"
 *   G5 an empty name taken (no non-empty filter)           → "an empty name"
 *   G6 the helper matching E.164 only (no last-10)         → "E.164 and national"
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
// No macOS address book here (Source 3 finds nothing).
jest.mock("../contactsService", () => ({ __esModule: true, getContactNames: async () => ({ contactMap: {} }) }));
// The real per-table queries behind databaseService's resolution calls.
jest.mock("../databaseService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const a = require("../db/attachmentDbService") as typeof import("../db/attachmentDbService");
  return {
    __esModule: true,
    default: {
      getContactNamesByPhoneDigits: a.getContactNamesByPhoneDigits,
      getContactNamesByEmails: a.getContactNamesByEmails,
      getContactNameByAppleIdPrefix: a.getContactNameByAppleIdPrefix,
    },
  };
});

import { setDb } from "../db/core/dbConnection";
import { batchInsertMessages, findRcsContentDuplicates, getMessageIdMap, insertReactionRows, repointLegacyRcsRemoval } from "../db/syncDbService";
import { getRcsPeopleNamesByDigits, recordRcsChatPeople } from "../db/rcsChatPeopleDbService";
import { peopleFrom, rcsChatHash, storeCacheChatSync, type RcsIncomingChat } from "../rcsImportStore";
import { extractParticipantHandles, resolveGroupChatParticipants, resolveHandles, resolvePhoneNames } from "../contactResolutionService";
import type { Communication } from "../../types/models";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-gsn";
const OTHER = "user-gsn-2";
const NUM_A = "+15555550111";
const NUM_B = "+15555550112";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [id, n] of [[USER, 1], [OTHER, 2]] as const) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(id, `agent-gsn-${n}@example.test`, `oauth-gsn-${n}`);
  }
  setDb(db);
});
afterEach(() => {
  db?.close();
});

function addContact(id: string, userId: string, name: string, phoneE164: string): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)").run(id, userId, name);
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display) VALUES (?, ?, ?, NULL)").run(`p-${id}`, id, phoneE164);
}

describe("group-sender names from Google Messages (Source 4)", () => {
  it("an rcs-only number resolves to the name Google Messages showed (G1)", async () => {
    recordRcsChatPeople(USER, "h-1", [{ number: NUM_A, name: "Test Person A" }], "2026-09-20T10:00:00.000Z");
    const r = await resolvePhoneNames([NUM_A, "(555) 555-0111"], USER);
    expect(r.names[NUM_A]).toBe("Test Person A");
    expect(r.names["5555550111"]).toBe("Test Person A");
    expect(r.names["(555) 555-0111"]).toBe("Test Person A");
    expect(r.matches[NUM_A]).toEqual(["Test Person A"]);
  });

  it("a real contact wins over the Google Messages name (G2)", async () => {
    addContact("c-1", USER, "Test Contact Real", NUM_A);
    recordRcsChatPeople(USER, "h-1", [{ number: NUM_A, name: "Test Person A" }], "2026-09-20T10:00:00.000Z");
    const r = await resolvePhoneNames([NUM_A], USER);
    expect(r.names[NUM_A]).toBe("Test Contact Real");
    expect(r.names["5555550111"]).toBe("Test Contact Real");
  });

  it("another user's names are never used (G3)", async () => {
    recordRcsChatPeople(OTHER, "h-1", [{ number: NUM_A, name: "Test Person Other" }], "2026-09-20T10:00:00.000Z");
    const r = await resolvePhoneNames([NUM_A], USER);
    expect(r.names[NUM_A]).toBeUndefined();
    expect(getRcsPeopleNamesByDigits(USER, [NUM_A])).toEqual([]);
  });

  it("a Don't-sync chat's names are left out (G4)", async () => {
    recordRcsChatPeople(USER, "h-off", [{ number: NUM_A, name: "Test Person Hidden" }], "2026-09-21T10:00:00.000Z");
    recordRcsChatPeople(USER, "h-on", [{ number: NUM_B, name: "Test Person B" }], "2026-09-20T10:00:00.000Z");
    db.prepare("INSERT INTO rcs_chat_exclusions (id, user_id, chat_hash) VALUES ('x1', ?, 'h-off')").run(USER);
    const r = await resolvePhoneNames([NUM_A, NUM_B], USER);
    expect(r.names[NUM_A]).toBeUndefined();
    expect(r.names[NUM_B]).toBe("Test Person B");
  });

  it("an empty name falls through (the newest NON-empty name wins) (G5)", async () => {
    recordRcsChatPeople(USER, "h-old", [{ number: NUM_A, name: "Test Person Older" }], "2026-09-01T10:00:00.000Z");
    recordRcsChatPeople(USER, "h-new", [{ number: NUM_A, name: "   " }], "2026-09-25T10:00:00.000Z");
    recordRcsChatPeople(USER, "h-none", [{ number: NUM_B, name: null }], "2026-09-25T10:00:00.000Z");
    const r = await resolvePhoneNames([NUM_A, NUM_B], USER);
    expect(r.names[NUM_A]).toBe("Test Person Older");
    expect(r.names[NUM_B]).toBeUndefined();
    recordRcsChatPeople(USER, "h-newest", [{ number: NUM_A, name: "Test Person Newest" }], "2026-09-30T10:00:00.000Z");
    expect(getRcsPeopleNamesByDigits(USER, [NUM_A])).toEqual([{ number: NUM_A, name: "Test Person Newest" }]);
  });

  it("the helper matches E.164 and national forms on the last 10 digits (G6)", () => {
    recordRcsChatPeople(USER, "h-1", [{ number: NUM_A, name: "Test Person A" }], "2026-09-20T10:00:00.000Z");
    for (const form of [NUM_A, "15555550111", "5555550111", "(555) 555-0111", "555-555-0111"]) {
      expect([form, getRcsPeopleNamesByDigits(USER, [form])]).toEqual([form, [{ number: NUM_A, name: "Test Person A" }]]);
    }
    expect(getRcsPeopleNamesByDigits(USER, ["555-0111"])).toEqual([]); // too short to match
  });

  // The Texts tab (contacts:resolve-handles → resolveHandles with the
  // transaction scope) and the folder / PDF export (resolveHandles +
  // resolveGroupChatParticipants) both name the group's sender.
  it("a stored group: the Texts tab's and the export's resolution name the sender", async () => {
    const storeDeps = {
      batchInsertMessages,
      getMessageIdMap,
      insertReactionRows,
      findContentDuplicates: findRcsContentDuplicates,
      repointLegacyRemoval: repointLegacyRcsRemoval,
      recordPeople: recordRcsChatPeople,
    };
    const chat: RcsIncomingChat = {
      conversationId: "conv-g",
      title: "Test Group",
      messages: [{ msgId: "m1", direction: "inbound", sender: "Test Person A", text: "hello", sentAt: "2026-09-20T10:00:00.000Z", transport: "rcs" }],
    };
    const people = peopleFrom([{ name: "Test Person A", number: NUM_A }, { name: "Test Person B", number: NUM_B }], [NUM_A, NUM_B]);
    storeCacheChatSync(chat, USER, storeDeps, people);
    const threadId = `gmweb2-${rcsChatHash([NUM_A, NUM_B])}`;
    const messages = db.prepare("SELECT * FROM messages WHERE user_id = ? AND thread_id = ?").all(USER, threadId) as Communication[];
    expect(messages).toHaveLength(1);
    const handles = extractParticipantHandles(messages);
    expect(handles).toEqual(expect.arrayContaining([NUM_A, NUM_B]));
    // The Texts tab's IPC: user + transaction scope.
    const tab = await resolveHandles(handles, USER, { userId: USER, transactionId: "tx-none" });
    expect(tab.names[NUM_A]).toBe("Test Person A");
    // The export: the same resolution, then the group's participants.
    const exported = await resolveHandles(handles, USER, { userId: USER, transactionId: "tx-none" });
    const parts = await resolveGroupChatParticipants(messages, exported.names);
    expect(parts.find((p) => p.handle === NUM_A)?.name).toBe("Test Person A");
    expect(parts.find((p) => p.handle === NUM_B)?.name).toBe("Test Person B");
  });
});
