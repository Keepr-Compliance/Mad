/**
 * BACKLOG-2313: the transactions:scan handler must be gated by an AUTHORITATIVE
 * main-process check. The auto-detect scan creates "pending" transactions from an
 * email address/pattern sweep, and it must run ONLY when the user is BOTH:
 *   1. Opted in locally  (enable_auto_detect toggle ON), AND
 *   2. Entitled          (org has ai_detection; no-org users are denied).
 *
 * When the gate denies, the handler must return a clean empty result
 * ({ success:true, transactionsFound:0, emailsScanned:0 }) and NEVER call
 * transactionService.scanAndExtractTransactions (i.e. create zero transactions).
 *
 * We capture the handler registered via ipcMain.handle and invoke it directly
 * with the gate's collaborators mocked, so this exercises the REAL
 * isAutoDetectAllowed logic end-to-end.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
}));

// wrapHandler: pass-through (behavior under test is the inner fn's return value).
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: IpcHandler) => fn,
}));

// --- Gate collaborators ------------------------------------------------------
const mockGetUserConfig = jest.fn();
jest.mock("../../services/llm/llmConfigService", () => ({
  __esModule: true,
  default: { getUserConfig: (...a: unknown[]) => mockGetUserConfig(...a) },
}));

const mockCheckFeature = jest.fn();
jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { checkFeature: (...a: unknown[]) => mockCheckFeature(...a) },
}));

const mockResolveOrgId = jest.fn();
jest.mock("../featureGateHandlers", () => ({
  __esModule: true,
  resolveOrgId: (...a: unknown[]) => mockResolveOrgId(...a),
  registerFeatureGateHandlers: jest.fn(),
}));

// --- Scan target -------------------------------------------------------------
const mockScan = jest.fn();
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    scanAndExtractTransactions: (...a: unknown[]) => mockScan(...a),
    cancelScan: jest.fn(),
    getTransactionWithContacts: jest.fn(),
  },
}));

const mockCanExecute = jest.fn();
jest.mock("../../utils/rateLimit", () => ({
  rateLimiters: {
    scan: { canExecute: (...a: unknown[]) => mockCanExecute(...a) },
    sync: { canExecute: jest.fn().mockReturnValue({ allowed: true }) },
    precache: { canExecute: jest.fn().mockReturnValue({ allowed: true }) },
  },
}));

const mockTriggerBatch = jest.fn();
jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerBatchTransactionSyncInBackground: (...a: unknown[]) => mockTriggerBatch(...a),
}));

// --- Neutralized imports so the module registers cleanly ---------------------
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: { precacheEmails: jest.fn(), syncTransactionEmails: jest.fn() },
  EMAIL_FETCH_SAFETY_CAP: 0,
  SENT_ITEMS_SAFETY_CAP: 0,
}));
jest.mock("../../services/db/contactDbService", () => ({ getEmailsByContactId: jest.fn() }));
jest.mock("../../utils/emailDateRange", () => ({ computeEmailFetchSinceDate: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {},
  validateUserId: (id: string) => id,
  validateTransactionId: (id: string) => id,
  sanitizeObject: (o: unknown) => o,
}));

import { registerEmailSyncHandlers } from "../emailSyncHandlers";

interface ScanResult {
  success: boolean;
  transactionsFound?: number;
  emailsScanned?: number;
}

describe("transactions:scan auto-detect gate (BACKLOG-2313)", () => {
  let scan: IpcHandler;

  beforeAll(() => {
    registerEmailSyncHandlers({} as never);
    scan = handlers.get("transactions:scan")!;
    expect(scan).toBeDefined();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanExecute.mockReturnValue({ allowed: true });
    // Default happy path: opted in + entitled. Individual tests override.
    mockGetUserConfig.mockResolvedValue({ autoDetectEnabled: true });
    mockResolveOrgId.mockResolvedValue("org-1");
    mockCheckFeature.mockResolvedValue({ allowed: true, value: "", source: "plan" });
    mockScan.mockResolvedValue({
      success: true,
      transactionsFound: 2,
      emailsScanned: 40,
      transactions: [],
    });
  });

  it("runs the scan when the user is opted in AND entitled", async () => {
    const result = (await scan({}, "user-1")) as ScanResult;

    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.transactionsFound).toBe(2);
    expect(result.emailsScanned).toBe(40);
  });

  it("does NOT run the scan (creates 0 transactions) when NOT entitled", async () => {
    mockCheckFeature.mockResolvedValue({ allowed: false, value: "", source: "plan" });

    const result = (await scan({}, "user-1")) as ScanResult;

    expect(mockScan).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, transactionsFound: 0, emailsScanned: 0 });
    // No post-scan background audit-window fetch when nothing was detected.
    expect(mockTriggerBatch).not.toHaveBeenCalled();
  });

  it("does NOT run the scan when the enable_auto_detect toggle is OFF (even if entitled)", async () => {
    mockGetUserConfig.mockResolvedValue({ autoDetectEnabled: false });

    const result = (await scan({}, "user-1")) as ScanResult;

    expect(mockScan).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, transactionsFound: 0, emailsScanned: 0 });
    // Toggle is checked FIRST — no entitlement round-trip when opted out.
    expect(mockResolveOrgId).not.toHaveBeenCalled();
    expect(mockCheckFeature).not.toHaveBeenCalled();
  });

  it("denies no-org (individual) users even when opted in", async () => {
    mockResolveOrgId.mockResolvedValue(null);

    const result = (await scan({}, "user-1")) as ScanResult;

    expect(mockScan).not.toHaveBeenCalled();
    expect(mockCheckFeature).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, transactionsFound: 0, emailsScanned: 0 });
  });

  it("fails CLOSED (no scan) when the gate check throws", async () => {
    mockGetUserConfig.mockRejectedValue(new Error("db not ready"));

    const result = (await scan({}, "user-1")) as ScanResult;

    expect(mockScan).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, transactionsFound: 0, emailsScanned: 0 });
  });

  it("still short-circuits with rateLimited before the gate runs", async () => {
    mockCanExecute.mockReturnValue({ allowed: false, remainingMs: 3000 });

    const result = (await scan({}, "user-1")) as ScanResult & { rateLimited?: boolean };

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(mockGetUserConfig).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });
});
