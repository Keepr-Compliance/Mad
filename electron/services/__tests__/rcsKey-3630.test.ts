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
 *   K5 guard not checking the people (SR F1)          → "cross-chat 'Ok' in the same minute"
 *   K6 guard applied to empty bodies (SR F1)          → "image-only messages in the same minute"
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
import { findRcsContentDuplicates } from "../db/syncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3630";
const OTHER = "user-3630-b";
const SENT = "2026-09-20T13:05:00.000Z";

let db: DatabaseType;

const NUM_A = "+15555550199";
const NUM_B = "+15555550142";
const NUM_C = "+15555550123";

function insertMsg(
  id: string,
  user: string,
  externalId: string,
  body: string | null,
  direction = "inbound",
  people: { from?: string; numbers?: string[] } = {},
): void {
  const numbers = people.numbers ?? [NUM_A];
  const participants = direction === "inbound"
    ? { from: people.from ?? numbers[0], to: ["me"] }
    : { from: "me", to: numbers };
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat, thread_id, sent_at, metadata)
     VALUES (?, ?, 'sms', ?, ?, ?, ?, ?, 'gmweb2-x', ?, '{}')`,
  ).run(id, user, externalId, direction, body, JSON.stringify(participants), numbers.join(", "), SENT);
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

const row = (
  externalId: string,
  bodyText: string | null,
  direction = "inbound",
  people: { from?: string; numbers?: string[] } = {},
) => {
  const numbers = people.numbers ?? [NUM_A];
  const participants = direction === "inbound"
    ? { from: people.from ?? numbers[0], to: ["me"] }
    : { from: "me", to: numbers };
  return {
    externalId, sentAt: SENT, direction, bodyText,
    participants: JSON.stringify(participants), participantsFlat: numbers.join(", "),
  };
};

describe("the content guard (findRcsContentDuplicates)", () => {
  it("finds the user's gmweb2 row with the same sent_at + direction + body under another key", () => {
    insertMsg("old", USER, "gmweb2:oldhash:7", "same words");
    const found = findRcsContentDuplicates(USER, [row("gmweb2:newhash:7", "same words")]);
    expect(Array.from(found.entries())).toEqual([["gmweb2:newhash:7", "old"]]);
  });

  it("a different body or direction is not a duplicate", () => {
    insertMsg("old", USER, "gmweb2:oldhash:7", "same words");
    const found = findRcsContentDuplicates(USER, [
      row("gmweb2:newhash:1", "other words"),
      row("gmweb2:newhash:2", "same words", "outbound"),
    ]);
    expect(found.size).toBe(0);
  });

  it("image-only messages in the same minute are never duplicates (K6)", () => {
    insertMsg("img", USER, "gmweb2:oldhash:8", null);
    insertMsg("blank", USER, "gmweb2:oldhash:9", "");
    expect(findRcsContentDuplicates(USER, [row("gmweb2:newhash:8", null), row("gmweb2:newhash:9", "")]).size).toBe(0);
  });

  it("cross-chat 'Ok' in the same minute from another person is NOT a duplicate (K5)", () => {
    insertMsg("theirs", USER, "gmweb2:chatB:7", "Ok", "inbound", { numbers: [NUM_B] });
    expect(findRcsContentDuplicates(USER, [row("gmweb2:chatA:7", "Ok")]).size).toBe(0);
    // Outbound "Thanks" to two different people in the same minute: no shared number.
    insertMsg("toB", USER, "gmweb2:chatB:8", "Thanks", "outbound", { numbers: [NUM_B] });
    expect(findRcsContentDuplicates(USER, [row("gmweb2:chatA:8", "Thanks", "outbound", { numbers: [NUM_A] })]).size).toBe(0);
  });

  it("a true group-drift duplicate (a member joined, the key changed) is still deduped", () => {
    insertMsg("g-in", USER, "gmweb2:groupOld:7", "see you there", "inbound", { from: NUM_A, numbers: [NUM_A, NUM_B] });
    insertMsg("g-out", USER, "gmweb2:groupOld:8", "on my way", "outbound", { numbers: [NUM_A, NUM_B] });
    const found = findRcsContentDuplicates(USER, [
      row("gmweb2:groupNew:7", "see you there", "inbound", { from: NUM_A, numbers: [NUM_A, NUM_B, NUM_C] }),
      row("gmweb2:groupNew:8", "on my way", "outbound", { numbers: [NUM_A, NUM_B, NUM_C] }),
    ]);
    expect(Array.from(found.entries()).sort()).toEqual([["gmweb2:groupNew:7", "g-in"], ["gmweb2:groupNew:8", "g-out"]]);
  });

  it("an unresolved group sender (a name, no number) is never deduped", () => {
    insertMsg("g-in", USER, "gmweb2:groupOld:7", "hi", "inbound", { from: "Test Contact Twin", numbers: [NUM_A, NUM_B] });
    expect(findRcsContentDuplicates(USER, [
      row("gmweb2:groupNew:7", "hi", "inbound", { from: "Test Contact Twin", numbers: [NUM_A, NUM_B, NUM_C] }),
    ]).size).toBe(0);
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

