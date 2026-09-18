/**
 * @jest-environment node
 *
 * BACKLOG-2549 — EXPORTED AND FROZEN MUST FLIP TOGETHER.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `transactions:export-enhanced` and `transactions:export-folder` wrote the
 * export-tracking columns and the BACKLOG-2013 freeze stamp as TWO separate
 * awaited statements. Between them a transaction is `export_status = 'exported'`
 * with `first_exported_at` NULL — an exported artifact on disk while the deal's
 * identity anchors (address, type, audit start) are still editable, because the
 * freeze predicate reads `first_exported_at`.
 *
 * Two DIFFERENT routes produce that same row, and a test that models only the
 * first misses the one that actually ships:
 *
 *   A. THE STAMP FAILS AND NOTHING SAYS SO. `markFirstExport` is deliberately
 *      non-throwing — it catches and logs. So the export returns SUCCESS to the
 *      user and leaves the deal unfrozen. No crash is required.
 *   B. CONTROL IS LOST BETWEEN THE TWO WRITES. The first statement is committed
 *      and the second never reaches SQLite.
 *
 * ===========================================================================
 * WHY THIS SUITE READS THE ROW BACK
 * ===========================================================================
 * The handler returns `{ success: true }` in case A while the row is wrong, and
 * `updateTransaction` returns nothing. Asserting a return value or a call would
 * pass against the defect. Every load-bearing assertion below is a `SELECT` on
 * the test database. Same reasoning as
 * `electron/__tests__/transactionNullClear-2759.test.ts`.
 *
 * ===========================================================================
 * WHY THE FAULT IS INJECTED AT `stampFirstExportedAt`
 * ===========================================================================
 * This file must COMPILE AND RUN UNCHANGED before the fix, after it, and after
 * the revert control — otherwise the "before" and "after" are two different
 * tests. ts-jest runs with diagnostics on (`jest.config.js:20-26`), so a single
 * reference to the post-fix writer would fail to compile against unfixed code
 * and the reachability control could not run at all. `stampFirstExportedAt`
 * exists on BOTH sides (the PDF path keeps it), so it is the one stable seam.
 *
 * STATED LIMIT: case B models the crash IN-PROCESS — the spy records the call
 * and never reaches SQLite, which is the state a process death between the two
 * awaits leaves behind. The handler's return value is therefore NOT meaningful
 * for case B and is not asserted. No child-process kill is used: unlike
 * BACKLOG-2548 (a `db.transaction()` wrapper around three statements, where the
 * control had to prove the wrapper survives a real SIGKILL), the fix here is a
 * SINGLE statement whose atomicity is SQLite's own. A kill would be testing the
 * driver.
 *
 * ===========================================================================
 * CONTROLS — RUN, NOT ASSUMED (results in the BACKLOG-2549 pm_comments record)
 * ===========================================================================
 * MEASURED, not predicted — each line is what the run actually produced:
 *
 *   - against unfixed code    -> A, B, SECONDARY RED on both channels
 *                                (6 failed / 8 passed); C, D, E, F green
 *   - revert the fold only    -> A, B, SECONDARY RED again (6 failed / 8 passed)
 *   - COALESCE(...) -> `= ?`  -> C and D RED, both channels (4 failed / 10 passed)
 *   - swap the export_count and last_exported_on bindings
 *                             -> D and E RED (4 failed / 10 passed); A, B, C, F
 *                                and SECONDARY all STAY GREEN
 *
 * That last line is why E exists. A displaced binding is atomic and silent: it
 * writes one row, in one statement, and every atomicity case passes straight
 * through it. Only a case that asserts the VALUES catches it.
 *
 * C, D, E and F are green before the fix by design: they are regression fences
 * for the fold, not reproductions of the defect. Their controls are the
 * mutations above, not the pre-fix state.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/handlers/__tests__/transactionExportHandlers.exportFreezeAtomic-2549.test.ts --bail=0
 *
 * Fixture values are invented and documentation-only.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

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
  default: { exportTransaction: jest.fn().mockResolvedValue("/tmp/export-2549.xlsx") },
}));
jest.mock("../../services/folderExportService", () => ({
  __esModule: true,
  default: {
    exportTransactionToFolder: jest.fn().mockResolvedValue("/tmp/export-2549-folder"),
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
import { FROZEN_IDENTITY_FIELDS } from "../../services/transactionFreezePolicy";
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
/** The real facade instance the handler holds — the fault-injection seam. */
let databaseService: {
  stampFirstExportedAt: (transactionId: string, timestamp: string) => boolean;
};
let stampSpy: jest.SpyInstance;

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

function anchorsNow(): Record<string, unknown> {
  const r = row();
  const out: Record<string, unknown> = {};
  for (const field of FROZEN_IDENTITY_FIELDS) out[field] = r[field];
  return out;
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

const CHANNELS: Array<{ channel: string; options: unknown; label: string }> = [
  {
    channel: "transactions:export-enhanced",
    label: "enhanced",
    options: { exportFormat: "excel", contentType: "both", attachmentType: "none" },
  },
  {
    channel: "transactions:export-folder",
    label: "folder",
    options: { contentType: "both", attachmentType: "none" },
  },
];

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
  jest.clearAllMocks();
  stampSpy = jest.spyOn(databaseService, "stampFirstExportedAt");
  (transactionService.getTransactionDetails as jest.Mock).mockImplementation(async () =>
    detailsFromDb(),
  );
});

