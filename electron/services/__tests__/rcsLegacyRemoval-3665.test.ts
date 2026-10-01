/**
 * @jest-environment node
 */
/**
 * BACKLOG-3665 — a chat the user removed before the stable key (a legacy
 * removal on thread `gmweb-chat-<conversation id>`) blocked the re-imported
 * gmweb2 chat, yet "Show removed" listed nothing (it joins the removal's
 * thread id to messages.thread_id), so it could not be restored. Real SQL on
 * the production schema (run under Electron's Node locally).
 *
 * Mutation controls (each turns a test red):
 *   L1 importChat never moves the legacy removal         → "Show removed lists it"
 *   L2 the move drops the audit fields / makes a new row  → same test (same id, reason, ignored_at)
 *   L3 the move not scoped to the transaction             → "only that transaction's removal moves"
 *   L4 a duplicate gmweb2 removal kept beside the legacy  → "listed once"
 *   L5 the cache Sync never moves legacy removals         → "a cache Sync"
 *   L6 the move not scoped to the user                    → same test (other user's row untouched)
 *   L7 Force re-import deleting the user's removals       → "a removal survives Force re-import"
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import {
  batchInsertMessages,
  findRcsContentDuplicates,
  getMessageIdMap,
  getRcsRemovals,
  insertReactionRows,
  rcsClearDbOps,
  repointLegacyRcsRemoval,
} from "../db/syncDbService";
import { clearGoogleMessagesWebData } from "../rcsClearService";
import { REMOVED_MESSAGES_SQL } from "../db/removedCommunicationSql";
import { removeIgnoredCommunication } from "../db/communicationDbService";
import { autoLinkNewMessagesForUser } from "../autoLinkService";
import { importCacheChat, importChat, peopleFrom, rcsChatHash, type RcsIncomingChat } from "../rcsImportStore";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3665";
const OTHER = "user-3665-b";
const NUM = "+15555550199";
const CONV = "conv-3665";
const LEGACY = `gmweb-chat-${CONV}`;
const GMWEB2 = `gmweb2-${rcsChatHash([NUM])}`;

let db: DatabaseType;
let linked: string[];

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3665-${n}@example.test`, `oauth-3665-${n}`,
    );
  }
  for (const [tx, u] of [["tx-a", USER], ["tx-b", USER], ["tx-c", USER], ["tx-o", OTHER]]) {
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Test Street')").run(tx, u);
  }
  setDb(db);
  linked = [];
});

afterEach(() => db?.close());

function legacyRemoval(id: string, tx: string, user = USER, thread = LEGACY): void {
  db.prepare(
    `INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, email_thread_id, reason, ignored_at)
     VALUES (?, ?, ?, ?, ?, 'Manually unlinked by user', '2026-09-01 10:00:00')`,
  ).run(id, user, tx, thread, thread);
}

const chat: RcsIncomingChat = {
  conversationId: CONV,
  title: "Test Contact A",
  messages: [1, 2, 3].map((n) => ({
    msgId: `m${n}`, direction: "inbound" as const, sender: "x", text: `text ${n}`,
    sentAt: `2026-09-2${n}T10:00:00.000Z`, transport: "rcs" as const,
  })),
};
const people = peopleFrom([{ name: "", number: NUM }], [NUM]);

const deps = {
  getTransactionUserId: async (tx: string) =>
    (db.prepare("SELECT user_id FROM transactions WHERE id = ?").get(tx) as { user_id: string } | undefined)?.user_id ?? null,
  batchInsertMessages,
  getMessageIdMap,
  insertReactionRows,
  linkMessages: async (ids: string[]) => {
    linked.push(...ids);
  },
  linkWithoutCount: async () => {},
  getRemovals: getRcsRemovals,
  findContentDuplicates: findRcsContentDuplicates,
  repointLegacyRemoval: repointLegacyRcsRemoval,
};

const removal = (id: string) =>
  db.prepare("SELECT id, transaction_id, thread_id, email_thread_id, reason, ignored_at FROM ignored_communications WHERE id = ?").get(id);
const shown = (tx: string) =>
  db.prepare(REMOVED_MESSAGES_SQL).all(tx) as Array<{ ignored_id: string; message_id: string; thread_id: string }>;

describe("a legacy chat removal and a transaction Sync", () => {
  it("blocks the chat, then Show removed lists it under the same removal, and Restore links it (L1, L2)", async () => {
    legacyRemoval("ic-1", "tx-a");
    const first = await importChat(chat, "tx-a", deps, people);
    expect([first.stored, first.linked, first.removedByUser]).toEqual([3, 0, 3]);
    expect(linked).toEqual([]);

    // The same row (id and audit fields kept) now names the gmweb2 thread.
    expect(removal("ic-1")).toEqual({
      id: "ic-1", transaction_id: "tx-a", thread_id: GMWEB2, email_thread_id: GMWEB2,
      reason: "Manually unlinked by user", ignored_at: "2026-09-01 10:00:00",
    });
    const listed = shown("tx-a");
    expect(listed.map((r) => r.ignored_id)).toEqual(["ic-1", "ic-1", "ic-1"]);
    expect(new Set(listed.map((r) => r.thread_id))).toEqual(new Set([GMWEB2]));

    // Restore (transactions:restore-removed-message): drop the removal, link the listed ids.
    await removeIgnoredCommunication("ic-1");
    await deps.linkMessages(listed.map((r) => r.message_id));
    expect(linked.sort()).toEqual(listed.map((r) => r.message_id).sort());
    // And a later Sync links it as well (nothing blocks it any more).
    linked = [];
    const again = await importChat(chat, "tx-a", deps, people);
    expect([again.linked, again.removedByUser]).toEqual([3, 0]);
  });

  it("only that transaction's removal moves (L3)", async () => {
    legacyRemoval("ic-a", "tx-a");
    legacyRemoval("ic-b", "tx-b");
    await importChat(chat, "tx-a", deps, people);
    expect((removal("ic-a") as { thread_id: string }).thread_id).toBe(GMWEB2);
    expect((removal("ic-b") as { thread_id: string }).thread_id).toBe(LEGACY);
  });

  it("with a gmweb2 removal already there, the chat is listed once (L4)", async () => {
    legacyRemoval("ic-old", "tx-a");
    legacyRemoval("ic-new", "tx-a", USER, GMWEB2);
    await importChat(chat, "tx-a", deps, people);
    expect(removal("ic-old")).toBeUndefined();
    expect(new Set(shown("tx-a").map((r) => r.ignored_id))).toEqual(new Set(["ic-new"]));
  });

  it("a chat that was never removed is untouched and linked", async () => {
    legacyRemoval("ic-other-chat", "tx-a", USER, "gmweb-chat-another-conv");
    const r = await importChat(chat, "tx-a", deps, people);
    expect(r.linked).toBe(3);
    expect((removal("ic-other-chat") as { thread_id: string }).thread_id).toBe("gmweb-chat-another-conv");
  });
});

describe("a legacy chat removal and a cache Sync (SR A)", () => {
  it("every transaction the chat was removed from gets it on the gmweb2 thread; other users untouched (L5, L6)", async () => {
    legacyRemoval("ic-a", "tx-a");
    legacyRemoval("ic-b", "tx-b");
    legacyRemoval("ic-o", "tx-o", OTHER);
    await importCacheChat(chat, USER, deps, people);
    expect((removal("ic-a") as { thread_id: string }).thread_id).toBe(GMWEB2);
    expect((removal("ic-b") as { thread_id: string }).thread_id).toBe(GMWEB2);
    expect((removal("ic-o") as { thread_id: string }).thread_id).toBe(LEGACY);
    // The auto-link reads gmweb2 removals: both transactions now block the chat.
    expect(getRcsRemovals("tx-a", USER).threadIds.has(GMWEB2)).toBe(true);
    expect(getRcsRemovals("tx-b", USER).threadIds.has(GMWEB2)).toBe(true);
    expect(getRcsRemovals("tx-c", USER).threadIds.has(GMWEB2)).toBe(false);
    // Show removed lists the stored chat on both.
    expect(shown("tx-a")).toHaveLength(3);
    expect(shown("tx-b")).toHaveLength(3);
  });

  it("end to end: the auto-link after the cache Sync leaves the removed chat off, and links it where it was not removed", async () => {
    legacyRemoval("ic-a", "tx-a");
    db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES ('c-1', ?, 'Test Contact A')").run(USER);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES ('p-1', 'c-1', ?)").run(NUM);
    for (const tx of ["tx-a", "tx-c"]) {
      db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, 'c-1')").run(`tc-${tx}`, tx);
    }
    db.prepare("UPDATE transactions SET started_at = '2026-09-01', created_at = '2026-09-01' WHERE user_id = ?").run(USER);
    await importCacheChat(chat, USER, deps, people);
    await autoLinkNewMessagesForUser(USER);
    const linkedTo = (tx: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND (thread_id = ? OR message_id IN (SELECT id FROM messages WHERE thread_id = ?))").get(tx, GMWEB2, GMWEB2) as { n: number }).n;
    expect(linkedTo("tx-c")).toBeGreaterThan(0);
    expect(linkedTo("tx-a")).toBe(0);
  });
});

// The founder's path: Force re-import, then Sync. The removal is the user's
// decision, so Force re-import keeps it (whether legacy or already moved), and
// the next Sync lists it again under Show removed.
describe("a removal survives Force re-import (L7)", () => {
  const noFiles = { attachmentsRoot: "/none", resolve: (p: string) => p, deleteFile: () => true };
  it.each([["still legacy", false], ["already moved", true]] as const)("%s", async (_label, movedFirst) => {
    legacyRemoval("ic-1", "tx-a");
    if (movedFirst) await importChat(chat, "tx-a", deps, people);
    clearGoogleMessagesWebData(USER, rcsClearDbOps(), noFiles);
    expect(shown("tx-a")).toEqual([]);
    expect(removal("ic-1")).toBeDefined();
    const after = await importChat(chat, "tx-a", deps, people);
    expect([after.linked, after.removedByUser]).toEqual([0, 3]);
    expect(new Set(shown("tx-a").map((r) => r.ignored_id))).toEqual(new Set(["ic-1"]));
  });
});
