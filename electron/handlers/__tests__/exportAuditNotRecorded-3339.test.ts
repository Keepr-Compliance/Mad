/**
 * @jest-environment node
 *
 * BACKLOG-3339 slice B — AN EXPORT WHOSE AUDIT ENTRY CANNOT BE WRITTEN.
 *
 * Founder ruling: keep the file, show an error. So when the audit INSERT
 * fails, the export record and the freeze roll back with it, the file stays
 * on disk, one failure entry is written, Sentry hears once per stretch of
 * failures, and the handler answers `{ success:false, notRecorded:true, path }`.
 *
 * Driven through the REAL `transactions:export-enhanced` and
 * `transactions:export-folder` handlers, the REAL `completeExport`,
 * `recordExportCompletion` and `auditService`, on the real driver with the
 * shipped schema. Only the export pipeline (the file writers) is mocked.
 * Controls transcribed from the plan's probe (pm_comments b0dfd6f4, E0-E4)
 * plus SR's E1b, E5 and E6 (pm_comments 68f83cf8).
 *
 * The audit failure is a trigger on `audit_logs` that rejects SUCCESS rows
 * only, so the failure entry itself can still be written.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/handlers/__tests__/exportAuditNotRecorded-3339.test.ts
 */

import type { Database as DatabaseType } from "better-sqlite3";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test"), isPackaged: false },
  shell: { openPath: jest.fn() },
}));
jest.mock("../../services/openablePaths", () => ({
  rememberOpenablePath: jest.fn().mockResolvedValue(undefined),
  resolveOpenablePath: jest.fn(),
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
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
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: jest.fn() },
}));
jest.mock("../../services/enhancedExportService", () => ({
  __esModule: true,
  default: { exportTransaction: jest.fn().mockResolvedValue("/tmp/export-3339.xlsx") },
}));
jest.mock("../../services/folderExportService", () => ({
  __esModule: true,
  default: {
    exportTransactionToFolder: jest.fn().mockResolvedValue("/tmp/export-3339-folder"),
    exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/tmp/export-3339.pdf"),
    getDefaultExportPath: jest.fn(() => "/tmp/export-3339"),
  },
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

import * as Sentry from "@sentry/electron/main";
import { auditService, type AuditLogEntry } from "../../services/auditService";
import transactionService from "../../services/transactionService";
import { emitExportCompleted } from "../../services/exportGate";
import { rememberOpenablePath } from "../../services/openablePaths";
import {
  EXPORT_NOT_RECORDED_MESSAGE,
  EXPORT_NOT_RECORDED_SENTRY_MESSAGE,
  resetExportAuditStretchForTests,
} from "../../services/exportCompletion";
import { registerTransactionExportHandlers } from "../transactionExportHandlers";
import {
  openAuditProbeDb,
  PROBE_USER,
  realAuditDb,
  settle,
} from "../../services/db/__tests__/fixtures/auditTxProbe";

// pii-allow-uuid: invented, not from any live row — repeating-digit v4 pattern
const TXN = "33333333-3333-4333-8333-333333333339";
const ADDRESS = "1 Fixture Way, Testville";

const EN = "transactions:export-enhanced";
const FO = "transactions:export-folder";
const CHANNELS: Record<string, { options: unknown; path: string; format: string }> = {
  [EN]: { options: { exportFormat: "excel", contentType: "both", attachmentType: "none" }, path: "/tmp/export-3339.xlsx", format: "excel" },
  [FO]: { options: { contentType: "both", attachmentType: "none" }, path: "/tmp/export-3339-folder", format: "folder" },
};

let db: DatabaseType;

type Result = { success: boolean; error?: string; path?: string; notRecorded?: boolean };

function invoke(channel: string): Promise<Result> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler({} as never, TXN, CHANNELS[channel].options) as Promise<Result>;
}

function seed(opts: { exported: boolean }): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, transaction_type, export_status, export_count, first_exported_at, last_exported_on)
     VALUES (?, ?, ?, 'purchase', ?, ?, ?, ?)`,
  ).run(
    TXN,
    PROBE_USER,
    ADDRESS,
    opts.exported ? "exported" : "not_exported",
    opts.exported ? 1 : 0,
    opts.exported ? "2026-03-03T03:03:03.000Z" : null,
    opts.exported ? "2026-03-03T03:03:03.000Z" : null,
  );
}

function deal(): Record<string, unknown> {
  return db
    .prepare("SELECT export_status, export_count, first_exported_at, last_exported_on, export_format FROM transactions WHERE id = ?")
    .get(TXN) as Record<string, unknown>;
}

function rows(): Array<{ action: string; success: number; error_message: string | null; metadata: string | null }> {
  return db
    .prepare("SELECT action, success, error_message, metadata FROM audit_logs WHERE resource_id = ? ORDER BY timestamp, id")
    .all(TXN) as Array<{ action: string; success: number; error_message: string | null; metadata: string | null }>;
}

/** Reject SUCCESS audit rows only: the failure entry can still be written. */
function failAuditSuccess(): void {
  db.exec("CREATE TRIGGER fail_audit_success BEFORE INSERT ON audit_logs WHEN NEW.success = 1 BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END");
}
function healAudit(): void {
  db.exec("DROP TRIGGER fail_audit_success");
}

function sentryReports(): unknown[][] {
  return (Sentry.captureMessage as jest.Mock).mock.calls.filter(
    (c) => c[0] === EXPORT_NOT_RECORDED_SENTRY_MESSAGE,
  );
}

const fakeCloud = {
  getAuthSession: async () => ({ userId: PROBE_USER }),
  async batchInsertAuditLogs(_entries: AuditLogEntry[]): Promise<void> {},
};

beforeAll(() => {
  registerTransactionExportHandlers(null);
});

beforeEach(() => {
  db = openAuditProbeDb();
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.localInsertFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
  resetExportAuditStretchForTests();
  jest.clearAllMocks();
  (transactionService.getTransactionDetails as jest.Mock).mockImplementation(async () => ({
    ...(db.prepare("SELECT * FROM transactions WHERE id = ?").get(TXN) as Record<string, unknown>),
    communications: [],
  }));
});

afterEach(async () => {
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

describe.each([EN, FO])("BACKLOG-3339 %s: saved but not recorded", (channel) => {
  const cfg = CHANNELS[channel];

  it("E0 success: recorded, frozen, one success entry, funnel fires", async () => {
    seed({ exported: false });
    const res = await invoke(channel);
    await settle();
    expect(res).toEqual({ success: true, path: cfg.path });
    expect(deal()).toMatchObject({ export_status: "exported", export_count: 1, first_exported_at: expect.any(String) });
    expect(rows().map((r) => [r.action, r.success, r.error_message])).toEqual([["DATA_EXPORT", 1, null]]);
    expect(emitExportCompleted).toHaveBeenCalledTimes(1);
  });

  it("E1 audit fails on a first export: the record and the freeze roll back", async () => {
    seed({ exported: false });
    const before = deal();
    failAuditSuccess();
    await invoke(channel).catch(() => undefined);
    await settle();
    expect(deal()).toEqual(before);
  });

  it("E1b audit fails on a re-export: the deal is exactly as it was", async () => {
    seed({ exported: true });
    const before = deal();
    failAuditSuccess();
    await invoke(channel).catch(() => undefined);
    await settle();
    expect(deal()).toEqual(before);
  });

  it("E2 audit fails: resolves not-recorded with the path and the copy; no funnel; file still openable", async () => {
    seed({ exported: false });
    failAuditSuccess();
    await expect(invoke(channel)).resolves.toEqual({
      success: false,
      notRecorded: true,
      path: cfg.path,
      error: EXPORT_NOT_RECORDED_MESSAGE,
    });
    expect(emitExportCompleted).not.toHaveBeenCalled();
    expect(rememberOpenablePath).toHaveBeenCalledWith(cfg.path);
  });

  it("E3 audit fails: exactly one failure entry, fixed code, no address or path", async () => {
    seed({ exported: false });
    failAuditSuccess();
    await invoke(channel).catch(() => undefined);
    await settle();
    const r = rows();
    expect(r.map((x) => [x.action, x.success, x.error_message])).toEqual([["DATA_EXPORT", 0, "audit_entry_not_written"]]);
    expect(JSON.parse(r[0].metadata ?? "{}")).toEqual({ format: cfg.format });
  });

  it("E4 two failures in a row: one Sentry report, tags only", async () => {
    seed({ exported: false });
    failAuditSuccess();
    for (let k = 0; k < 2; k++) await invoke(channel).catch(() => undefined);
    await settle();
    expect(sentryReports()).toEqual([
      [EXPORT_NOT_RECORDED_SENTRY_MESSAGE, { level: "error", tags: { operation: "completeExport", format: cfg.format, mode: "full" } }],
    ]);
    expect(JSON.stringify(sentryReports())).not.toMatch(/Fixture|\/tmp|33333333|user-fixture/);
  });

  it("E5 the export record itself fails: the export errors as before, one change_failed entry", async () => {
    seed({ exported: false });
    db.exec("CREATE TRIGGER fail_record BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'forced record failure'); END");
    const res = await invoke(channel).catch((e: unknown) => ({ success: false, thrown: e }) as unknown as Result);
    await settle();
    expect(res.success).toBe(false);
    expect(res.notRecorded).toBeUndefined();
    expect(rows().map((x) => [x.action, x.success, x.error_message])).toEqual([["DATA_EXPORT", 0, "change_failed:SqliteError"]]);
    expect(sentryReports()).toEqual([]);
  });

  it("E6 fail, then success, then fail: two Sentry reports (the stretch ends on success)", async () => {
    seed({ exported: false });
    failAuditSuccess();
    await invoke(channel).catch(() => undefined);
    healAudit();
    expect((await invoke(channel)).success).toBe(true);
    failAuditSuccess();
    await invoke(channel).catch(() => undefined);
    await settle();
    expect(sentryReports()).toHaveLength(2);
  });
});
