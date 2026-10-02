/**
 * @jest-environment node
 */
/**
 * Live (0.3.15) — chats switched back ON were never picked up by the
 * incremental cache Sync (no new message). Switching a chat on records it as
 * pending; the next Sync reads it in full; it is cleared once saved. REAL SQL
 * on the production schema (run under Electron's Node).
 *
 * Mutations that turn this red:
 *   P1 the eye's "on" not recording the chat            → "the eye"
 *   P3 cleared before / without the chat being saved    → "cleared"
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
import { checkRcsExclusion, setRcsExclusion } from "../db/syncDbService";
import { clearAllPendingFullRead, clearPendingFullRead, listPendingFullRead } from "../db/rcsPendingFullSyncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-pfs";
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent-pfs@example.test', 'google', 'oauth-pfs')").run(USER);
  setDb(db);
});
afterEach(() => db?.close());

describe("chats switched back on are read in full on the next Sync", () => {
  it("the eye: switching a chat back on records it (P1)", () => {
    setRcsExclusion(USER, "conv-1", true);
    expect(checkRcsExclusion(USER, "hash-1", "conv-1")).toBe(true); // the hash is recorded at /match
    expect(listPendingFullRead(USER)).toEqual([]);
    setRcsExclusion(USER, "conv-1", false);
    expect(listPendingFullRead(USER)).toEqual(["conv-1"]);
  });

  it("cleared once the chat is saved — by conversation id or by hash (P3)", () => {
    setRcsExclusion(USER, "conv-1", true);
    checkRcsExclusion(USER, "hash-1", "conv-1");
    setRcsExclusion(USER, "conv-2", true);
    setRcsExclusion(USER, "conv-1", false);
    setRcsExclusion(USER, "conv-2", false);
    expect(new Set(listPendingFullRead(USER))).toEqual(new Set(["conv-1", "conv-2"]));
    expect(clearPendingFullRead(USER, "conv-renamed", "hash-1")).toBeGreaterThan(0); // re-paired: same chat, new id
    expect(listPendingFullRead(USER)).toEqual(["conv-2"]);
    clearAllPendingFullRead(USER);
    expect(listPendingFullRead(USER)).toEqual([]);
  });
});
