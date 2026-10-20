/**
 * @jest-environment node
 *
 * BACKLOG-3339 slice B — Settings "Export My Data" (`privacy:export-data`)
 * writes an audit entry, attributed to the SESSION user.
 *
 *   - success -> one DATA_EXPORT success entry, resource USER, no file path;
 *   - audit fails -> the file is still written, one failure entry, and the
 *     handler answers not-recorded with the fixed copy;
 *   - renderer id != session id -> refused before the save dialog, no file;
 *   - cancel -> no entry (unchanged);
 *   - Sentry: one tags-only report per stretch of failures, cleared by the
 *     next recorded export (fail -> fail = 1 report; fail -> ok -> fail = 2).
 *
 * Real driver, shipped schema, real auditService. The dialog, the data gather
 * and the file writer are mocked; "the file was written" is the writer call.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/handlers/__tests__/ccpaExportAudit-3339.test.ts
 */

import type { Database as DatabaseType } from "better-sqlite3";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const mockShowSaveDialog = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  dialog: { showSaveDialog: (...a: unknown[]) => mockShowSaveDialog(...a) },
  BrowserWindow: { fromWebContents: jest.fn(() => null), getFocusedWindow: jest.fn(() => null) },
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test"), isPackaged: false },
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
jest.mock("../../services/ccpaExportService", () => ({
  exportUserData: jest.fn().mockResolvedValue({ user: {} }),
  writeExportFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn() },
}));
jest.mock("../../services/crashReportingPreference", () => ({
  getCrashReportingState: jest.fn(() => ({})),
  setCrashReportingEnabled: jest.fn(),
}));
jest.mock("../../utils/busyIpc", () => ({
  handleBusy: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn),
}));

import { auditService, type AuditLogEntry } from "../../services/auditService";
import databaseService from "../../services/databaseService";
import sessionService from "../../services/sessionService";
import { exportUserData, writeExportFile } from "../../services/ccpaExportService";
import * as Sentry from "@sentry/electron/main";
import {
  DATA_EXPORT_NOT_RECORDED_MESSAGE,
  DATA_EXPORT_NOT_RECORDED_SENTRY_MESSAGE,
  DATA_EXPORT_WRONG_ACCOUNT_MESSAGE,
  registerCcpaHandlers,
  resetDataExportAuditStretchForTests,
} from "../ccpaHandlers";
import {
  openAuditProbeDb,
  PROBE_USER,
  realAuditDb,
  settle,
} from "../../services/db/__tests__/fixtures/auditTxProbe";
import { getRawDatabase } from "../../services/db/core/dbConnection";

const FILE = "/tmp/keepr-data-export-3339.json";
let db: DatabaseType;

type Result = { success: boolean; error?: string; filePath?: string; notRecorded?: boolean };
const sender = { send: jest.fn(), isDestroyed: () => false };
function invoke(userId: string): Promise<Result> {
  const h = handlers.get("privacy:export-data");
  if (!h) throw new Error("privacy:export-data not registered");
  return h({ sender } as never, userId) as Promise<Result>;
}
function rows(): Array<{ user_id: string; action: string; resource_type: string; resource_id: string; success: number; error_message: string | null; metadata: string | null }> {
  return db.prepare("SELECT user_id, action, resource_type, resource_id, success, error_message, metadata FROM audit_logs ORDER BY timestamp, id").all() as never;
}

const fakeCloud = {
  getAuthSession: async () => ({ userId: PROBE_USER }),
  async batchInsertAuditLogs(_e: AuditLogEntry[]): Promise<void> {},
};

beforeAll(() => {
  registerCcpaHandlers();
});

beforeEach(() => {
  db = openAuditProbeDb();
  jest.spyOn(databaseService, "getRawDatabase").mockImplementation(() => getRawDatabase());
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.localInsertFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
  jest.clearAllMocks();
  resetDataExportAuditStretchForTests();
  (sessionService.loadSession as jest.Mock).mockResolvedValue({ user: { id: PROBE_USER } });
  mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: FILE });
});

