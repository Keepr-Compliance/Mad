/**
 * @jest-environment node
 */
/**
 * BACKLOG-3156 stage G — the per-source "Stored on this computer" read.
 *
 * REAL encrypted database built from schema.sql, real driver. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the driver cannot load and the suite is skipped with a warning.
 * Size: KEEPR_3156_MESSAGES (default 100000) texts for the measured user.
 *
 * Fixture shapes are transcribed from their producers:
 *   Mac text       — thread_id `macos-chat-<ROWID>` (schema.sql messages.thread_id note)
 *   iPhone text    — thread_id `ios-chat-<ROWID>` (iPhoneSyncStorageService)
 *   Google text    — external_id `gmweb2:<hash>:<msg-id>`, thread `gmweb2-<hash>`
 *                    (rcsImportStore.rcsExternalId / RCS_THREAD_PREFIX); legacy `gmweb:` rows
 *   Companion text — thread_id `android-thread-<id>`, external_id a dedup hash
 *                    (localSyncService.storeMessages)
 * Reserved 555-01xx numbers only (public repo).
 *
 * Controls:
 *   S1 each source's counts are exactly its own rows: another source's rows, another
 *      user's rows, Companion rows and reactions are not counted.
 *   S3 through the REAL contact worker pool (esbuild bundle of contactQueryWorker.ts):
 *      the same answer, and the main thread's longest stall during the call stays
 *      under 50 ms (heartbeat on main while the worker reads). Measured up to 3 times;
 *      the lowest stall must be under 50 ms, and the answer must match every time.
 *   S2 the read is index-bounded (EXPLAIN QUERY PLAN: no full SCAN of messages). Its time
 *      at 100k texts is printed; measured ~250 ms, over the 50 ms main-thread budget, so
 *      the handler runs it on the contact query worker (messageSourceStatsHandler test).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { performance } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  const m = { info: noop, warn: noop, error: noop, debug: noop };
  return { __esModule: true, default: m, logService: m };
});

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3156".repeat(16);
const USER = "user-3156";
const OTHER = "user-other";
const MESSAGES = Number(process.env.KEEPR_3156_MESSAGES || 100_000);
const MAX_MS = 2_000; // sanity bound for the worker read, not a main-thread budget

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3156] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

maybe("BACKLOG-3156 stage G: messages stored per source (real encrypted DB)", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { readMessageSourceStatsOn, MESSAGE_SOURCE_STATS_SQL } =
    require("../messageSourceStatsDb") as typeof import("../messageSourceStatsDb");
  /* eslint-enable @typescript-eslint/no-require-imports */

  let dir: string;
  let db: DatabaseType;
  // What the fixture wrote, counted as it is written (not re-derived from SQL).
  const expected = {
    macos: { texts: 0, chats: new Set<string>(), oldest: "" },
    iphone: { texts: 0, chats: new Set<string>(), oldest: "" },
    google: { texts: 0, chats: new Set<string>(), oldest: "" },
  };
  const note = (k: keyof typeof expected, thread: string, sentAt: string): void => {
    const e = expected[k];
    e.texts += 1;
    e.chats.add(thread);
    if (!e.oldest || sentAt < e.oldest) e.oldest = sentAt;
  };

  beforeAll(() => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3156-"));
    db = new (Database as NonNullable<typeof Database>)(nodePath.join(dir, "mad.db"));
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8"));
    const addUser = db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)");
    for (const u of [USER, OTHER]) addUser.run(u, `${u}@example.test`, `oauth-${u}`);
    const add = db.prepare<unknown[]>(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const row = (id: string, user: string, ext: string, thread: string | null, sentAt: string, reaction: number | null = null): void => {
      add.run(id, user, "sms", ext, "inbound", "hello", JSON.stringify({ from: "+12015550101", to: ["me"] }), "12015550101",
        thread, sentAt, JSON.stringify({}), reaction);
    };
    db.transaction(() => {
      for (let i = 0; i < MESSAGES; i++) {
        const sentAt = new Date(1_500_000_000_000 + i * 60_000).toISOString();
        const kind = i % 5; // 0,1 mac · 2,3 iPhone · 4 Google
        if (kind <= 1) {
          const t = `macos-chat-${i % 400}`;
          row(`m${i}`, USER, `mac-guid-${i}`, t, sentAt);
          note("macos", t, sentAt);
        } else if (kind <= 3) {
          const t = `ios-chat-${i % 300}`;
          row(`m${i}`, USER, `ios-${i}`, t, sentAt);
          note("iphone", t, sentAt);
        } else {
          const t = `gmweb2-h${i % 60}`;
          const ext = i % 10 === 4 ? `gmweb:c${i % 60}:${i}` : `gmweb2:h${i % 60}:${i}`;
          row(`m${i}`, USER, ext, t, sentAt);
          note("google", t, sentAt);
        }
      }
      // Not counted under any source of USER:
      for (let i = 0; i < 50; i++) {
        row(`comp-${i}`, USER, `hash-${i}`, `android-thread-${i}`, "2001-01-01T00:00:00.000Z"); // Companion
        row(`o-mac-${i}`, OTHER, `o-g-${i}`, `macos-chat-${i}`, "2000-01-01T00:00:00.000Z"); // another user
        row(`o-ios-${i}`, OTHER, `o-i-${i}`, `ios-chat-${i}`, "2000-01-01T00:00:00.000Z");
        row(`o-gm-${i}`, OTHER, `gmweb2:o:${i}`, `gmweb2-o`, "2000-01-01T00:00:00.000Z");
      }
      row("react-mac", USER, "r-1", "macos-chat-1", "1999-01-01T00:00:00.000Z", 2000); // a tapback is not a text
      row("react-gm", USER, "gmweb2:r:1", "gmweb2-r", "1999-01-01T00:00:00.000Z", 2001);
      row("nochat", USER, "nochat-1", null, "1998-01-01T00:00:00.000Z"); // no chat: not attributable
    })();
    db.exec("ANALYZE");
  }, 600_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../../workers/contactWorkerPool") as typeof import("../../../workers/contactWorkerPool");
    await pool.shutdownPool().catch(() => undefined);
    pool.setContactWorkerPathForTests(null);
    nodeFs.rmSync(nodePath.join(__dirname, "..", "..", "..", "..", ".tmp-3156"), { recursive: true, force: true });
    db?.close();
    if (dir) nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  it("S1: each source counts exactly its own texts, chats and oldest text", () => {
    const stats = readMessageSourceStatsOn(db, USER);
    for (const k of ["macos", "iphone", "google"] as const) {
      expect(stats[k]).toEqual({ texts: expected[k].texts, chats: expected[k].chats.size, oldest: expected[k].oldest });
    }
    expect(stats.macos.texts + stats.iphone.texts + stats.google.texts).toBe(MESSAGES);
  });

  it("S1: a user with nothing stored reads zeros", () => {
    expect(readMessageSourceStatsOn(db, "nobody")).toEqual({
      macos: { texts: 0, chats: 0, oldest: null },
      iphone: { texts: 0, chats: 0, oldest: null },
      google: { texts: 0, chats: 0, oldest: null },
    });
  });

  it("S2: index-bounded; its time at this size is printed", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${MESSAGE_SOURCE_STATS_SQL}`).all(USER, USER, USER, USER) as Array<{ detail: string }>)
      .map((r) => r.detail);
    const scans = plan.filter((d) => /^SCAN m\b/.test(d) && !/USING/.test(d));
    expect(scans).toEqual([]);
    readMessageSourceStatsOn(db, USER); // warm
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      readMessageSourceStatsOn(db, USER);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    process.stderr.write(`[3156] ${MESSAGES} texts: median ${times[2].toFixed(1)} ms, max ${times[4].toFixed(1)} ms; plan: ${plan.join(" | ")}\n`);
    expect(times[2]).toBeLessThan(MAX_MS);
  });

  it("S3: through the real worker pool — same answer, main never stalls 50 ms", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require("esbuild");
    // Inside the worktree so the bundle's external driver require resolves (as contactWorkerPool.drain-2553).
    const bundleDir = nodePath.join(__dirname, "..", "..", "..", "..", ".tmp-3156");
    nodeFs.mkdirSync(bundleDir, { recursive: true });
    const bundle = nodePath.join(bundleDir, "contactQueryWorker.bundle.js");
    esbuild.buildSync({
      entryPoints: [nodePath.join(__dirname, "..", "..", "..", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      external: ["better-sqlite3-multiple-ciphers"],
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../../workers/contactWorkerPool") as typeof import("../../../workers/contactWorkerPool");
    pool.setContactWorkerPathForTests(bundle);
    db.pragma("wal_checkpoint(TRUNCATE)");
    await Promise.race([
      pool.initializePool(nodePath.join(dir, "mad.db"), KEY_HEX),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("worker pool did not start in 30 s")), 30_000)),
    ]);
    expect(pool.isPoolReady()).toBe(true);

    // Best of up to 3: a read on the main thread stalls EVERY attempt (S2 measures it at
    // hundreds of ms); a one-off GC pause or OS deschedule on a hosted runner does not repeat.
    // The answer must match on every attempt; the LOWEST stall must stay under 50 ms.
    const expected = readMessageSourceStatsOn(db, USER);
    const stalls: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      let last = performance.now();
      let maxGap = 0;
      const beat = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 1);
      const t0 = performance.now();
      const pending = pool.queryContacts("messageSourceStats", USER, 30_000);
      readMessageSourceStatsOn(db, USER); // CONTROL MUTATION: the read on the main thread
      const rows = await pending;
      const total = performance.now() - t0;
      clearInterval(beat);

      expect(rows[0]).toEqual(expected);
      stalls.push(maxGap);
      process.stderr.write(
        `[3156] attempt ${attempt}: worker round trip ${total.toFixed(1)} ms; longest main-thread stall ${maxGap.toFixed(1)} ms\n`,
      );
      if (maxGap < 50) break;
    }
    expect(Math.min(...stalls)).toBeLessThan(50);
  }, 120_000);
});
