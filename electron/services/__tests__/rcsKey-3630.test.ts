/**
 * @jest-environment node
 */
/**
 * BACKLOG-3630 — the stable key's SQL on the REAL production schema (same
 * in-memory harness as rcsClear-3657 / checklistForceReimport-3475; run it
 * under Electron's Node locally: the native module is built for Electron).
 *
 * Mutation controls (each turns a test red):
 *   K1 content guard not limited to gmweb2 rows      → "legacy and other sources are not duplicates"
 *   K2 content guard not scoped to the user           → "another user's identical message is not a duplicate"
 *   K3 content guard matching the row's own key       → "the same key is not a duplicate of itself"
 *   K4 removals dropping gmweb2-* thread ids          → "removals: gmweb2 and legacy gmweb-chat threads"
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
import { findRcsContentDuplicates, getRcsRemovals } from "../db/syncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3630";
const OTHER = "user-3630-b";
const SENT = "2026-09-20T13:05:00.000Z";

let db: DatabaseType;

function insertMsg(id: string, user: string, externalId: string, body: string | null, direction = "inbound"): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata)
     VALUES (?, ?, 'sms', ?, ?, ?, '{"from":"+15555550199","to":["me"]}', 'gmweb2-x', ?, '{}')`,
  ).run(id, user, externalId, direction, body, SENT);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3630-${n}@example.test`, `oauth-3630-${n}`,
    );
  }
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('tx-a', ?, '1 Test Street')").run(USER);
  setDb(db);
});

afterEach(() => db?.close());

const row = (externalId: string, bodyText: string | null, direction = "inbound") => ({
  externalId, sentAt: SENT, direction, bodyText,
});

describe("the content guard (findRcsContentDuplicates)", () => {
  it("finds the user's gmweb2 row with the same sent_at + direction + body under another key", () => {
    insertMsg("old", USER, "gmweb2:oldhash:7", "same words");
    const found = findRcsContentDuplicates(USER, [row("gmweb2:newhash:7", "same words")]);
    expect(Array.from(found.entries())).toEqual([["gmweb2:newhash:7", "old"]]);
  });

  it("a different body, direction or time is not a duplicate; NULL bodies compare equal", () => {
    insertMsg("old", USER, "gmweb2:oldhash:7", "same words");
    insertMsg("img", USER, "gmweb2:oldhash:8", null);
    const found = findRcsContentDuplicates(USER, [
      row("gmweb2:newhash:1", "other words"),
      row("gmweb2:newhash:2", "same words", "outbound"),
      row("gmweb2:newhash:8", null),
    ]);
    expect(Array.from(found.keys())).toEqual(["gmweb2:newhash:8"]);
  });

  it("legacy and other sources are not duplicates (K1)", () => {
    insertMsg("legacy", USER, "gmweb:CgiOldConversation:7", "same words");
    insertMsg("android", USER, "android-ext-7", "same words");
    expect(findRcsContentDuplicates(USER, [row("gmweb2:newhash:7", "same words")]).size).toBe(0);
  });

  it("another user's identical message is not a duplicate (K2)", () => {
    insertMsg("theirs", OTHER, "gmweb2:oldhash:7", "same words");
    expect(findRcsContentDuplicates(USER, [row("gmweb2:newhash:7", "same words")]).size).toBe(0);
  });

  it("the same key is not a duplicate of itself (K3)", () => {
    insertMsg("same", USER, "gmweb2:hash:7", "same words");
    expect(findRcsContentDuplicates(USER, [row("gmweb2:hash:7", "same words")]).size).toBe(0);
  });
});

describe("removals (getRcsRemovals)", () => {
  it("removals: gmweb2 and legacy gmweb-chat threads; other sources ignored (K4)", () => {
    const ins = db.prepare(
      "INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, original_communication_id, reason) VALUES (?, ?, 'tx-a', ?, ?, 'test')",
    );
    ins.run("i1", USER, "gmweb2-abc", null);
    ins.run("i2", USER, "gmweb-chat-CgiOld", null);
    ins.run("i3", USER, "android-thread-9", null);
    ins.run("i4", USER, null, "msg-1");
    const r = getRcsRemovals("tx-a", USER);
    expect(Array.from(r.threadIds).sort()).toEqual(["gmweb-chat-CgiOld", "gmweb2-abc"]);
    expect(Array.from(r.messageIds)).toEqual(["msg-1"]);
  });
});
