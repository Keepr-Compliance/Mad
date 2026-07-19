/**
 * BACKLOG-2127: the emails:precache IPC handler must forward a dead-token
 * `providerError` (returning success:false) instead of an unconditional
 * success:true, so the renderer sync flow can raise a reconnect prompt.
 *
 * We capture the handler registered via ipcMain.handle and invoke it directly
 * with the service layer mocked.
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

const mockPrecacheEmails = jest.fn();
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: { precacheEmails: (...a: unknown[]) => mockPrecacheEmails(...a) },
  EMAIL_FETCH_SAFETY_CAP: 0,
  SENT_ITEMS_SAFETY_CAP: 0,
}));

const mockCanExecute = jest.fn();
jest.mock("../../utils/rateLimit", () => ({
  rateLimiters: { precache: { canExecute: (...a: unknown[]) => mockCanExecute(...a) } },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

// Neutralize the other imports pulled in by the module so registration runs.
jest.mock("../../services/transactionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/contactDbService", () => ({ getEmailsByContactId: jest.fn() }));
jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerBatchTransactionSyncInBackground: jest.fn(),
}));
jest.mock("../../utils/emailDateRange", () => ({ computeEmailFetchSinceDate: jest.fn() }));
jest.mock("../../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {},
  validateUserId: (id: string) => id,
  validateTransactionId: (id: string) => id,
  sanitizeObject: (o: unknown) => o,
}));

import { registerEmailSyncHandlers } from "../emailSyncHandlers";

describe("emails:precache handler (BACKLOG-2127)", () => {
  let precache: IpcHandler;

  beforeAll(() => {
    registerEmailSyncHandlers({} as never);
    precache = handlers.get("emails:precache")!;
    expect(precache).toBeDefined();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanExecute.mockReturnValue({ allowed: true });
  });

  it("forwards providerError and returns success:false on a dead token", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 0,
      stored: 0,
      providerError: { provider: "microsoft", message: "expired", tokenExpired: true },
    });

    const result = (await precache({}, "user-1")) as {
      success: boolean;
      providerError?: { provider: string; tokenExpired: boolean };
      emailsFetched?: number;
    };

    expect(result.success).toBe(false);
    expect(result.providerError).toEqual({
      provider: "microsoft",
      message: "expired",
      tokenExpired: true,
    });
    expect(result.emailsFetched).toBe(0);
  });

  it("returns success:true with counts on a clean precache", async () => {
    mockPrecacheEmails.mockResolvedValue({ fetched: 5, stored: 3 });

    const result = (await precache({}, "user-1")) as {
      success: boolean;
      providerError?: unknown;
      emailsFetched?: number;
      emailsStored?: number;
    };

    expect(result.success).toBe(true);
    expect(result.providerError).toBeUndefined();
    expect(result.emailsFetched).toBe(5);
    expect(result.emailsStored).toBe(3);
  });

  it("still short-circuits with rateLimited without calling the service", async () => {
    mockCanExecute.mockReturnValue({ allowed: false, remainingMs: 12000 });

    const result = (await precache({}, "user-1")) as {
      success: boolean;
      rateLimited?: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(mockPrecacheEmails).not.toHaveBeenCalled();
  });
});
