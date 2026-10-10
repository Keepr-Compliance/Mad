/**
 * @jest-environment node
 *
 * BACKLOG-3868 — the duplicate check at the start of every iPhone sync
 * (storeMessages) must not block the main event loop, and must import exactly
 * the messages the old full-set check imported.
 *
 * Every iPhone sync hands storeMessages the phone's WHOLE message history (the
 * parser reads the backup's sms.db in full), so on a ~670k-message store all but
 * a few dozen messages are already stored. The old check loaded every stored
 * external_id of the user into a Set in one synchronous read: 427-545 ms of
 * blocked main on a Mac with 671k encrypted messages (SR measurement,
 * BACKLOG-3868), several times that on a low-end Windows PC.
 *
 * Real sqlite driver against the real `schema.sql`, encrypted file database,
 * reopened cold after seeding. Run under Electron —
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 *
 * Fixture shape transcribed from the producer, iosMessagesParser.ts mapMessage
 * (`guid: row.guid || ""`, `handle` from the handle table, `service` "iMessage" |
 * "SMS", `date` a Date, `attachments` an array). sms.db message GUIDs are
 * uppercase UUID strings; the `""` fallback is the parser's own value for a
 * missing guid, which storeMessages rejects as invalid.
 */

import * as nodePath from "path";
import * as nodeFs from "fs";
import { createHash } from "crypto";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3868-dedupe") },
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

// Every row array storeMessages hands to the insert, so the test can assert on
// insert ATTEMPTS. INSERT OR IGNORE + the UNIQUE (user_id, external_id) index
// would hide a pre-filter that let stored messages through: {stored, skipped}
// come out the same either way.
const insertAttempts: Array<Array<{ externalId: string }>> = [];

// storeMessages reaches the db layer only through databaseService. Route every
// call it can make to the REAL db module, so the production SQL runs.
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
          const fn = sync[name];
          return typeof fn === "function" ? fn : undefined;
        },
      },
    ),
  };
});

import { setDb } from "../db/core/dbConnection";
import { MESSAGE_EXTERNAL_IDS_FIRST_PAGE_SQL, MESSAGE_EXTERNAL_IDS_NEXT_PAGE_SQL } from "../db/syncDbService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";

const USER = "user-3868-dedupe";
const STORED = Number(process.env.KEEPR_DEDUPE_3868_ROWS || 400_000);
const NEW = 50;

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(
      nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    );
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(
      `[3868-dedupe] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}

const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const DB_DIR = nodePath.join(jest.requireActual<typeof import("os")>("os").tmpdir(), "keepr-3868-dedupe-db");
const KEY_HEX = "3868".repeat(16);

function openEncrypted(): DatabaseType {
  const opened = new Driver!(nodePath.join(DB_DIR, "mad.db"));
  opened.pragma(`key = "x'${KEY_HEX}'"`);
  opened.pragma("cipher_compatibility = 4");
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = NORMAL");
  return opened;
}

/** sms.db-shaped message GUID: uppercase UUID, deterministic per index. */
function guidFor(i: number): string {
  const h = createHash("sha1").update(`3868-${i}`).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function makeMessage(i: number, guid: string = guidFor(i)): iOSMessage {
  return {
    id: i + 1,
    guid,
    text: `message body ${i}`,
    audioTranscript: null,
    handle: i % 3 === 0 ? "+15555550100" : "someone@example.test",
    isFromMe: i % 2 === 0,
    date: new Date(1_700_000_000_000 + i * 1000),
    dateRead: null,
    dateDelivered: null,
    service: i % 4 === 0 ? "SMS" : "iMessage",
    attachments: [],
  };
}

type StoreMessages = (
  userId: string,
  messages: iOSMessage[],
  conversations: iOSConversation[],
) => Promise<{ stored: number; skipped: number }>;
const storeMessages: StoreMessages = (...args) =>
  (iPhoneSyncStorageService as unknown as { storeMessages: StoreMessages }).storeMessages(...args);

function storedExternalIds(db: DatabaseType): string[] {
  return (
    db.prepare("SELECT external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL ORDER BY external_id").all(USER) as {
      external_id: string;
    }[]
  ).map((r) => r.external_id);
}

maybe("BACKLOG-3868: iPhone sync duplicate check (real driver, encrypted)", () => {
  let db: DatabaseType;

  beforeAll(() => {
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(DB_DIR, { recursive: true });
    db = openEncrypted();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    for (const id of [USER, "other-user"]) {
      db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
        id,
        `${id}@example.test`,
        `oauth-${id}`,
      );
    }
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants,
        participants_flat, thread_id, sent_at, has_attachments, message_type, metadata, created_at)
       VALUES (?, ?, 'imessage', ?, 'inbound', ?, '{}', '15555550100', 'ios-chat-1', ?, 0, 'text', '{}', CURRENT_TIMESTAMP)`,
    );
    const body = "x".repeat(600);
    db.transaction(() => {
      for (let i = 0; i < STORED; i++) {
        ins.run(`msg-${i}`, USER, guidFor(i), body, new Date(1_700_000_000_000 + i * 1000).toISOString());
      }
      // Another user's copy of one of this sync's NEW guids: must not count as stored.
      ins.run("other-msg", "other-user", guidFor(STORED + 1), body, new Date().toISOString());
      // A stored row with no external_id: never a duplicate of anything.
      ins.run("no-ext", USER, null, body, new Date().toISOString());
    })();
    db.close();
    db = openEncrypted();
    setDb(db);
  }, 300_000);

  afterAll(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
  });

  it("whole-history sync: imports exactly the new messages once, skips the rest, no long main-thread stall", async () => {
    const before = storedExternalIds(db);
    // The phone's whole history (all stored) + NEW new messages, in parser order
    // (ascending ROWID), plus: 3 repeats of new guids later in the same sync, 2
    // repeats of stored guids, and the parser's "" fallback for a missing guid.
    const messages: iOSMessage[] = [];
    for (let i = 0; i < STORED + NEW; i++) messages.push(makeMessage(i));
    messages.push(makeMessage(STORED + 5), makeMessage(STORED + 6), makeMessage(STORED + 5));
    messages.push(makeMessage(7), makeMessage(STORED - 1));
    messages.push(makeMessage(STORED + NEW + 1, ""));
    insertAttempts.length = 0;

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const result = await storeMessages(USER, messages, []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    histogram.disable();
    const maxBlockMs = Math.round(histogram.max / 1e6);
    const wallMs = Date.now() - started;
    process.stderr.write(
      `[3868-dedupe] storeMessages ${STORED} stored + ${NEW} new: wall=${wallMs}ms maxEventLoopDelay=${maxBlockMs}ms\n`,
    );

    // Insert attempts: exactly the NEW genuinely new guids, each once, in order.
    const attempted = insertAttempts.flat().map((r) => r.externalId);
    const expectedNew = Array.from({ length: NEW }, (_, k) => guidFor(STORED + k));
    expect(attempted).toEqual(expectedNew);

    // Stored rows: everything that was there, plus the new guids; nothing twice.
    const after = storedExternalIds(db);
    expect(after).toEqual([...before, ...expectedNew].sort());
    expect(new Set(after).size).toBe(after.length);

    // Counts: identical to the old full-set check (stored = new; skipped = all the rest).
    expect(result).toEqual({ stored: NEW, skipped: messages.length - NEW });

    // A second, identical sync imports nothing and attempts nothing.
    insertAttempts.length = 0;
    const again = await storeMessages(USER, messages, []);
    expect(again).toEqual({ stored: 0, skipped: messages.length });
    expect(insertAttempts.flat()).toHaveLength(0);

    // Stall bound, BACKLOG-3785 form: 250 ms or a quarter of the run, whichever
    // is larger. A single synchronous read of every id is most of the run.
    expect(maxBlockMs).toBeLessThan(Math.max(250, wallMs * 0.25));
  }, 300_000);
});