afterEach(async () => {
  jest.restoreAllMocks();
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

describe("BACKLOG-3339: Export My Data writes an audit entry", () => {
  it("success: one DATA_EXPORT entry for the session user, no file path in it", async () => {
    const res = await invoke(PROBE_USER);
    await settle();
    expect(res).toEqual({ success: true, filePath: FILE });
    expect(rows()).toEqual([
      { user_id: PROBE_USER, action: "DATA_EXPORT", resource_type: "USER", resource_id: PROBE_USER, success: 1, error_message: null, metadata: JSON.stringify({ format: "json" }) },
    ]);
    expect(JSON.stringify(rows())).not.toContain("keepr-data-export");
  });

  it("audit fails: the file is written, one failure entry, not-recorded with the fixed copy", async () => {
    db.exec("CREATE TRIGGER fail_audit_success BEFORE INSERT ON audit_logs WHEN NEW.success = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END");
    const res = await invoke(PROBE_USER);
    await settle();
    expect(writeExportFile).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ success: false, filePath: FILE, notRecorded: true, error: DATA_EXPORT_NOT_RECORDED_MESSAGE });
    expect(rows().map((r) => [r.action, r.success, r.error_message])).toEqual([["DATA_EXPORT", 0, "audit_entry_not_written"]]);
  });

  it("renderer id differs from the session user: refused before the dialog, no file, no entry", async () => {
    // pii-allow-uuid: invented, not from any live row
    const res = await invoke("99999999-9999-4999-8999-999999999999");
    await settle();
    expect(res).toEqual({ success: false, error: DATA_EXPORT_WRONG_ACCOUNT_MESSAGE });
    expect(mockShowSaveDialog).not.toHaveBeenCalled();
    expect(exportUserData).not.toHaveBeenCalled();
    expect(writeExportFile).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("no session: refused, no file", async () => {
    (sessionService.loadSession as jest.Mock).mockResolvedValue(null);
    const res = await invoke(PROBE_USER);
    expect(res.success).toBe(false);
    expect(writeExportFile).not.toHaveBeenCalled();
  });

  it("the data gathered is the session user's", async () => {
    await invoke(PROBE_USER);
    expect((exportUserData as jest.Mock).mock.calls[0][0]).toBe(PROBE_USER);
  });

  const failAudit = () =>
    db.exec("CREATE TRIGGER fail_audit_success BEFORE INSERT ON audit_logs WHEN NEW.success = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END");
  const allowAudit = () => db.exec("DROP TRIGGER fail_audit_success");

  it("Sentry: two failures in a row send one tags-only report", async () => {
    failAudit();
    await invoke(PROBE_USER);
    await invoke(PROBE_USER);
    await settle();
    const calls = (Sentry.captureMessage as jest.Mock).mock.calls.filter(
      (c) => c[0] === DATA_EXPORT_NOT_RECORDED_SENTRY_MESSAGE,
    );
    expect(calls).toEqual([
      [DATA_EXPORT_NOT_RECORDED_SENTRY_MESSAGE, { level: "error", tags: { operation: "privacy:export-data", format: "json" } }],
    ]);
    const payload = JSON.stringify(calls);
    expect(payload).not.toContain(PROBE_USER);
    expect(payload).not.toContain(FILE);
    expect(payload).not.toContain("forced");
  });

  it("Sentry: a recorded export ends the stretch (fail -> ok -> fail sends two)", async () => {
    failAudit();
    await invoke(PROBE_USER);
    allowAudit();
    expect((await invoke(PROBE_USER)).success).toBe(true);
    failAudit();
    await invoke(PROBE_USER);
    await settle();
    expect(
      (Sentry.captureMessage as jest.Mock).mock.calls.filter((c) => c[0] === DATA_EXPORT_NOT_RECORDED_SENTRY_MESSAGE),
    ).toHaveLength(2);
  });

  it("Sentry: a recorded export sends no report", async () => {
    await invoke(PROBE_USER);
    expect(
      (Sentry.captureMessage as jest.Mock).mock.calls.filter((c) => c[0] === DATA_EXPORT_NOT_RECORDED_SENTRY_MESSAGE),
    ).toEqual([]);
  });

  it("cancel: no entry", async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: true });
    const res = await invoke(PROBE_USER);
    await settle();
    expect(res).toEqual({ success: false, error: "Export cancelled by user" });
    expect(rows()).toEqual([]);
  });
});
