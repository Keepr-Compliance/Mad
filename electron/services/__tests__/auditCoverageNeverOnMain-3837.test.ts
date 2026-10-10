/**
 * @jest-environment node
 *
 * BACKLOG-3837 follow-up — the audit coverage check never reads the per-source floors
 * on the main process.
 *
 * On the PC (668k messages, encrypted, Windows) the floors read
 * (MESSAGES_FLOOR_BY_SOURCE_SQL) went to the SHARED contact worker with a 30 s timeout.
 * Right after a sync every call timed out and fell back to the same scan on MAIN: three
 * "transactions:get-audit-coverage" handlers took 111-134 s and main was blocked for
 * 104 s. Now the floors are read only on a dedicated worker, cached against a token of
 * the messages writes, one read per user at a time; a caller waits a short budget and
 * otherwise gets "pending" (sourceCoveragePending, no sourceGaps).
 *
 * REAL worker (compiled from contactQueryWorker.ts) on a REAL encrypted database built
 * from schema.sql. The gate is structural: the scan statement is never prepared on the
 * main connection. Event-loop stalls are printed, not asserted (the #2915 rule).
 *
 * Size: KEEPR_3837_MESSAGES (default 20000). The PC corpus is ~668000. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the driver cannot load and the suite is skipped with a warning.
 *
 * Fixture shapes as in wizardContinueOffMain-3837.test.ts (transcribed from
 * iPhoneSyncStorageService.storeMessages and rcsImportStore). Reserved 555-01xx numbers.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3837c"), isPackaged: true } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn().mockResolvedValue({ hasPermission: false }) },
}));

import * as pool from "../../workers/contactWorkerPool";
import { DedicatedWorkerError, initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../../workers/contactWorkerPool";
import { setDb } from "../db/core/dbConnection";
import {
  checkExportCompleteness,
  getAuditCoverage,
  getSourceCoverage,
  getSourceCoverageAsync,
  resetSourceFloorsCacheForTests,
  setSourceFloorsWaitMsForTests,
} from "../auditCoverageService";
import { MESSAGES_FLOOR_BY_SOURCE_SQL } from "../db/auditCoverageSql";
import type { DedicatedQueryFailure } from "../../workers/contactWorkerPool";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "user-3837c";
const MESSAGES = Number(process.env.KEEPR_3837_MESSAGES || 20_000);
/** Before every text in the fixture: needs an import, and every source starts later. */
const AUDIT_START = "2020-01-01T00:00:00.000Z";
const FIRST_SENT_MS = 1_600_000_000_000; // 2020-09-13

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3837c] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

function floorsCalls(spy: jest.SpyInstance): number {
  return spy.mock.calls.filter((c) => c[0] === "sourceCoverageFloors").length;
}