// Page boundaries: the duplicate check reads the stored ids in pages of 5000
// (DEDUPE_PAGE). Sweep stored counts around one and two pages; at each, a sync of
// the whole history plus one new message must attempt exactly the new one.
maybe("BACKLOG-3868: duplicate check across page boundaries (real driver)", () => {
  let db: DatabaseType;
  const seed = (n: number): void => {
    db.prepare("DELETE FROM messages").run();
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, participants, sent_at, created_at)
       VALUES (?, ?, 'imessage', ?, 'inbound', '{}', '2026-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
    );
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`m-${i}`, USER, guidFor(i));
    })();
  };

  beforeAll(() => {
    db = new Driver!(":memory:");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3868@example.test",
      "oauth-3868",
    );
    setDb(db);
  });

  afterAll(() => db?.close());

  it.each([0, 1, 4999, 5000, 5001, 9999, 10000, 10001])("%i stored ids", async (n) => {
    seed(n);
    const messages: iOSMessage[] = [];
    for (let i = 0; i <= n; i++) messages.push(makeMessage(i));
    insertAttempts.length = 0;
    const result = await storeMessages(USER, messages, []);
    expect(insertAttempts.flat().map((r) => r.externalId)).toEqual([guidFor(n)]);
    expect(result).toEqual({ stored: 1, skipped: n });
  });

  it("both page reads are range reads on idx_messages_user_external_id (no ANALYZE, as in production)", () => {
    const detail = (sql: string, params: unknown[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(" | ");
    const first = detail(MESSAGE_EXTERNAL_IDS_FIRST_PAGE_SQL, [USER, 5000]);
    const next = detail(MESSAGE_EXTERNAL_IDS_NEXT_PAGE_SQL, [USER, "A", 5000]);
    // SQLite reads IS NOT NULL as the range external_id > NULL.
    expect(first).toMatch(/SEARCH messages USING COVERING INDEX idx_messages_user_external_id \(user_id=\?( AND external_id>\?)?\)/);
    expect(next).toMatch(/SEARCH messages USING COVERING INDEX idx_messages_user_external_id \(user_id=\? AND external_id>\?\)/);
    // Index order already is the ORDER BY: no sort step.
    expect(first + next).not.toMatch(/TEMP B-TREE/);
  });
});
