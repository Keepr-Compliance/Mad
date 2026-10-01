/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — the cache job's SQL on the REAL production schema (run under
 * Electron's Node locally; the native module is built for Electron).
 *
 * Mutation controls (each turns a test red):
 *   S1 the contact check ignoring removed transaction contacts  → "a contact removed from the transaction"
 *   S2 the contact check ignoring the live-transaction filter   → "a rejected transaction"
 *   S3 the contact check not scoped to the user                 → "another user's transaction"
 *   S4 cache state writes not scoped to the user                → "each user's state is their own"
 *   S5 the reset forgetting to clear the own number             → "Force re-import resets"
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
  getRcsCacheState,
  rcsNumbersMatchLiveContact,
  resetRcsCacheState,
  updateRcsCacheState,
} from "../db/syncDbService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3658";
const OTHER = "user-3658-b";
const NUM = "+15555550199";

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3658-${n}@example.test`, `oauth-3658-${n}`,
    );
  }
  setDb(db);
});

afterEach(() => db?.close());

function contactOnTransaction(opts: {
  user?: string;
  txStatus?: string;
  tcRemoved?: boolean;
  contactRemoved?: boolean;
  phone?: string;
  id: string;
}): void {
  const user = opts.user ?? USER;
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status) VALUES (?, ?, '1 Test Street', ?)").run(
    `tx-${opts.id}`, user, opts.txStatus ?? "active",
  );
  db.prepare("INSERT INTO contacts (id, user_id, display_name, removed_at) VALUES (?, ?, 'Test Contact A', ?)").run(
    `c-${opts.id}`, user, opts.contactRemoved ? "2026-09-01T00:00:00Z" : null,
  );
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)").run(
    `p-${opts.id}`, `c-${opts.id}`, opts.phone ?? NUM,
  );
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at) VALUES (?, ?, ?, ?)").run(
    `tc-${opts.id}`, `tx-${opts.id}`, `c-${opts.id}`, opts.tcRemoved ? "2026-09-01T00:00:00Z" : null,
  );
}

describe("does a chat's number belong to a live transaction contact? (cache images)", () => {
  it("a contact on one of the user's live transactions: yes; an unknown number: no", () => {
    contactOnTransaction({ id: "1" });
    expect(rcsNumbersMatchLiveContact(USER, ["+15555550142", NUM])).toBe(true);
    expect(rcsNumbersMatchLiveContact(USER, ["+15555550142"])).toBe(false);
    expect(rcsNumbersMatchLiveContact(USER, [])).toBe(false);
  });

  it("a contact removed from the transaction: no (S1)", () => {
    contactOnTransaction({ id: "1", tcRemoved: true });
    expect(rcsNumbersMatchLiveContact(USER, [NUM])).toBe(false);
  });

  it("a deleted contact: no", () => {
    contactOnTransaction({ id: "1", contactRemoved: true });
    expect(rcsNumbersMatchLiveContact(USER, [NUM])).toBe(false);
  });

  it("a rejected transaction: no (S2)", () => {
    contactOnTransaction({ id: "1", txStatus: "rejected" });
    expect(rcsNumbersMatchLiveContact(USER, [NUM])).toBe(false);
  });

  it("another user's transaction: no (S3)", () => {
    contactOnTransaction({ id: "1", user: OTHER });
    expect(rcsNumbersMatchLiveContact(USER, [NUM])).toBe(false);
    expect(rcsNumbersMatchLiveContact(OTHER, [NUM])).toBe(true);
  });
});

describe("rcs_cache_state (bound to the user)", () => {
  it("each user's state is their own (S4)", () => {
    updateRcsCacheState(OTHER, { extension: { version: "0.3.0", seenAt: "2026-10-01T09:00:00.000Z" } });
    updateRcsCacheState(USER, { optedIn: true, lastCacheFinishedAt: "2026-09-30T10:00:00.000Z", ownNumber: "+15555550100" });
    expect(getRcsCacheState(USER)).toMatchObject({
      lastCacheFinishedAt: "2026-09-30T10:00:00.000Z",
      ownNumber: "+15555550100",
      extensionVersion: null,
    });
    expect(getRcsCacheState(USER)?.optedInAt).toEqual(expect.any(String));
    expect(getRcsCacheState(OTHER)).toMatchObject({ optedInAt: null, lastCacheFinishedAt: null, extensionVersion: "0.3.0" });
    expect(getRcsCacheState("nobody")).toBeNull();
  });

  it("opting out clears the opt-in; a later extension report keeps what it does not mention", () => {
    updateRcsCacheState(USER, { optedIn: true, extension: { version: "0.3.0", seenAt: "2026-10-01T09:00:00.000Z" } });
    updateRcsCacheState(USER, { optedIn: false, extension: { pairedAt: "2026-10-01T09:05:00.000Z" } });
    expect(getRcsCacheState(USER)).toMatchObject({
      optedInAt: null,
      extensionVersion: "0.3.0",
      pairedAt: "2026-10-01T09:05:00.000Z",
    });
  });

  it("Force re-import resets the cache position and the own number, nothing else (S5)", () => {
    updateRcsCacheState(USER, { optedIn: true, lastCacheFinishedAt: "2026-09-30T10:00:00.000Z", ownNumber: "+15555550100" });
    updateRcsCacheState(OTHER, { lastCacheFinishedAt: "2026-09-30T10:00:00.000Z" });
    resetRcsCacheState(USER);
    expect(getRcsCacheState(USER)).toMatchObject({ lastCacheFinishedAt: null, ownNumber: null });
    expect(getRcsCacheState(USER)?.optedInAt).toEqual(expect.any(String));
    expect(getRcsCacheState(OTHER)?.lastCacheFinishedAt).toBe("2026-09-30T10:00:00.000Z");
  });
});
