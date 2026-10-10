/**
 * @jest-environment node
 *
 * BACKLOG-3816 PC final check (2026-10-10): the attached-thread identity scan (every text
 * message of the user, ~671k rows on the founder's PC, plus a JSON parse per row) blocked
 * the main process 11-13 s after every transaction update and ~57 s after a sync. It now
 * runs on the contact query worker.
 *
 * This suite starts the REAL worker (compiled from contactQueryWorker.ts) on a REAL
 * encrypted database with 150k text messages. The gates are the index (same as the
 * main-thread build, same row count) and WHERE it ran: on a dedicated worker, so a contact
 * read on the shared pool issued meanwhile is not queued behind it. Event-loop stalls are
 * printed, not asserted (runner speed varies). Real driver: run under Electron —
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  initializePool,
  isPoolReady,
  queryContacts,
  DedicatedWorkerError,
  getDedicatedWorkerCountForTests,
  queryOnDedicatedWorker,
  setContactWorkerPathForTests,
  shutdownPool,
} from "../contactWorkerPool";
import { readOneToOneThreadIndexOn, type ThreadIdentityIndex } from "../../services/db/threadIdentityIndexDb";
import { runThreadIdentityRequestOn, type TargetedThreadIdentity } from "../../services/db/threadIdentityTargetedDb";
import { candidateMessageThreadsSql } from "../../services/db/autoLinkSql";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3816".repeat(16);
const USER = "user-3816";
const MESSAGES = 150_000;
const THREADS = 3_000;

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3816] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

maybe("contact query worker: thread identity index off the main thread (BACKLOG-3816)", () => {
  let dir: string;
  let dbPath: string;

  function open(readonly = false): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath, readonly ? { readonly: true } : undefined);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    if (!readonly) db.pragma("journal_mode = WAL");
    return db;
  }

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3816-identity-"));
    dbPath = nodePath.join(dir, "mad.db");
    const db = open();
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, thread_id TEXT,
      direction TEXT, participants TEXT, duplicate_of TEXT)`);
    const ins = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, NULL)");
    db.transaction(() => {
      for (let i = 0; i < MESSAGES; i++) {
        const t = i % THREADS;
        // Reserved 555-01xx numbers only (public repo): area code varies per hundred threads.
        const phone = `+1${200 + Math.floor(t / 100)}5550${100 + (t % 100)}`;
        const inbound = i % 2 === 0;
        // Every 10th thread is a group (two members): absent from the 1:1 index.
        const members = t % 10 === 0 ? [phone, "+19985550150"] : undefined;
        const participants = inbound
          ? { from: phone, to: "+19995550100", ...(members ? { chat_members: members } : {}) }
          : { from: "+19995550100", to: [phone], ...(members ? { chat_members: members } : {}) };
        ins.run(`m${i}`, USER, i % 3 === 0 ? "sms" : "imessage", `T${t}`, inbound ? "inbound" : "outbound", JSON.stringify(participants));
      }
    })();
    db.close();
    const workerScript = nodePath.join(dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
      // The bundle sits in a temp dir: the native driver is required from this repo by
      // absolute path (left out of the bundle).
      plugins: [
        {
          name: "driver-from-repo",
          setup(b) {
            b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
          },
        },
      ],
      logLevel: "silent",
    });
    setContactWorkerPathForTests(workerScript);
    await initializePool(dbPath, KEY_HEX);
  }, 180_000);

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    // Windows can hold a file briefly after a handle closes (antivirus, indexer): retry.
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 50)); // the histogram records nothing before its first tick
    const value = await work();
    await new Promise((r) => setTimeout(r, 50));
    h.disable();
    return { value, maxMs: Math.round(h.max / 1e6) };
  }

  it("a dedicated worker builds the same index as the main thread (stall numbers printed)", async () => {
    expect(isPoolReady()).toBe(true);
    const onWorker = await maxStallDuring(
      async () => (await queryOnDedicatedWorker("threadIdentity", USER, 120_000))[0] as ThreadIdentityIndex,
    );
    const db = open(true);
    let onMain: { value: ThreadIdentityIndex; maxMs: number };
    try {
      onMain = await maxStallDuring(async () => readOneToOneThreadIndexOn(db, USER));
    } finally {
      db.close();
    }
    process.stderr.write(
      `[3816] identity index over ${MESSAGES} msgs: dedicated worker maxEventLoopDelay=${onWorker.maxMs}ms; ` +
        `main-thread control maxEventLoopDelay=${onMain.maxMs}ms\n`,
    );
    expect(onWorker.value.rows).toBe(MESSAGES);
    expect(onMain.value.rows).toBe(MESSAGES);
    expect(onWorker.value.oneToOne.length).toBe(THREADS - THREADS / 10);
    expect(new Map(onWorker.value.oneToOne)).toEqual(new Map(onMain.value.oneToOne));
  }, 180_000);

  // BACKLOG-3868: the targeted read the expansion now asks for, on the same real worker.
  it("targeted read on the dedicated worker: same identities as the full index, a small fraction of the rows", async () => {
    const attachedThreadIds = ["T1", "T2", "T10"]; // T10 is a group
    const request = { kind: "targeted" as const, attachedThreadIds };
    const onWorker = await maxStallDuring(
      async () =>
        (await queryOnDedicatedWorker("threadIdentityTargeted", USER, 120_000, { request }))[0] as TargetedThreadIdentity,
    );
    const db = open(true);
    let full: ThreadIdentityIndex;
    let onMain: TargetedThreadIdentity;
    try {
      full = readOneToOneThreadIndexOn(db, USER);
      onMain = runThreadIdentityRequestOn(db, USER, request) as TargetedThreadIdentity;
    } finally {
      db.close();
    }
    const fullToken = new Map(full.oneToOne);
    const pooled = new Set(attachedThreadIds.map((t) => fullToken.get(t)).filter((t): t is string => !!t));
    expect(pooled.size).toBe(2);
    const expected = new Map(full.oneToOne.filter(([, token]) => pooled.has(token)));
    expect(new Map(onWorker.value.oneToOne)).toEqual(expected);
    expect(new Map(onWorker.value.attached)).toEqual(new Map(attachedThreadIds.map((t) => [t, fullToken.get(t) ?? null])));
    expect(onWorker.value).toEqual(onMain);
    expect(onWorker.value.rows).toBeLessThan(MESSAGES / 100);
    process.stderr.write(
      `[3868] targeted read over ${MESSAGES} msgs: rows=${onWorker.value.rows} supersetThreads=${onWorker.value.supersetThreads} ` +
        `dedicated worker maxEventLoopDelay=${onWorker.maxMs}ms\n`,
    );
  }, 180_000);

  // BACKLOG-3868: the auto-link candidate read (create / add contact / post-sync auto-link).
  it("candidate-thread read on the dedicated worker returns the main-thread rows", async () => {
    // The fixture table has only the identity columns; add the ones the statement reads.
    const w = open();
    try {
      for (const col of ["participants_flat TEXT", "transaction_id TEXT", "sent_at TEXT", "associated_message_type INTEGER", "message_type TEXT"]) {
        try {
          w.exec(`ALTER TABLE messages ADD COLUMN ${col}`);
        } catch {
          /* added by an earlier run */
        }
      }
      w.exec("CREATE TABLE IF NOT EXISTS communications (thread_id TEXT, transaction_id TEXT)");
      w.exec("CREATE TABLE IF NOT EXISTS ignored_communications (thread_id TEXT, transaction_id TEXT)");
      w.exec("UPDATE messages SET participants_flat = replace(replace(participants, '\"', ''), '+', ''), sent_at = '2025-01-01' WHERE participants_flat IS NULL");
    } finally {
      w.close();
    }
    const params = [USER, "txn-x", "txn-x", "txn-x", "%2015550101%", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"];
    const onWorker = await maxStallDuring(async () =>
      queryOnDedicatedWorker("candidateMessageThreads", USER, 120_000, { phoneCount: 1, params }),
    );
    const r = open(true);
    let onMain: unknown[];
    try {
      onMain = r.prepare(candidateMessageThreadsSql(1)).all(...params);
    } finally {
      r.close();
    }
    expect(onMain.length).toBeGreaterThan(0);
    expect(onWorker.value).toEqual(onMain);
    process.stderr.write(`[3868] candidate read over ${MESSAGES} msgs on the worker: maxEventLoopDelay=${onWorker.maxMs}ms\n`);
  }, 180_000);

  it("a contact read on the shared pool issued during the identity read is answered first, not queued behind it", async () => {
    const order: string[] = [];
    const long = queryOnDedicatedWorker("threadIdentity", USER, 120_000).then((d) => {
      order.push("identity");
      return d;
    });
    // The shared worker answers this at once (a user with no messages) — unless the
    // identity read is ahead of it on that same worker.
    const short = queryContacts("threadIdentity", "user-without-messages", 120_000).then((d) => {
      order.push("contact read");
      return d;
    });
    const [longData, shortData] = await Promise.all([long, short]);
    expect((longData[0] as ThreadIdentityIndex).rows).toBe(MESSAGES);
    expect((shortData[0] as ThreadIdentityIndex).rows).toBe(0);
    expect(order).toEqual(["contact read", "identity"]);
  }, 180_000);
  // BACKLOG-3816 fix round: the short-lived worker must be GONE after the query — it holds
  // an open connection to the encrypted database and the key. Waits for the exit event.
  async function expectNoLiveDedicatedWorker(): Promise<void> {
    for (let i = 0; i < 400 && getDedicatedWorkerCountForTests() > 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(getDedicatedWorkerCountForTests()).toBe(0);
  }

  it("the dedicated worker exits after a successful query", async () => {
    await queryOnDedicatedWorker("threadIdentity", "user-without-messages", 120_000);
    await expectNoLiveDedicatedWorker();
  }, 60_000);

  it("the dedicated worker exits after a failed query", async () => {
    await expect(
      queryOnDedicatedWorker("no-such-query" as unknown as Parameters<typeof queryOnDedicatedWorker>[0], USER, 120_000),
    ).rejects.toMatchObject({ code: "failed" });
    await expectNoLiveDedicatedWorker();
  }, 60_000);

  it("the dedicated worker exits after a timeout", async () => {
    const err = await queryOnDedicatedWorker("threadIdentity", USER, 1).catch((e) => e);
    expect(err).toBeInstanceOf(DedicatedWorkerError);
    expect(err.code).toBe("timeout");
    await expectNoLiveDedicatedWorker();
  }, 60_000);

  // MUST stay last: it shuts the pool down. A Windows run failed EBUSY unlinking mad.db
  // because shutdownPool() returned before the workers had closed the file.
  it("after an awaited shutdownPool no worker is alive and the database file can be moved", async () => {
    const pending = queryOnDedicatedWorker("threadIdentity", USER, 120_000).catch((e) => e);
    // The worker is registered synchronously and is still starting / opening the file.
    expect(getDedicatedWorkerCountForTests()).toBe(1);
    await shutdownPool();
    expect(getDedicatedWorkerCountForTests()).toBe(0);
    expect(isPoolReady()).toBe(false);
    const moved = nodePath.join(dir, "mad.moved.db");
    nodeFs.renameSync(dbPath, moved);
    expect(nodeFs.existsSync(moved)).toBe(true);
    expect(await pending).toBeInstanceOf(DedicatedWorkerError);
  }, 60_000);
});
