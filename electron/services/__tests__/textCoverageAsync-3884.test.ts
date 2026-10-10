/**
 * @jest-environment node
 *
 * BACKLOG-3884 — `transactions:get-text-coverage` never scans the user's texts on the
 * main process, asks the floors once while nothing changed, and asks again after a
 * messages write.
 *
 * On the PC each call blocked main ~3.5 s (MESSAGES_FLOOR_BY_SOURCE_SQL through the
 * synchronous getSourceCoverage) and the Texts tab asked several times per open. The
 * handler now builds the same answer on getTransactionSourceCoverageAsync (BACKLOG-3837:
 * dedicated worker, cached against the messages-write token).
 *
 * REAL encrypted database from schema.sql (the write token is real: temp triggers on
 * messages). The dedicated worker is replaced by a spy returning the floors rows the
 * real worker returns (`runSourceFloorsOn`: { source, floor, n }), so the test counts
 * worker reads. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3884cov"), isPackaged: true } }));
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
import { setDb } from "../db/core/dbConnection";
import { MESSAGES_FLOOR_BY_SOURCE_SQL } from "../db/auditCoverageSql";
import { resetSourceFloorsCacheForTests, setSourceFloorsWaitMsForTests } from "../auditCoverageService";
import { getTransactionTextCoverageAsync } from "../textCoverageAsync";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const USER = "user-3884cov";
const TXN = "txn-3884cov";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require(DRIVER);
  new Database(":memory:").close();
} catch {
  Database = null;
}

(Database ? describe : describe.skip)("BACKLOG-3884 text coverage off main", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let floorsPreparedOnMain = 0;
  let workerReads = 0;
  let msgSeq = 0;

  const addText = (sentAt: string): void => {
    const id = `m${msgSeq++}`;
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, thread_id, participants, metadata)
       VALUES (?, ?, 'imessage', 'inbound', 'hi', ?, 't1', '{"from":"+12065550150","to":["me"]}', '{"source":"iphone_sync"}')`,
    ).run(id, USER, sentAt);
  };

  beforeAll(() => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3884cov-"));
    db = new Database(nodePath.join(dir, "mad.db"));
    db.pragma(`key = "x'${"3884".repeat(16)}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'c@example.test', 'google', 'o-c')").run(USER);
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, transaction_type, status, started_at, closed_at) VALUES (?, ?, '2 Test St', 'purchase', 'active', '2026-03-01', '2026-06-30')",
    ).run(TXN, USER);
    addText("2026-05-01T10:00:00.000Z");
    const realPrepare = db.prepare.bind(db);
    db.prepare = (s: string) => {
      if (s === MESSAGES_FLOOR_BY_SOURCE_SQL) floorsPreparedOnMain += 1;
      return realPrepare(s);
    };
    setDb(db);
    setSourceFloorsWaitMsForTests(5_000);
    jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation(async (type: string) => {
      if (type !== "sourceCoverageFloors") throw new Error(`unexpected worker query ${type}`);
      workerReads += 1;
      // The iPhone history reaches back only to 2026-05-01, after the audit start.
      return [{ source: "iphone", floor: "2026-05-01T10:00:00.000Z", n: 1 }];
    });
  });

  beforeEach(() => {
    resetSourceFloorsCacheForTests();
    workerReads = 0;
    floorsPreparedOnMain = 0;
  });

  afterAll(() => {
    jest.restoreAllMocks();
    db?.close();
  });

  it("answers from the worker, never scans on main, and reports the gap", async () => {
    const r = await getTransactionTextCoverageAsync(TXN, USER, "iphone");
    expect(r.success).toBe(true);
    expect(r.pending).toBeUndefined();
    expect(r.gaps.map((g) => `${g.source}:${g.kind}`)).toEqual(["iphone:later"]);
    expect(workerReads).toBe(1);
    expect(floorsPreparedOnMain).toBe(0);
  });

  it("C4 the second ask is served from the cache; a messages write makes the next ask read again", async () => {
    await getTransactionTextCoverageAsync(TXN, USER, "iphone");
    await getTransactionTextCoverageAsync(TXN, USER, "iphone");
    expect(workerReads).toBe(1);
    addText("2026-02-01T10:00:00.000Z");
    await getTransactionTextCoverageAsync(TXN, USER, "iphone");
    expect(workerReads).toBe(2);
    expect(floorsPreparedOnMain).toBe(0);
  });

  it("an unknown floor is pending, never 'covered'", async () => {
    jest.mocked(pool.queryOnDedicatedWorker).mockImplementationOnce(async () => {
      workerReads += 1;
      throw new pool.DedicatedWorkerError("no worker", "start_failed");
    });
    const r = await getTransactionTextCoverageAsync(TXN, USER, "iphone");
    expect(r).toEqual(expect.objectContaining({ success: true, pending: true, gaps: [] }));
    expect(floorsPreparedOnMain).toBe(0);
  });
});