maybe("BACKLOG-3837: the coverage check never scans on main (real worker, encrypted DB)", () => {
  let dir: string;
  let dbPath: string;
  let main: DatabaseType;
  let prepared: string[] = [];
  let recording = false;

  function open(): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    return db;
  }

  const scanOnMain = (): boolean => prepared.some((s) => s === (MESSAGES_FLOOR_BY_SOURCE_SQL as unknown as string));

  async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 50));
    const value = await work();
    await new Promise((r) => setTimeout(r, 50));
    h.disable();
    return { value, maxMs: Math.round(h.max / 1e6) };
  }

  const addMessageSql = `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  function iphoneRow(id: string, sentAt: string): unknown[] {
    const handle = "+12005550123";
    return [
      id, USER, "imessage", `g-${id}`, "inbound", `body ${id}`,
      JSON.stringify({ from: handle, to: ["me"] }), handle.replace(/\D/g, ""), "ios-chat-1", sentAt,
      JSON.stringify({ source: "iphone_sync", originalId: 1, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
      null,
    ];
  }

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3837c-"));
    dbPath = nodePath.join(dir, "mad.db");
    const db = open();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3837c@example.test",
      "oauth-3837c",
    );
    const add = db.prepare(addMessageSql);
    db.transaction(() => {
      for (let i = 0; i < MESSAGES; i++) {
        const sentAt = new Date(FIRST_SENT_MS + i * 60_000).toISOString();
        if (i % 50 === 0) {
          const members = [`+1200555${String(100 + (i % 100)).padStart(4, "0")}`, "+19985550150"];
          add.run(
            `m${i}`, USER, "sms", `g${i}`, "inbound", `group ${i}`,
            JSON.stringify({ from: "Alex Rivera", to: ["me", ...members], chat_members: members }),
            members.join(","), `gmweb2-${i % 7}`, sentAt, JSON.stringify({ source: "gmweb-cache" }), null,
          );
          continue;
        }
        if (i % 97 === 0) {
          add.run(
            `m${i}`, USER, "imessage", `g${i}`, "inbound", "Liked a message",
            JSON.stringify({ from: "+19975550160", to: ["me"] }), "19975550160", "ios-chat-r", sentAt,
            JSON.stringify({ source: "iphone_sync", originalId: i, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
            2000,
          );
          continue;
        }
        add.run(...iphoneRow(`m${i}`, sentAt));
      }
    })();
    db.close();

    main = open();
    const realPrepare = main.prepare.bind(main);
    (main as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (recording) prepared.push(s);
      return realPrepare(s);
    };
    setDb(main);

    const workerScript = nodePath.join(dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "..", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
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
    for (let i = 0; i < 200 && !isPoolReady(); i++) await new Promise((r) => setTimeout(r, 25));
  }, 900_000);

  beforeEach(() => {
    prepared = [];
    recording = true;
    resetSourceFloorsCacheForTests();
    setSourceFloorsWaitMsForTests(600_000); // the real read always finishes unless a case says otherwise
  });

  afterEach(() => {
    recording = false;
    jest.restoreAllMocks();
    setSourceFloorsWaitMsForTests(null);
  });

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    main?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("known coverage: the dedicated worker's answer equals the main-thread read (non-empty), with real gaps", async () => {
    expect(isPoolReady()).toBe(true);
    const { value: result, maxMs } = await maxStallDuring(() => getAuditCoverage(USER, AUDIT_START));
    expect(scanOnMain()).toBe(false);
    expect(result.success).toBe(true);
    expect(result.sourceCoveragePending).toBeUndefined();
    expect(result.needsMessagesImport).toBe(true);
    expect(result.sourceGaps?.map((g) => `${g.source}:${g.kind}`).sort()).toEqual(["google_messages:never", "iphone:later"]);

    const viaWorker = await getSourceCoverageAsync(USER);
    recording = false;
    const { value: onMain, maxMs: mainMs } = await maxStallDuring(async () => getSourceCoverage(USER));
    expect(onMain.map((c) => c.source).sort()).toEqual(["google_messages", "iphone"]);
    expect(viaWorker).toEqual(onMain);
    process.stderr.write(
      `[3837c] getAuditCoverage over ${MESSAGES} msgs: maxEventLoopDelay=${maxMs}ms (main-thread scan control ${mainMs}ms)\n`,
    );
  }, 900_000);

  const FAILURES: DedicatedQueryFailure[] = ["timeout", "start_failed", "unavailable", "stopped", "failed"];
  it.each(FAILURES)(
    "the dedicated read fails (%s): nothing is read on main, the result is PENDING with no sourceGaps, the hard gate is still computed",
    async (code) => {
      const spy = jest
        .spyOn(pool, "queryOnDedicatedWorker")
        .mockRejectedValue(new DedicatedWorkerError(`simulated ${code}`, code));
      const result = await getAuditCoverage(USER, AUDIT_START);
      expect(floorsCalls(spy)).toBe(1);
      expect(scanOnMain()).toBe(false);
      expect(result.success).toBe(true);
      expect(result.sourceCoveragePending).toBe(true);
      expect("sourceGaps" in result).toBe(false); // unknown is never "no gaps"
      expect(result.needsMessagesImport).toBe(true); // the main-side floor still drives the gate
      expect(result.messagesFloorISO).toBe(new Date(FIRST_SENT_MS).toISOString());

      const exp = await checkExportCompleteness("no-such-txn", USER);
      expect(scanOnMain()).toBe(false);
      expect(exp.sourceCoveragePending).toBe(true);
      expect("sourceGaps" in exp).toBe(false);
    },
    60_000,
  );

  it("the dedicated read never answers: the caller gets PENDING within the budget, nothing on main; the read is not restarted", async () => {
    setSourceFloorsWaitMsForTests(300);
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation(() => new Promise<unknown[]>(() => undefined));
    const t0 = Date.now();
    const result = await getAuditCoverage(USER, AUDIT_START);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5_000);
    expect(result.sourceCoveragePending).toBe(true);
    expect("sourceGaps" in result).toBe(false);
    expect(scanOnMain()).toBe(false);
    await getAuditCoverage(USER, AUDIT_START); // a second Continue joins the running read
    expect(floorsCalls(spy)).toBe(1);
  }, 60_000);

  it("the SHARED pool is held by a long job: coverage is still served (the floors never use the shared worker)", async () => {
    const shared = jest.spyOn(pool, "queryContacts").mockImplementation(() => new Promise<unknown[]>(() => undefined));
    setSourceFloorsWaitMsForTests(SHARED_POOL_BUDGET_MS);
    const result = await getAuditCoverage(USER, AUDIT_START);
    expect(shared.mock.calls.filter((c) => c[0] === "sourceCoverageFloors")).toHaveLength(0);
    expect(result.sourceCoveragePending).toBeUndefined();
    expect(result.sourceGaps?.length).toBe(2);
    expect(scanOnMain()).toBe(false);
  }, 900_000);

  it("three concurrent calls start ONE read; a later call with no messages write reads nothing", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const [a, b, c] = await Promise.all([
      getAuditCoverage(USER, AUDIT_START),
      getAuditCoverage(USER, AUDIT_START),
      getAuditCoverage(USER, AUDIT_START),
    ]);
    expect(floorsCalls(spy)).toBe(1);
    expect(a.sourceGaps).toEqual(b.sourceGaps);
    expect(b.sourceGaps).toEqual(c.sourceGaps);
    expect(a.sourceGaps?.length).toBe(2);
    const d = await getAuditCoverage(USER, AUDIT_START);
    expect(floorsCalls(spy)).toBe(1); // cache hit
    expect(d.sourceGaps).toEqual(a.sourceGaps);
    // An unrelated write (body text) does not invalidate.
    main.prepare("UPDATE messages SET body_text = 'edited' WHERE id = 'm1'").run();
    await getAuditCoverage(USER, AUDIT_START);
    expect(floorsCalls(spy)).toBe(1);
    expect(scanOnMain()).toBe(false);
  }, 900_000);

  it("the cache is invalidated by a messages write: insert, metadata update, duplicate_of, delete", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const first = await getSourceCoverageAsync(USER);
    expect(floorsCalls(spy)).toBe(1);
    const iphoneSince = (cov: Awaited<ReturnType<typeof getSourceCoverageAsync>>): string | null | undefined =>
      cov?.find((c) => c.source === "iphone")?.coveredSince;
    expect(iphoneSince(first)).toBe(new Date(FIRST_SENT_MS + 60_000).toISOString());

    // Insert an OLDER iPhone text: the next read sees the new floor.
    const older = "2019-06-01T00:00:00.000Z";
    main.prepare(addMessageSql).run(...iphoneRow("m-older", older));
    const afterInsert = await getSourceCoverageAsync(USER);
    expect(floorsCalls(spy)).toBe(2);
    expect(iphoneSince(afterInsert)).toBe(older);
    const r = await getAuditCoverage(USER, AUDIT_START);
    expect(r.sourceGaps?.find((g) => g.source === "iphone")).toBeUndefined(); // now covered
    expect(floorsCalls(spy)).toBe(2);

    // Re-source it (metadata): read again, the floor moves back.
    main.prepare("UPDATE messages SET metadata = ? WHERE id = 'm-older'").run(JSON.stringify({ source: "macos_messages" }));
    const afterMeta = await getSourceCoverageAsync(USER);
    expect(floorsCalls(spy)).toBe(3);
    expect(iphoneSince(afterMeta)).toBe(new Date(FIRST_SENT_MS + 60_000).toISOString());

    // Mark it a duplicate: read again.
    main.prepare("UPDATE messages SET duplicate_of = 'm1' WHERE id = 'm-older'").run();
    await getSourceCoverageAsync(USER);
    expect(floorsCalls(spy)).toBe(4);

    // Delete it: read again.
    main.prepare("DELETE FROM messages WHERE id = 'm-older'").run();
    const afterDelete = await getSourceCoverageAsync(USER);
    expect(floorsCalls(spy)).toBe(5);
    expect(afterDelete).toEqual(first);
    expect(scanOnMain()).toBe(false);
  }, 900_000);
});

/** Long enough for a real dedicated read of the fixture on a slow runner. */
const SHARED_POOL_BUDGET_MS = 120_000;
