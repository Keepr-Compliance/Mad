/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 — the pairing store, REAL SQL (run under Electron's Node).
 * Mutations: a re-pair keeping the old pairing → red; sign-out not removing
 * it → red; another user's pairing touched → red.
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
import { rcsPairingStore } from "../db/rcsPairingDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const u of ["user-pa", "user-pb"]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(u, `${u}@example.test`, `oauth-${u}`);
  }
  setDb(db);
});
afterEach(() => db?.close());

describe("the pairing store", () => {
  it("saves, finds, replaces on re-pair, removes on sign-out; users apart", () => {
    rcsPairingStore.save({ pairId: "p1", userId: "user-pa", keyHex: "11".repeat(32) });
    rcsPairingStore.save({ pairId: "q1", userId: "user-pb", keyHex: "22".repeat(32) });
    expect(rcsPairingStore.get("p1")).toEqual({ pairId: "p1", userId: "user-pa", keyHex: "11".repeat(32) });
    rcsPairingStore.save({ pairId: "p2", userId: "user-pa", keyHex: "33".repeat(32) });
    expect(rcsPairingStore.get("p1")).toBeNull();
    expect(rcsPairingStore.existsForUser("user-pa")).toBe(true);
    rcsPairingStore.deleteForUser("user-pa");
    expect(rcsPairingStore.existsForUser("user-pa")).toBe(false);
    expect(rcsPairingStore.get("q1")).not.toBeNull();
  });
});
