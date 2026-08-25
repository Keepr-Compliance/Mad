/**
 * BACKLOG-2856: the emails:precache handler must not turn a force re-cache that
 * CHANGED NOTHING into a green success.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS WAS BORN RED AGAINST
 * ---------------------------------------------------------------------------
 * Found in SR review of PR #2382, and it was invisible to every test that
 * existed. The service returns a structured `error` on the two force paths that
 * decline to swap (no provider rebuilt; a throw inside the swap). The Settings
 * panel already renders `result.error`. The HANDLER between them dropped it: it
 * forwarded only `providerError.tokenExpired` and otherwise returned
 * `{ success: true, … }` unconditionally.
 *
 * The user-visible result, with one mailbox connected and its all-folders round
 * failing: the inbox round stages 47 messages, nothing is deleted, every
 * transaction link is intact — and Settings prints, in green, "Re-cached 47
 * emails (120 checked). Linked emails were unlinked from their transactions."
 * The user then goes and re-attaches mail that was never detached.
 *
 * The 13 controls in `emailSyncService.forceRecache-2856` all assert the SERVICE
 * return value, one layer BELOW where the message was dropped. That is the gap
 * these tests close, and it is why they live at the handler boundary.
 *
 * `emailsStored` is also not the number to report on a force run: it counts rows
 * written to the STAGING tables, so it is what was fetched, not what survived
 * the swap. The handler now forwards `forceSwap`, whose `emailsInserted` is what
 * actually landed.
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

type PrecacheResult = {
  success: boolean;
  error?: string;
  emailsFetched?: number;
  emailsStored?: number;
  forceSwap?: { emailsInserted: number; providers: string[] };
  providerError?: { provider: string; tokenExpired: boolean };
};

describe("emails:precache handler — a force run that changed nothing (BACKLOG-2856)", () => {
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

  /**
   * The exact shape SR reproduced: 47 staged, nothing swapped.
   *
   * MUTATION: delete the `if (result.error)` block from the handler -> this
   * returns `{ success: true, emailsFetched: 120, emailsStored: 47 }` with
   * `error` undefined, and both assertions go red. That is the born-red control.
   */
  it("returns success:false and the message when no provider could be rebuilt", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 120,
      stored: 47,
      error: "Re-cache could not complete for any connected mailbox. Nothing was changed.",
    });

    const result = (await precache({}, "user-1", true)) as PrecacheResult;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nothing was changed/i);
    // No swap happened, so nothing may imply one did.
    expect(result.forceSwap).toBeUndefined();
  });

  /** The other decline-to-swap path: a throw inside the swap transaction. */
  it("returns success:false and the message when the swap itself failed", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 120,
      stored: 47,
      error: "Re-cache could not be applied. Your emails were left unchanged.",
    });

    const result = (await precache({}, "user-1", true)) as PrecacheResult;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/left unchanged/i);
    expect(result.forceSwap).toBeUndefined();
  });

  /**
   * `error` is checked BEFORE the token-expiry branch, so the specific message
   * survives when both are set — which the no-provider-rebuilt path produces.
   */
  it("keeps the specific error when a providerError is also present", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 0,
      stored: 0,
      error: "Re-cache could not complete for any connected mailbox. Nothing was changed.",
      providerError: { provider: "microsoft", message: "expired", tokenExpired: true },
    });

    const result = (await precache({}, "user-1", true)) as PrecacheResult;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nothing was changed/i);
    expect(result.providerError).toEqual({
      provider: "microsoft",
      message: "expired",
      tokenExpired: true,
    });
  });

  /**
   * The success path forwards what actually landed.
   *
   * MUTATION: drop the `...(result.forceSwap ? …)` spread -> the renderer falls
   * back to its "nothing was replaced" sentence and the count disappears.
   */
  it("forwards forceSwap on a committed swap", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 120,
      stored: 47,
      forceSwap: {
        emailsDeleted: 47,
        emailsInserted: 47,
        participantsInserted: 94,
        providers: ["outlook"],
      },
    });

    const result = (await precache({}, "user-1", true)) as PrecacheResult;

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.forceSwap).toEqual({
      emailsDeleted: 47,
      emailsInserted: 47,
      participantsInserted: 94,
      providers: ["outlook"],
    });
  });

  /** An ordinary incremental precache is untouched by any of the above. */
  it("leaves the non-force path reporting success with its counts", async () => {
    mockPrecacheEmails.mockResolvedValue({ fetched: 5, stored: 3 });

    const result = (await precache({}, "user-1")) as PrecacheResult;

    expect(result.success).toBe(true);
    expect(result.emailsStored).toBe(3);
    expect(result.forceSwap).toBeUndefined();
    expect(mockPrecacheEmails).toHaveBeenCalledWith("user-1", undefined, { force: false });
  });
});
