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
 *   S6 a cancelled run saving its time (the rest never re-read)  → "an interrupted cache Sync resumes"
 *   S7 importCacheChat not skipping keys already stored           → same test (no duplicate rows)
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
import { importCacheChat, peopleFrom, type RcsIncomingChat } from "../rcsImportStore";
import { cacheSince, handleCacheJobEnded } from "../rcsCacheService";
import {
  batchInsertMessages,
  findRcsContentDuplicates,
  getMessageIdMap,
  insertReactionRows,
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

// BACKLOG-3658 (P2, SR): a cache Sync cut short (cancel, sign-out, Chrome
// closed) is simply run again: it reads the same window (nothing saved), and
// what the first run stored is not stored twice.
describe("an interrupted cache Sync resumes without duplicates (S6, S7)", () => {
  const storeDeps = { batchInsertMessages, getMessageIdMap, insertReactionRows, findContentDuplicates: findRcsContentDuplicates };
  const people = peopleFrom([{ name: "", number: NUM }], [NUM]);
  const msg = (n: number) => ({
    msgId: `m${n}`, direction: "inbound" as const, sender: "x", text: `text ${n}`,
    sentAt: `2026-09-2${n}T10:00:00.000Z`, transport: "rcs" as const,
  });
  const chat = (id: string, count: number): RcsIncomingChat => ({
    conversationId: id, title: "Test Contact A", messages: Array.from({ length: count }, (_, i) => msg(i + 1)),
  });
  const endedDeps = {
    saveFinishedAt: (u: string, iso: string) => updateRcsCacheState(u, { lastCacheFinishedAt: iso }),
    saveOwnNumber: () => {},
    commit: async () => {},
    discard: async () => {},
    autoLink: async () => {},
    now: () => Date.parse("2026-09-30T12:00:00.000Z"),
  };
  const rows = () => db.prepare("SELECT external_id FROM messages WHERE user_id = ?").all(USER) as Array<{ external_id: string }>;

  it("run 1 is cut short; run 2 reads the same window and stores only what is new", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    updateRcsCacheState(USER, { lastCacheFinishedAt: "2026-09-25T12:00:00.000Z" });
    const since1 = cacheSince(now, getRcsCacheState(USER)?.lastCacheFinishedAt);

    // Run 1: chat A, then the first 2 of chat B's 4 — then cancelled.
    expect((await importCacheChat(chat("conv-a", 3), USER, storeDeps, people)).stored).toBe(3);
    const peopleB = peopleFrom([{ name: "", number: "+15555550142" }], ["+15555550142"]);
    expect((await importCacheChat(chat("conv-b", 2), USER, storeDeps, peopleB)).stored).toBe(2);
    await handleCacheJobEnded(
      { kind: "cache", userId: USER, snapshot: { state: "cancelled", createdAt: "2026-09-30T11:00:00.000Z", jobId: "job-1" }, detectedOwnNumber: null },
      endedDeps,
    );
    // S6: nothing saved — run 2 reads the same window.
    expect(cacheSince(now, getRcsCacheState(USER)?.lastCacheFinishedAt)).toBe(since1);

    // Run 2: everything again, plus B's last 2.
    const a2 = await importCacheChat(chat("conv-a", 3), USER, storeDeps, people);
    const b2 = await importCacheChat(chat("conv-b", 4), USER, storeDeps, peopleB);
    expect([a2.stored, a2.alreadyPresent]).toEqual([0, 3]);
    expect([b2.stored, b2.alreadyPresent]).toEqual([2, 2]);
    // S7: no row twice.
    const ids = rows().map((r) => r.external_id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);

    // Run 2 finishes: its START time is saved (SR P1 optional).
    await handleCacheJobEnded(
      { kind: "cache", userId: USER, snapshot: { state: "finished", createdAt: "2026-09-30T11:30:00.000Z", jobId: "job-2" }, detectedOwnNumber: null },
      endedDeps,
    );
    expect(getRcsCacheState(USER)?.lastCacheFinishedAt).toBe("2026-09-30T11:30:00.000Z");
  });
});
