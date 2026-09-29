/**
 * @jest-environment node
 *
 * BACKLOG-3600 (control D5) — `checklistsNotSent` crosses the IPC boundary on
 * BOTH submit and resubmit.
 *
 * The handlers build their return value field by field, so a field the service
 * computes and the handler does not copy is computed and never shown — the
 * shape `attachmentsFailed` / `flaggedWithoutAttachments` already have on the
 * renderer side. The service result below is the shape
 * `submissionService.submitTransactionInternal` returns on success when the
 * copy was refused (`...(checklistsNotSent ? { checklistsNotSent } : {})`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));

const mockSubmitTransaction = jest.fn();
const mockResubmitTransaction = jest.fn();
jest.mock("../services/submissionService", () => ({
  __esModule: true,
  default: {
    submitTransaction: (...a: any[]) => mockSubmitTransaction(...a),
    resubmitTransaction: (...a: any[]) => mockResubmitTransaction(...a),
  },
}));
jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: jest.fn().mockResolvedValue({
      id: "txn-3600",
      user_id: "user-3600",
      property_address: "1 Test Way",
    }),
  },
  getEarliestCommunicationDate: jest.fn(),
}));
jest.mock("../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/messagesSyncTrigger", () => ({
  triggerMessagesSyncInBackground: jest.fn(),
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/autoLinkService", () => ({ autoLinkCommunicationsForContact: jest.fn() }));
jest.mock("../services/auditCoverageService", () => ({
  getAuditCoverage: jest.fn(),
  checkExportCompleteness: jest.fn(),
}));
jest.mock("../services/submissionSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/enhancedExportService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/folderExportService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/exportGate", () => ({
  enforceExportGate: jest.fn(),
  emitExportCompleted: jest.fn(),
}));

import { randomUUID } from "crypto";
import { registerTransactionExportHandlers } from "../handlers/transactionExportHandlers";

/** The handlers validate the id as a UUID; generated per run, never a stored value. */
const TX = randomUUID();
const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};

const ok = (extra: Record<string, unknown> = {}) => ({
  success: true,
  submissionId: "sub-3600-a",
  messagesCount: 2,
  attachmentsCount: 1,
  attachmentsFailed: 0,
  flaggedWithoutAttachments: 0,
  ...extra,
});

beforeAll(() => {
  registerTransactionExportHandlers(null);
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe("BACKLOG-3600 D5 — checklistsNotSent reaches the renderer", () => {
  it.each([
    ["transactions:submit", mockSubmitTransaction],
    ["transactions:resubmit", mockResubmitTransaction],
  ])("%s carries not_in_plan and refused", async (channel, service) => {
    for (const reason of ["not_in_plan", "refused"] as const) {
      service.mockResolvedValueOnce(ok({ checklistsNotSent: reason }));
      const result = await invoke(channel, TX);
      expect([channel, result.success, result.checklistsNotSent]).toEqual([channel, true, reason]);
    }
  });

  it.each([
    ["transactions:submit", mockSubmitTransaction],
    ["transactions:resubmit", mockResubmitTransaction],
  ])("%s says nothing when the service says nothing", async (channel, service) => {
    service.mockResolvedValueOnce(ok());
    const result = await invoke(channel, TX);
    expect(result.success).toBe(true);
    expect(result.checklistsNotSent).toBeUndefined();
  });
});
