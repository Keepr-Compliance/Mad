/**
 * @jest-environment node
 *
 * BACKLOG-3236 — THE EXPORT COUNT IS INCREMENTED IN SQL, NOT BOUND FROM A READ.
 *
 * Each export handler used to read the deal (export_count included) at the
 * top, run the slow export, and then write `export_count = <that read> + 1`.
 * Two exports of one deal in flight together (a second click on Export before
 * the modal leaves its first step) both read N and both wrote N + 1: one
 * export lost. The write is now `export_count = COALESCE(export_count, 0) + 1`
 * inside the single BACKLOG-3303 completion statement, so there is no read to
 * go stale.
 *
 * THE GATE. Both export-service mocks await ONE shared gate, and it opens only
 * when the number of exports that have arrived at it equals the number the
 * test started. Not a timer: a staggered or slept release lets one export
 * finish its whole tail alone, and then a fix that re-reads the count with an
 * await before writing passes (measured during planning: 5/5 green with
 * staggered timers, red with this gate). CONCURRENT asserts arrivals === 2.
 *
 * CRASH@k is swept over k = 1..N where N is MEASURED in the same test, not
 * hardcoded: a hardcoded k past N never fires and passes vacuously.
 *
 * Real driver, shipped schema.sql, real handlers, real completeExport and
 * recordExportCompletion. Owner of the count assertion previously held, on a
 * mocked bind, by transaction-handlers.integration.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/handlers/__tests__/exportCountConcurrency-3236.test.ts
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

// ---- the shared gate (declared before the jest.mock factories run) ----
let gateArrivals = 0;
let gateExpected = 1;
let openGate: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
function armGate(expected: number): void {
  gateArrivals = 0;
  gateExpected = expected;
  gate = new Promise<void>((r) => { openGate = r; });
}
async function mockArriveAtGate(): Promise<void> {
  gateArrivals++;
  if (gateArrivals === gateExpected) openGate();
  await gate;
}


const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const mockShellOpenPath = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
  shell: { openPath: (...a: unknown[]) => mockShellOpenPath(...a) },
}));

jest.mock("../../services/openablePaths", () => {
  const actual = jest.requireActual("../../services/openablePaths");
  return { ...actual, rememberOpenablePath: jest.fn(actual.rememberOpenablePath) };
});

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

// The export pipeline itself is not under test — only what the completion path
// writes. Each of these is awaited by the handler and must resolve.
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: jest.fn() },
}));
jest.mock("../../services/enhancedExportService", () => ({
  __esModule: true,
  default: { exportTransaction: jest.fn(async () => { await mockArriveAtGate(); return "/tmp/export-2549.xlsx"; }) },
}));
jest.mock("../../services/folderExportService", () => ({
  __esModule: true,
  default: {
    exportTransactionToFolder: jest.fn(async () => { await mockArriveAtGate(); return "/tmp/export-2549-folder"; }),
    exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/tmp/export-2549.pdf"),
    getDefaultExportPath: jest.fn(() => "/tmp/export-2549"),
  },
}));
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../../services/submissionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/submissionSyncService", () => ({
  __esModule: true,
  default: { stopAllSync: jest.fn() },
}));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/transactionSyncTrigger", () => ({
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/messagesSyncTrigger", () => ({
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/exportGate", () => ({
  enforceExportGate: jest.fn(async (input: { communications: unknown[] }) => ({
    communications: input.communications ?? [],
    decision: { mode: "full" },
  })),
  emitExportCompleted: jest.fn().mockResolvedValue(undefined),
}));

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../../services/db/core/dbConnection";
import transactionService from "../../services/transactionService";
import { registerTransactionExportHandlers } from "../transactionExportHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

// pii-allow-uuid: invented, not from any live row — repeating-digit v4 pattern
const USER = "11111111-1111-4111-8111-111111111111";
// pii-allow-uuid: invented, not from any live row — repeating-digit v4 pattern
const TXN = "33333333-3333-4333-8333-333333333333";

/** Identity anchors seeded to non-default values so "unchanged" is observable. */
const ANCHORS: Record<string, string> = {
  property_address: "42 Fixture Lane, Testville",
  property_street: "42 Fixture Lane",
  property_city: "Testville",
  property_state: "CA",
  property_zip: "90210",
  transaction_type: "purchase",
  started_at: "2026-01-01T00:00:00.000Z",
};

