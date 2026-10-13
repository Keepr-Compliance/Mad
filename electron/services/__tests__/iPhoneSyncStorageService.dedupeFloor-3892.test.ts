/**
 * @jest-environment node
 *
 * BACKLOG-3892 S7 — the iPhone sync's duplicate check reads only the stored ids it
 * can still need. With parse floors (S1) a sync hands storeMessages the texts at or
 * after each chat's floor, not the phone's whole history; the stored history older
 * than this sync's earliest text can never match one of its guids. The check now
 * reads stored external_ids with sent_at >= (earliest text − 24 h), keyset-paged on
 * idx_messages_user_sent, and still attempts exactly the genuinely new messages.
 *
 * Real sqlite driver against the real `schema.sql`. Fixture shape transcribed from
 * the producer as in iPhoneSyncStorageService.dedupeRead-3868.test.ts
 * (iosMessagesParser.ts mapMessage: uppercase-UUID guid, Date `date`).
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import { createHash } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3892-dedupe-floor") },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

// Insert ATTEMPTS (INSERT OR IGNORE would hide a pre-filter miss in {stored, skipped})
// and every stored id the duplicate check READ.
const insertAttempts: Array<Array<{ externalId: string }>> = [];
const idsRead: string[] = [];
// The sent_at bound each since-page read was called with, and every guid the
// exact lookup (undated texts) was asked about.
const sinceBounds: string[] = [];
const exactLookups: string[] = [];

jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  return {
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === "batchInsertMessages") {
            return (rows: Array<{ externalId: string }>, ...rest: unknown[]) => {
              insertAttempts.push(rows);
              return sync.batchInsertMessages(rows, ...rest);
            };
          }
          if (name === "getMessageExternalIdsPage") {
            return (...args: unknown[]) => {
              const page = sync.getMessageExternalIdsPage(...args) as string[];
              idsRead.push(...page);
              return page;
            };
          }
          if (name === "getMessageExternalIdsSincePage") {
            return (...args: unknown[]) => {
              sinceBounds.push(args[1] as string);
              const page = sync.getMessageExternalIdsSincePage(...args) as { ids: string[] };
              idsRead.push(...page.ids);
              return page;
            };
          }
          if (name === "getMessageIdsByExternalIds") {
            return (userId: string, ids: string[]) => {
              exactLookups.push(...ids);
              return sync.getMessageIdsByExternalIds(userId, ids);
            };
          }
          const fn = sync[name];
          return typeof fn === "function" ? fn : undefined;
        },
      },
    ),
  };
});

import { setDb } from "../db/core/dbConnection";
import { MESSAGE_EXTERNAL_IDS_SINCE_FIRST_PAGE_SQL, MESSAGE_EXTERNAL_IDS_SINCE_NEXT_PAGE_SQL } from "../db/syncDbService";
import { iPhoneSyncStorageService, dedupeSinceIso } from "../iPhoneSyncStorageService";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";

const USER = "user-3892-dedupe-floor";
const DAY = 86_400_000;
/** The settings floor F of the sync (1.5 months before 2026-10-10). */
const F = Date.UTC(2026, 7, 25);
/** A deal chat read back to its deal start − 24 h, below F. */
const DEAL_FLOOR = Date.UTC(2025, 11, 1) - DAY;

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(
      nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    );
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3892-dedupe-floor] real sqlite driver unavailable (${String(error).slice(0, 80)}); run under Electron\n`);
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

function guidFor(tag: string): string {
  const h = createHash("sha1").update(`3892-s7-${tag}`).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

let nextId = 1;
function msg(tag: string, dateMs: number): iOSMessage {
  return {
    id: nextId++,
    guid: guidFor(tag),
    text: `body ${tag}`,
    audioTranscript: null,
    handle: "+15555550100",
    isFromMe: false,
    date: new Date(dateMs),
    dateRead: null,
    dateDelivered: null,
    service: "iMessage",
    attachments: [],
  };
}

type StoreMessages = (userId: string, messages: iOSMessage[], conversations: iOSConversation[]) => Promise<{ stored: number; skipped: number }>;
const storeMessages: StoreMessages = (...args) =>
  (iPhoneSyncStorageService as unknown as { storeMessages: StoreMessages }).storeMessages(...args);

maybe("BACKLOG-3892 S7: duplicate check bounded by this sync's earliest text (real driver)", () => {
  let db: DatabaseType;
  let row = 0;
  const store = (tag: string, sentAtMs: number | string): void => {
    row += 1;
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, participants, sent_at, created_at)
       VALUES (?, ?, 'imessage', ?, 'inbound', '{}', ?, CURRENT_TIMESTAMP)`,
    ).run(`m-${row}`, USER, guidFor(tag), typeof sentAtMs === "string" ? sentAtMs : new Date(sentAtMs).toISOString());
  };

  beforeEach(() => {
    db = new Driver!(":memory:");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(USER, "s7@example.test", "oauth-s7");
    setDb(db);
    insertAttempts.length = 0;
    idsRead.length = 0;
    sinceBounds.length = 0;
    exactLookups.length = 0;
    row = 0;
  });
  afterEach(() => db.close());

  it("a floored sync: stored history older than its earliest text is not read; exactly the new texts are attempted", async () => {
    // Old history (before every floor of this sync): 300 texts in 2024.
    for (let i = 0; i < 300; i++) store(`old-${i}`, Date.UTC(2024, 0, 1) + i * DAY);
    // A widened deal chat: stored texts BELOW F (the likely wrong bound = F re-attempts them).
    store("deal-a", DEAL_FLOOR + 3 * DAY);
    store("deal-b", DEAL_FLOOR + 40 * DAY);
    // In-window texts already stored.
    for (let i = 0; i < 20; i++) store(`win-${i}`, F + i * DAY);

    // What the floored sync hands over: the deal chat from its floor, the window, 3 new.
    const messages = [
      msg("deal-a", DEAL_FLOOR + 3 * DAY),
      msg("deal-b", DEAL_FLOOR + 40 * DAY),
      ...Array.from({ length: 20 }, (_, i) => msg(`win-${i}`, F + i * DAY)),
      msg("new-1", F + 30 * DAY),
      msg("new-2", F + 31 * DAY),
      msg("new-deal", DEAL_FLOOR + 50 * DAY),
    ];
    const result = await storeMessages(USER, messages, []);

    expect(insertAttempts.flat().map((r) => r.externalId)).toEqual([guidFor("new-1"), guidFor("new-2"), guidFor("new-deal")]);
    expect(result).toEqual({ stored: 3, skipped: 22 });
    // Read: the 22 stored ids at/after the earliest text − 24 h — none of the 300 old ones.
    expect(idsRead).toHaveLength(22);
    expect(idsRead.some((id) => id === guidFor("old-0") || id === guidFor("old-299"))).toBe(false);
  });

  it("boundary: a stored id exactly 24 h before the earliest text is read; 1 ms earlier is not", async () => {
    const earliest = F + 10 * DAY;
    store("at-bound", earliest - DAY);
    store("below-bound", earliest - DAY - 1);
    store("same", earliest);
    await storeMessages(USER, [msg("same", earliest)], []);
    expect(idsRead.sort()).toEqual([guidFor("at-bound"), guidFor("same")].sort());
    expect(insertAttempts.flat()).toHaveLength(0);
  });

  it.each([4999, 5000, 5001, 10001])("keyset paging with identical sent_at across pages (%i stored)", async (count) => {
    const t = Date.UTC(2026, 8, 1);
    db.transaction(() => {
      for (let i = 0; i < count; i++) store(`tie-${i}`, t);
    })();
    const messages = Array.from({ length: count }, (_, i) => msg(`tie-${i}`, t));
    messages.push(msg("tie-new", t));
    const result = await storeMessages(USER, messages, []);
    expect(insertAttempts.flat().map((r) => r.externalId)).toEqual([guidFor("tie-new")]);
    expect(result).toEqual({ stored: 1, skipped: count });
    expect(new Set(idsRead).size).toBe(count);
  });

  it("no valid date in the sync: falls back to reading every stored id", async () => {
    store("old", Date.UTC(2020, 0, 1));
    store("x", Date.UTC(2026, 0, 1));
    const bad = { ...msg("x", 0), date: new Date(NaN) };
    expect(dedupeSinceIso([bad])).toBeNull();
    expect(dedupeSinceIso([])).toBeNull();
    await storeMessages(USER, [bad], []);
    expect(idsRead.sort()).toEqual([guidFor("old"), guidFor("x")].sort());
    expect(insertAttempts.flat()).toHaveLength(0);
  });

  it("an undated text (date <= 0) does not pull the bound to 1969; undated texts are still deduplicated exactly", async () => {
    // Old history the bounded read must not touch.
    for (let i = 0; i < 50; i++) store(`old-${i}`, Date.UTC(2024, 0, 1) + i * DAY);
    // An undated text already stored at the epoch (what new Date(0).toISOString() writes),
    // and one stored by another writer with a different sent_at below the bound.
    store("undated-stored", 0);
    store("undated-other", Date.UTC(2023, 5, 1));
    // In-window texts already stored.
    for (let i = 0; i < 5; i++) store(`w-${i}`, F + i * DAY);

    const earliestReal = F;
    const messages = [
      ...Array.from({ length: 5 }, (_, i) => msg(`w-${i}`, F + i * DAY)),
      msg("undated-stored", 0),
      msg("undated-other", -5_000),
      msg("undated-new", 0),
      msg("dated-new", F + 9 * DAY),
    ];
    expect(dedupeSinceIso(messages)).toBe(new Date(earliestReal - DAY).toISOString());

    const result = await storeMessages(USER, messages, []);

    // Bounded read at (earliest real date − 24 h), never 1969.
    expect(sinceBounds).toEqual([new Date(earliestReal - DAY).toISOString()]);
    expect(idsRead.sort()).toEqual(Array.from({ length: 5 }, (_, i) => guidFor(`w-${i}`)).sort());
    // The undated guids were looked up exactly; the two stored ones are skipped.
    expect(exactLookups.sort()).toEqual([guidFor("undated-stored"), guidFor("undated-other"), guidFor("undated-new")].sort());
    expect(insertAttempts.flat().map((r) => r.externalId).sort()).toEqual([guidFor("undated-new"), guidFor("dated-new")].sort());
    expect(result).toEqual({ stored: 2, skipped: 7 });
  });

  it("texts grouped by chat: a LATER chat holding the overall earliest text sets the bound", async () => {
    // Chat A (handed over first) starts at F + 20 d; chat B (second) starts at its deal floor, well below.
    const chatBFirst = DEAL_FLOOR + 2 * DAY;
    store("b-0", chatBFirst);
    store("b-1", chatBFirst + DAY);
    store("a-0", F + 20 * DAY);
    const messages = [
      msg("a-0", F + 20 * DAY),
      msg("a-new", F + 21 * DAY),
      msg("b-0", chatBFirst),
      msg("b-1", chatBFirst + DAY),
      msg("b-new", chatBFirst + 2 * DAY),
    ];
    expect(dedupeSinceIso(messages)).toBe(new Date(chatBFirst - DAY).toISOString());

    const result = await storeMessages(USER, messages, []);

    expect(sinceBounds).toEqual([new Date(chatBFirst - DAY).toISOString()]);
    expect(insertAttempts.flat().map((r) => r.externalId)).toEqual([guidFor("a-new"), guidFor("b-new")]);
    expect(result).toEqual({ stored: 2, skipped: 3 });
  });

  it("both page reads are range reads on idx_messages_user_sent with no sort step (no ANALYZE, as in production)", () => {
    const detail = (sql: string, params: unknown[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(" | ");
    const first = detail(MESSAGE_EXTERNAL_IDS_SINCE_FIRST_PAGE_SQL, [USER, "2026-01-01", 5000]);
    const next = detail(MESSAGE_EXTERNAL_IDS_SINCE_NEXT_PAGE_SQL, [USER, "2026-01-01", "2026-02-01", 7, 5000]);
    expect(first).toMatch(/SEARCH messages USING INDEX idx_messages_user_sent \(user_id=\? AND sent_at>\?\)/);
    expect(next).toMatch(/SEARCH messages USING INDEX idx_messages_user_sent \(user_id=\? AND sent_at>\?\)/);
    expect(first + next).not.toMatch(/TEMP B-TREE/);
  });
});