afterEach(() => {
  stampSpy.mockRestore();
});

describe("BACKLOG-2549 — export status and the freeze stamp flip together", () => {
  describe.each(CHANNELS)("$label", ({ channel, options }) => {
    // -----------------------------------------------------------------------
    // A and B — the defect. RED before the fix.
    // -----------------------------------------------------------------------

    it("A: a freeze-stamp FAILURE cannot leave the deal exported-but-editable", async () => {
      seed({ frozen: false });
      stampSpy.mockImplementation(() => {
        throw new Error("SIMULATED freeze-stamp failure");
      });

      await invoke(channel, options);

      const r = row();
      expect({
        exported: r.export_status === "exported",
        frozen: r.first_exported_at !== null,
      }).toEqual({ exported: true, frozen: true });
    });

    it("B: losing control between the writes cannot leave the deal exported-but-editable", async () => {
      seed({ frozen: false });
      // Recording no-op: the statement never reaches SQLite, which is what a
      // process death between the two awaits leaves behind.
      stampSpy.mockImplementation(() => true);

      await invoke(channel, options);

      const r = row();
      expect({
        exported: r.export_status === "exported",
        frozen: r.first_exported_at !== null,
      }).toEqual({ exported: true, frozen: true });
    });

    // -----------------------------------------------------------------------
    // C and D — regression fences for the fold. Green before the fix.
    // -----------------------------------------------------------------------

    it("C: the freeze boundary is write-once — a re-export never moves it", async () => {
      seed({ frozen: true });

      await invoke(channel, options);

      expect(row().first_exported_at).toBe(SEEDED_FIRST_EXPORTED_AT);
    });

    it("D: a re-export still records tracking, and still does not move the boundary", async () => {
      seed({ frozen: true });

      await invoke(channel, options);

      const r = row();
      expect({
        export_status: r.export_status,
        export_count: r.export_count,
        last_exported_on_moved: r.last_exported_on !== SEEDED_LAST_EXPORTED_ON,
        first_exported_at: r.first_exported_at,
        // The folder path deliberately does not write `export_format` (a
        // previous format survives); the enhanced path sets it.
        export_format: r.export_format,
      }).toEqual({
        export_status: "exported",
        export_count: SEEDED_EXPORT_COUNT + 1,
        last_exported_on_moved: true,
        first_exported_at: SEEDED_FIRST_EXPORTED_AT,
        export_format: channel === "transactions:export-enhanced" ? "excel" : "pdf",
      });
    });

    // -----------------------------------------------------------------------
    // E — RC2. What the fold WRITES, not merely that it is atomic.
    // -----------------------------------------------------------------------

    it("E: a first export with no fault writes all five columns correctly", async () => {
      seed({ frozen: false });
      const before = new Date().toISOString();

      const res = await invoke(channel, options);

      const after = new Date().toISOString();
      const r = row();
      expect({
        success: res.success,
        export_status: r.export_status,
        export_format: r.export_format,
        export_count: r.export_count,
        last_exported_on_in_window:
          typeof r.last_exported_on === "string" &&
          r.last_exported_on >= before &&
          r.last_exported_on <= after,
        first_exported_at_in_window:
          typeof r.first_exported_at === "string" &&
          r.first_exported_at >= before &&
          r.first_exported_at <= after,
      }).toEqual({
        success: true,
        export_status: "exported",
        export_format: channel === "transactions:export-enhanced" ? "excel" : "pdf",
        export_count: SEEDED_EXPORT_COUNT + 1,
        last_exported_on_in_window: true,
        first_exported_at_in_window: true,
      });
    });

    // -----------------------------------------------------------------------
    // F — RC3. The new raw writer stays restricted to its five columns.
    // -----------------------------------------------------------------------

    it("F: the export write touches no frozen identity anchor", async () => {
      seed({ frozen: false });
      const before = anchorsNow();
      // The set is imported, never hand-listed, so this assertion widens by
      // itself if FROZEN_IDENTITY_FIELDS ever grows.
      expect(Object.keys(before).length).toBe(FROZEN_IDENTITY_FIELDS.length);

      await invoke(channel, options);

      expect(anchorsNow()).toEqual(before);
    });

    // -----------------------------------------------------------------------
    // SECONDARY — records the mechanism change. A shape assertion cannot tell
    // a correct row from a wrong one; the SELECTs above are load-bearing.
    // -----------------------------------------------------------------------

    it("SECONDARY: the completion path no longer reaches the separate stamp writer", async () => {
      seed({ frozen: false });

      await invoke(channel, options);

      expect(stampSpy).not.toHaveBeenCalled();
    });
  });
});
