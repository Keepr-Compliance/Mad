/**
 * @jest-environment node
 *
 * BACKLOG-3303 — ONE OWNER FOR EXPORT-COMPLETION BOOKKEEPING.
 *
 * Every registered `transactions:export-*` channel must finish through
 * `completeExport`. The channels are ENUMERATED from the handler registry, not
 * hand-listed, so a new export channel that skips the shared tail goes red
 * (it has no entry in PER_CHANNEL) with no other edit to this file.
 *
 * Two kinds of assertion, both needed:
 *   - ABSOLUTE: each side effect happened exactly once. Comparing channels to
 *     each other alone cannot see a side effect dropped from the shared helper,
 *     because every channel loses it together.
 *   - PARITY: every channel recorded the same as the others (apart from the
 *     two values that are intentionally per-channel).
 *
 * "Registered as openable" is asserted with a spy on `rememberOpenablePath`.
 * The mocked export paths do not exist on disk, so `resolveOpenablePath`
 * reports `not_found` on every channel whether or not the path was registered.
 *
 * `transactions:export-pdf` is EXCLUDED: it has no caller in `src/` and is
 * removed by BACKLOG-3302. The exclusion asserts the channel is still
 * registered, so it goes red when 3302 removes the channel; that PR must
 * delete the exclusion and that assertion.
 *
 * Fixture values are invented and documentation-only; the details fixture is
 * transcribed from the seeded row exactly as in the BACKLOG-2549 suite.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/handlers/__tests__/exportCompletionParity-3303.test.ts --bail=0
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

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
  // BACKLOG-3339: completeExport writes its entry with recordInTransaction,
  // and tells an audit failure apart by AuditNotRecordedError.
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn(),
    recordFailure: jest.fn(),
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
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
import * as openablePaths from "../../services/openablePaths";
import auditService from "../../services/auditService";
import { emitExportCompleted } from "../../services/exportGate";

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

const EXPORT_PDF = "transactions:export-pdf"; // BACKLOG-3302 removes it
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

function exportChannels(): string[] {
  return [...handlers.keys()]
    .filter((c) => c.startsWith("transactions:export-") && c !== EXPORT_PDF)
    .sort();
}

interface Capture {
  success: boolean;
  export_status: unknown;
  export_count: unknown;
  last_exported_on_moved: boolean;
  first_exported_at: unknown;
  recordCalls: number;
  stampCalls: number;
  auditDataExport: number;
  auditHiddenTextCountIsNumber: boolean;
  funnelForThisTxn: number;
  rememberedPaths: unknown[];
  export_format: unknown;
  auditFormat: unknown;
}

async function capture(channel: string, frozen: boolean): Promise<Capture> {
  const cfg = PER_CHANNEL[channel];
  if (!cfg) throw new Error(`new export channel ${channel}: add its options to PER_CHANNEL`);
  seed({ frozen });
  jest.clearAllMocks();
  const res = await invoke(channel, cfg.options);
  const r = row();
  // BACKLOG-3339: the entry is written in the export's transaction.
  const audits = (auditService.recordInTransaction as jest.Mock).mock.calls
    .map((c) => c[0] as { action: string; metadata: { format: unknown; hiddenTextCount: unknown } })
    .filter((a) => a.action === "DATA_EXPORT");
  return {
    success: res.success,
    export_status: r.export_status,
    export_count: r.export_count,
    last_exported_on_moved: r.last_exported_on !== SEEDED_LAST_EXPORTED_ON,
    first_exported_at: frozen ? r.first_exported_at : r.first_exported_at !== null,
    recordCalls: recordSpy.mock.calls.length,
    stampCalls: stampSpy.mock.calls.length,
    auditDataExport: audits.length,
    auditHiddenTextCountIsNumber: audits.every((a) => typeof a.metadata.hiddenTextCount === "number"),
    funnelForThisTxn: (emitExportCompleted as jest.Mock).mock.calls.filter(
      (c) => (c[0] as { transactionId: string }).transactionId === TXN,
    ).length,
    rememberedPaths: (openablePaths.rememberOpenablePath as jest.Mock).mock.calls.map((c) => c[0]),
    export_format: r.export_format,
    auditFormat: audits[0]?.metadata.format,
  };
}

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

describe("BACKLOG-3303 — every export channel finishes through completeExport", () => {
  it("enumerates the live channels from the registry, and the export-pdf exclusion is still real", () => {
    expect(handlers.has(EXPORT_PDF)).toBe(true); // red when BACKLOG-3302 lands: delete the exclusion
    expect(exportChannels()).toEqual(["transactions:export-enhanced", "transactions:export-folder"]);
  });

  describe.each([false, true])("seeded frozen=%s", (frozen) => {
    it("ABSOLUTE: each side effect happened exactly once on every channel", async () => {
      for (const channel of exportChannels()) {
        const c = await capture(channel, frozen);
        const cfg = PER_CHANNEL[channel];
        expect({ channel, ...c }).toEqual({
          channel,
          success: true,
          export_status: "exported",
          export_count: SEEDED_EXPORT_COUNT + 1,
          last_exported_on_moved: true,
          first_exported_at: frozen ? SEEDED_FIRST_EXPORTED_AT : true,
          recordCalls: 1,
          stampCalls: 0,
          auditDataExport: 1,
          auditHiddenTextCountIsNumber: true,
          funnelForThisTxn: 1,
          rememberedPaths: [cfg.returnedPath],
          export_format: cfg.recordedFormat,
          auditFormat: cfg.auditFormat,
        });
      }
    });

    it("PARITY: every channel recorded the same as the others", async () => {
      const caps: Capture[] = [];
      for (const channel of exportChannels()) caps.push(await capture(channel, frozen));
      expect(caps.length).toBeGreaterThan(1);
      // The intentionally per-channel values are removed before comparing.
      const strip = ({ export_format: _f, auditFormat: _a, rememberedPaths, ...rest }: Capture) => ({
        ...rest,
        rememberedCount: rememberedPaths.length,
      });
      for (const c of caps) expect(strip(c)).toEqual(strip(caps[0]));
    });
  });

  it("BOUNDARY: a re-export never moves the freeze marker", async () => {
    for (const channel of exportChannels()) {
      await capture(channel, true);
      expect(row().first_exported_at).toBe(SEEDED_FIRST_EXPORTED_AT);
    }
  });
});
