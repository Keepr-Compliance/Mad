/**
 * @jest-environment node
 *
 * BACKLOG-3868 - the message insert step of the iPhone sync (storeMessages ->
 * batchInsertMessages) must yield to the event loop between 500-row batches, keep
 * each batch in its own transaction, and stop at a cancel between batches.
 *
 * Before: every batch ran back to back with no yield. SR measured, arm64 Mac,
 * encrypted empty store: 10k new messages block main 383 ms, 100k new 14.8 s
 * (~75 s on a low-end Windows PC). Real sqlite driver, real schema.sql, encrypted
 * file database. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 *
 * Fixture shape transcribed from the producer, iosMessagesParser.ts mapMessage
 * (same as iPhoneSyncStorageService.dedupeRead-3868.test.ts).
 */

import * as nodePath from "path";
import * as nodeFs from "fs";
import { createHash } from "crypto";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3868-insert") },
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

// One entry per batchInsertMessages call (the rows it was handed), and a hook
// that runs after each call so a test can cancel "between batches".
const insertCalls: Array<Array<{ externalId: string }>> = [];
let mockAfterInsert: ((callNumber: number) => void) | null = null;

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
              insertCalls.push(rows);
              const out = sync.batchInsertMessages(rows, ...rest);
              mockAfterInsert?.(insertCalls.length);
              return out;
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
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { iOSMessage } from "../../types/iosMessages";

const USER = "user-3868-insert";
const BATCH = 500;
const SIZES = (process.env.KEEPR_INSERT_3868_SIZES || "10000,100000").split(",").map(Number);

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
      `[3868-insert] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}

const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const DB_DIR = nodePath.join(jest.requireActual<typeof import("os")>("os").tmpdir(), "keepr-3868-insert-db");
const KEY_HEX = "3868".repeat(16);

function openEncrypted(): DatabaseType {
  const opened = new Driver!(nodePath.join(DB_DIR, "mad.db"));
  opened.pragma(`key = "x'${KEY_HEX}'"`);
  opened.pragma("cipher_compatibility = 4");
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = NORMAL");
  return opened;
}

function guidFor(i: number): string {
  const h = createHash("sha1").update(`3868i-${i}`).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function makeMessage(i: number): iOSMessage {
  return {
    id: i + 1,
    guid: guidFor(i),
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
  conversations: [],
  onProgress?: (current: number, total: number) => void,
  sessionId?: string,
  cancelSignal?: { cancelled: boolean },
) => Promise<{ stored: number; skipped: number }>;
const storeMessages: StoreMessages = (...args) =>
  (iPhoneSyncStorageService as unknown as { storeMessages: StoreMessages }).storeMessages(...args);

function storedExternalIds(db: DatabaseType): string[] {
  return (
    db.prepare("SELECT external_id FROM messages WHERE user_id = ? ORDER BY external_id").all(USER) as {
      external_id: string;
    }[]
  ).map((r) => r.external_id);
}

maybe("BACKLOG-3868: iPhone sync message insert yields between batches (real driver, encrypted)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(DB_DIR, { recursive: true });
    db = openEncrypted();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3868i@example.test",
      "oauth-3868i",
    );
    db.close();
    db = openEncrypted();
    setDb(db);
    insertCalls.length = 0;
    mockAfterInsert = null;
  });

  afterAll(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
  });

  it.each(SIZES)("%i new messages into an empty encrypted store: same rows, a yield per batch, bounded stall", async (n) => {
    const messages: iOSMessage[] = [];
    for (let i = 0; i < n; i++) messages.push(makeMessage(i));
    const immediate = jest.spyOn(global, "setImmediate");

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const result = await storeMessages(USER, messages, []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    histogram.disable();
    const maxBlockMs = Math.round(histogram.max / 1e6);
    const wallMs = Date.now() - started;
    const yields = immediate.mock.calls.length;
    immediate.mockRestore();
    process.stderr.write(
      `[3868-insert] ${n} new messages: wall=${wallMs}ms maxEventLoopDelay=${maxBlockMs}ms batches=${insertCalls.length} setImmediate=${yields}\n`,
    );

    // Same rows: every message stored exactly once, none skipped.
    expect(result).toEqual({ stored: n, skipped: 0 });
    const expected = Array.from({ length: n }, (_, i) => guidFor(i)).sort();
    expect(storedExternalIds(db)).toEqual(expected);

    // One call per 500-row batch, in order, each at most BATCH rows.
    expect(insertCalls).toHaveLength(Math.ceil(n / BATCH));
    expect(insertCalls.every((rows) => rows.length <= BATCH)).toBe(true);
    expect(insertCalls.flat().map((r) => r.externalId)).toEqual(messages.map((m) => m.guid));

    // Yields happened: at least one setImmediate per insert batch.
    expect(yields).toBeGreaterThanOrEqual(insertCalls.length);

    // Stall bound: 100 ms, or a fifth of the run on a slower runner. Unyielded,
    // the stall is most of the run (SR: 383 ms at 10k, 14.8 s at 100k).
    expect(maxBlockMs).toBeLessThan(Math.max(100, wallMs * 0.2));
  }, 300_000);

  it("a cancel between batches stops cleanly: committed batches stay, no further batch is attempted", async () => {
    const n = 2000; // 4 batches
    const messages: iOSMessage[] = [];
    for (let i = 0; i < n; i++) messages.push(makeMessage(i));
    const cancelSignal = { cancelled: false };
    mockAfterInsert = (callNumber) => {
      if (callNumber === 2) cancelSignal.cancelled = true;
    };

    const result = await storeMessages(USER, messages, [], undefined, "session-3868", cancelSignal);

    // Two batches were attempted and committed; the third was never handed to the db.
    expect(insertCalls).toHaveLength(2);
    expect(result).toEqual({ stored: 2 * BATCH, skipped: 0 });
    const expected = messages.slice(0, 2 * BATCH).map((m) => m.guid).sort();
    expect(storedExternalIds(db)).toEqual(expected);
    // Committed rows are tagged with the session so the caller's rollback finds them.
    const tagged = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sync_session_id = ?").get("session-3868") as { c: number };
    expect(tagged.c).toBe(2 * BATCH);
  });
});
