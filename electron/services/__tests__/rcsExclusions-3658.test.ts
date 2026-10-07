/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 P3c — per-chat exclusions ("Don't sync") on the REAL schema
 * (run under Electron's Node locally).
 *
 * Mutation controls (each turns a test red):
 *   X1 a pending exclusion never recording the chat's hash      → "pending by conversation id"
 *   X2 the hash not checked (a re-paired chat syncs again)        → "a re-pair"
 *   X3 switching back on leaves the same chat's older rows        → "switching back on"
 *   X4 not scoped to the user                                    → "each user's own"
 *   X5 Settings shows a chat twice / leaks no title fallback      → "Settings list"
 *   X6 RCS_EXCLUSION_STOPS_AUTOLINK honoured the wrong way        → "auto-link"
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
import {
  checkRcsExclusion,
  listRcsExclusionConversationIds,
  listRcsExclusionsForSettings,
  rcsExclusionHashes,
  setRcsExclusion,
} from "../db/syncDbService";
import { exclusionAutolinkThreads, isConversationId, RCS_EXCLUSION_STOPS_AUTOLINK } from "../rcsExclusions";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3658x";
const OTHER = "user-3658x-b";
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3658x-${n}@example.test`, `oauth-3658x-${n}`,
    );
  }
  setDb(db);
});

afterEach(() => db?.close());

describe("rcs_chat_exclusions (P3c)", () => {
  it("pending by conversation id; the first /match records the chat's hash (X1)", () => {
    setRcsExclusion(USER, "conv-a", true);
    expect(listRcsExclusionConversationIds(USER, 100)).toEqual(["conv-a"]);
    expect(rcsExclusionHashes(USER)).toEqual([]);
    expect(checkRcsExclusion(USER, "hash-a", "conv-a")).toBe(true);
    expect(rcsExclusionHashes(USER)).toEqual(["hash-a"]);
    expect(checkRcsExclusion(USER, "hash-b", "conv-b")).toBe(false);
  });

  it("a re-pair (new conversation id, same chat): still excluded, and the new id is shown switched off (X2)", () => {
    setRcsExclusion(USER, "conv-a", true);
    checkRcsExclusion(USER, "hash-a", "conv-a");
    expect(checkRcsExclusion(USER, "hash-a", "conv-a2")).toBe(true);
    expect(listRcsExclusionConversationIds(USER, 100).sort()).toEqual(["conv-a", "conv-a2"]);
  });

  it("switching back on removes the chat under every id (X3)", () => {
    setRcsExclusion(USER, "conv-a", true);
    checkRcsExclusion(USER, "hash-a", "conv-a");
    checkRcsExclusion(USER, "hash-a", "conv-a2");
    setRcsExclusion(USER, "conv-a2", false);
    expect(listRcsExclusionConversationIds(USER, 100)).toEqual([]);
    expect(checkRcsExclusion(USER, "hash-a", "conv-a3")).toBe(false);
  });

  it("each user's own (X4)", () => {
    setRcsExclusion(OTHER, "conv-a", true);
    checkRcsExclusion(OTHER, "hash-a", "conv-a");
    expect(checkRcsExclusion(USER, "hash-a", "conv-a")).toBe(false);
    expect(listRcsExclusionConversationIds(USER, 100)).toEqual([]);
    setRcsExclusion(USER, "conv-a", false); // the user's eye never touches another user's row
    expect(listRcsExclusionConversationIds(OTHER, 100)).toEqual(["conv-a"]);
  });

  it("the page's list is capped", () => {
    for (let i = 0; i < 5; i++) setRcsExclusion(USER, `conv-${i}`, true);
    expect(listRcsExclusionConversationIds(USER, 3)).toHaveLength(3);
  });

  it("Settings list (read-only): one entry per chat, the stored title when Keepr has the chat, else none (X5)", () => {
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, thread_id, sent_at, metadata)
       VALUES ('m1', ?, 'sms', 'gmweb2:hash-a:1', 'inbound', 'x', 'gmweb2-hash-a', '2026-09-20T10:00:00.000Z', ?)`,
    ).run(USER, JSON.stringify({ source: "gmweb-cache", conversationTitle: "Test Contact A" }));
    setRcsExclusion(USER, "conv-a", true);
    checkRcsExclusion(USER, "hash-a", "conv-a");
    checkRcsExclusion(USER, "hash-a", "conv-a2"); // same chat, second row
    setRcsExclusion(USER, "conv-b", true); // never synced: no title
    const list = listRcsExclusionsForSettings(USER);
    expect(new Set(list.map((c) => c.title))).toEqual(new Set(["Test Contact A", null]));
    expect(list).toHaveLength(2);
    // Only the eye switches a chat back on.
    setRcsExclusion(USER, "conv-b", false);
    expect(listRcsExclusionsForSettings(USER)).toHaveLength(1);
  });
});

describe("auto-link of texts already stored (pending founder decision) (X6)", () => {
  it("default: switching a chat off does NOT stop auto-linking what is already in Keepr", () => {
    expect(RCS_EXCLUSION_STOPS_AUTOLINK).toBe(false);
    expect(exclusionAutolinkThreads(["hash-a"])).toEqual([]);
  });

  it("when the founder turns it on: the chat's gmweb2 thread is skipped by the auto-link", () => {
    expect(exclusionAutolinkThreads(["hash-a", ""], true)).toEqual(["gmweb2-hash-a"]);
    expect(exclusionAutolinkThreads(["hash-a"], false)).toEqual([]);
  });

  it("conversation ids: what the page reads from a row address, nothing else", () => {
    expect(isConversationId("aB_9-x")).toBe(true);
    expect(isConversationId("../x")).toBe(false);
    expect(isConversationId("")).toBe(false);
    expect(isConversationId("a".repeat(201))).toBe(false);
    expect(isConversationId(42)).toBe(false);
  });
});