const SEEDED_LAST_EXPORTED_ON = "2026-02-02T02:02:02.000Z";
const SEEDED_FIRST_EXPORTED_AT = "2026-03-03T03:03:03.000Z";
const SEEDED_EXPORT_COUNT = 3;

let db: DatabaseType;
let databaseService: {
  stampFirstExportedAt: (transactionId: string, timestamp: string) => boolean;
  recordExportCompletion: (transactionId: string, input: Record<string, unknown>) => void;
};
let stampSpy: jest.SpyInstance;
let recordSpy: jest.SpyInstance;

type TxRow = Record<string, unknown>;

function row(): TxRow {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(TXN) as TxRow;
}

/**
 * The `getTransactionDetails` fixture is TRANSCRIBED from the seeded row, never
 * hand-typed — the handler reads `user_id`, `export_count`, `first_exported_at`,
 * `started_at` and `closed_at` off it, and a hand-typed object would describe a
 * row the database does not hold.
 */
function detailsFromDb(): TxRow {
  return { ...row(), communications: [] };
}

/**
 * Seed one transaction. `frozen` decides whether the deal has already been
 * exported once — the pre-state has to HOLD a value for "the marker did not
 * move" to be distinguishable from "the marker was never written".
 */
function seed(opts: { frozen: boolean }): void {
  db.exec("DELETE FROM transactions");
  const cols = ["id", "user_id", ...Object.keys(ANCHORS), "export_status", "export_count", "last_exported_on", "export_format"];
  const vals: unknown[] = [TXN, USER, ...Object.values(ANCHORS), "not_exported", SEEDED_EXPORT_COUNT, SEEDED_LAST_EXPORTED_ON, "pdf"];
  if (opts.frozen) {
    cols.push("first_exported_at");
    vals.push(SEEDED_FIRST_EXPORTED_AT);
  }
  db.prepare(
    `INSERT INTO transactions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...vals);
}

async function invoke(channel: string, options: unknown): Promise<{ success: boolean; error?: string }> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return (await handler({} as never, TXN, options)) as { success: boolean; error?: string };
}

const PER_CHANNEL: Record<string, { options: unknown; recordedFormat: string; auditFormat: string; returnedPath: string }> = {
  "transactions:export-enhanced": {
    options: { exportFormat: "excel", contentType: "both", attachmentType: "none" },
    recordedFormat: "excel",
    auditFormat: "excel",
    returnedPath: "/tmp/export-2549.xlsx", // the exportTransaction mock return
  },
  "transactions:export-folder": {
    options: { contentType: "both", attachmentType: "none" },
    // The folder path leaves the column alone, so the seeded value survives.
    recordedFormat: "pdf",
    auditFormat: "folder",
    returnedPath: "/tmp/export-2549-folder", // the exportTransactionToFolder mock return
  },
};

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "fixture@example.test", "oauth-fixture");
  setDb(db);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  databaseService = require("../../services/databaseService").default;
  registerTransactionExportHandlers(null);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  stampSpy = jest.spyOn(databaseService, "stampFirstExportedAt");
  recordSpy = jest.spyOn(databaseService, "recordExportCompletion");
  (transactionService.getTransactionDetails as jest.Mock).mockImplementation(async () =>
    detailsFromDb(),
  );
});

afterEach(() => {
  stampSpy.mockRestore();
  recordSpy.mockRestore();
});


const EN = "transactions:export-enhanced";
const FO = "transactions:export-folder";

function seedCount(n: number | null): void {
  seed({ frozen: false });
  db.prepare("UPDATE transactions SET export_count = ? WHERE id = ?").run(n, TXN);
}

async function exportOnce(channel: string): Promise<{ success: boolean; error?: string }> {
  armGate(1);
  return invoke(channel, PER_CHANNEL[channel].options);
}

describe("BACKLOG-3236: concurrent exports of one deal each count once", () => {
  it.each([
    [EN, EN],
    [FO, FO],
    [EN, FO],
  ])("CONCURRENT %s + %s: 3 -> 5", async (a, b) => {
    seedCount(3);
    armGate(2);
    const results = await Promise.all([
      invoke(a, PER_CHANNEL[a].options),
      invoke(b, PER_CHANNEL[b].options),
    ]);
    expect(gateArrivals).toBe(2);
    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(row().export_count).toBe(5);
  });

  it("SEQUENTIAL: two exports, 3 -> 5", async () => {
    seedCount(3);
    expect((await exportOnce(EN)).success).toBe(true);
    expect((await exportOnce(FO)).success).toBe(true);
    expect(row().export_count).toBe(5);
  });

  it.each([EN, FO])("SINGLE %s: 3 -> 4 (no double increment)", async (ch) => {
    seedCount(3);
    expect((await exportOnce(ch)).success).toBe(true);
    expect(row().export_count).toBe(4);
  });

  // MECHANISM: the zod schema admits null (schemas/transaction.ts), but no
  // producer of a NULL count was found (create paths write 0, schema DEFAULT
  // 0). Producer untraced; kept for parity with the old `|| 0`.
  it("NULL seed -> 1", async () => {
    seedCount(null);
    expect((await exportOnce(EN)).success).toBe(true);
    expect(row().export_count).toBe(1);
  });
});

// ---- crash injection: throw at the k-th write statement on `transactions` ----
function withCrashAt(k: number): { restore: () => void; fired: () => number; inTx: () => boolean[] } {
  const orig = db.prepare.bind(db);
  let n = 0;
  let firedAt = 0;
  const inTx: boolean[] = [];
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (sqlText: string) => {
    const st = orig(sqlText);
    if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*\btransactions\b/i.test(sqlText)) return st;
    const run = st.run.bind(st);
    (st as unknown as { run: (...a: unknown[]) => unknown }).run = (...a: unknown[]) => {
      n++;
      inTx.push(db.inTransaction);
      if (n === k) {
        firedAt = n;
        throw new Error(`INJECTED CRASH at write ${k}`);
      }
      return run(...a);
    };
    return st;
  };
  return {
    restore: () => { (db as unknown as { prepare: unknown }).prepare = orig; },
    fired: () => firedAt,
    inTx: () => inTx,
  };
}

describe("BACKLOG-3236: the completion write is one statement and fails whole", () => {
  it.each([EN, FO])("BASE %s: one autocommit write; CRASH@k for k = 1..N measured", async (ch) => {
    seedCount(3);
    const base = withCrashAt(0);
    try {
      expect((await exportOnce(ch)).success).toBe(true);
    } finally {
      base.restore();
    }
    const N = base.inTx().length;
    expect(N).toBe(1);
    expect(base.inTx()).toEqual([false]);

    for (let k = 1; k <= N; k++) {
      seedCount(3);
      const before = row();
      const c = withCrashAt(k);
      let res: { success: boolean; error?: string };
      try {
        res = await exportOnce(ch);
      } finally {
        c.restore();
      }
      expect(c.fired()).toBe(k);
      expect(res.success).toBe(false);
      expect(row()).toEqual(before);

      expect((await exportOnce(ch)).success).toBe(true);
      expect(row().export_count).toBe(4);
    }
  });

  it("NESTED: a crash inside an outer transaction throws synchronously and changes nothing", () => {
    seedCount(3);
    const before = row();
    const c = withCrashAt(1);
    let caught = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { dbTransaction } = require("../../services/db/core/dbConnection");
      dbTransaction(() => {
        try {
          databaseService.recordExportCompletion(TXN, {
            exportedAt: "2026-10-20T00:00:00.000Z",
            firstExportedAt: "2026-10-20T00:00:00.000Z",
          });
        } catch {
          caught = true;
        }
      });
    } finally {
      c.restore();
    }
    expect(c.fired()).toBe(1);
    expect(caught).toBe(true);
    expect(row()).toEqual(before);
  });
});
