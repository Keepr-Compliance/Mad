/**
 * BACKLOG-2856: progress and cancellation AT THE IPC BOUNDARY.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE EXIST SEPARATELY FROM THE SERVICE CONTROLS
 * ---------------------------------------------------------------------------
 * The previous round on this PR shipped a defect that all 13 service-level
 * controls missed: the service returned a structured `error`, the renderer knew
 * how to display one, and the HANDLER between them dropped it — so a failed
 * force re-cache printed a green success. A boundary defect is invisible to
 * tests that stop one layer short of the boundary.
 *
 * Progress has exactly the same shape of risk, and worse odds: the service has
 * emitted `onProgress` marks since BACKLOG-1362 and every caller in the tree
 * passed `undefined`, so the emissions were dead code for five months while the
 * service's own tests could have "proved progress works" the whole time. The
 * control that matters is therefore not "the service emits" — it is "the
 * handler passes a real callback and forwards what it produces to the window".
 *
 * The already-in-progress guard is asserted here too, deliberately. The service
 * emits NO terminal event on that path, because the progress channel is shared
 * and a rejected caller's "done" would settle the bar of the run that is still
 * going. What settles the rejected caller is its own invoke response, which is a
 * boundary claim and can only be checked here.
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
const mockRequestCancel = jest.fn();
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: {
    precacheEmails: (...a: unknown[]) => mockPrecacheEmails(...a),
    requestPrecacheCancellation: (...a: unknown[]) => mockRequestCancel(...a),
  },
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

/** A stand-in main window that records what was pushed to the renderer. */
function makeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    win: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    },
  };
}

describe("emails:precache — progress reaches the renderer (BACKLOG-2856)", () => {
  let precache: IpcHandler;
  let harness: ReturnType<typeof makeWindow>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    harness = makeWindow();
    registerEmailSyncHandlers(harness.win as never);
    precache = handlers.get("emails:precache")!;
    mockCanExecute.mockReturnValue({ allowed: true });
  });

  /**
   * THE CONTROL THAT WOULD HAVE CAUGHT FIVE MONTHS OF DEAD EMISSIONS.
   *
   * MUTATION: pass `undefined` as the second argument to `precacheEmails` again
   * -> RED (no callback is handed over, nothing reaches the window).
   */
  it("hands the service a real progress callback and forwards its events to the window", async () => {
    mockPrecacheEmails.mockImplementation(
      async (_userId: string, onProgress: (p: unknown) => void) => {
        expect(typeof onProgress).toBe("function");
        onProgress({ phase: "repairing", current: 0, total: 0, percent: 5 });
        onProgress({ phase: "fetching", current: 12, total: 12, percent: 10 });
        onProgress({ phase: "done", current: 12, total: 12, percent: 100, outcome: "success" });
        return { fetched: 12, stored: 12 };
      },
    );

    await precache({}, "user-1", false);

    expect(harness.sent.map((s) => s.channel)).toEqual([
      "emails:precache-progress",
      "emails:precache-progress",
      "emails:precache-progress",
    ]);
    expect(harness.sent.map((s) => (s.payload as { phase: string }).phase)).toEqual([
      "repairing",
      "fetching",
      "done",
    ]);
  });

  /**
   * A cancelled run is neither green nor red at the boundary.
   *
   * MUTATION: delete the `if (result.cancelled)` block -> RED. Without it a
   * cancel falls through to the unconditional success return and Settings
   * reports "Re-cached 0 emails" over a run the user stopped.
   */
  it("reports a cancelled run as cancelled, not as a success and not as a failure", async () => {
    mockPrecacheEmails.mockResolvedValue({ fetched: 40, stored: 40, cancelled: true });

    const result = (await precache({}, "user-1", true)) as {
      success: boolean;
      cancelled?: boolean;
      error?: string;
      forceSwap?: unknown;
    };

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toMatch(/cancelled/i);
    expect(result.error).toMatch(/left unchanged/i);
    // Nothing was swapped, so nothing may suggest it was.
    expect(result.forceSwap).toBeUndefined();
  });

  /**
   * THE THIRD TERMINAL, at the only layer that can provide it.
   *
   * The service deliberately emits no progress when it rejects a second
   * concurrent run — a terminal broadcast there would settle the RUNNING run's
   * bar. So the rejected caller must be settled by the response instead, and the
   * response must carry something the renderer can act on.
   */
  it("settles a rejected concurrent run through the response, emitting no progress event", async () => {
    mockPrecacheEmails.mockResolvedValue({
      fetched: 0,
      stored: 0,
      error: "Precache already in progress",
    });

    const result = (await precache({}, "user-1", false)) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Precache already in progress");
    // Critically: the in-flight run's bar was not touched.
    expect(harness.sent).toEqual([]);
  });

  it("does not crash when the window has gone away mid-run", async () => {
    const destroyed = {
      isDestroyed: () => true,
      webContents: { send: () => { throw new Error("window is gone"); } },
    };
    handlers.clear();
    registerEmailSyncHandlers(destroyed as never);
    const handler = handlers.get("emails:precache")!;
    mockPrecacheEmails.mockImplementation(async (_u: string, onProgress: (p: unknown) => void) => {
      onProgress({ phase: "fetching", current: 1, total: 1, percent: 10 });
      return { fetched: 1, stored: 1 };
    });

    await expect(handler({}, "user-1", false)).resolves.toMatchObject({ success: true });
  });
});

describe("emails:cancel-precache handler (BACKLOG-2856)", () => {
  let cancel: IpcHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    registerEmailSyncHandlers({} as never);
    cancel = handlers.get("emails:cancel-precache")!;
  });

  it("is registered, so the Cancel button has something to call", () => {
    expect(cancel).toBeDefined();
  });

  it("asks the service to stop and reports that a run was stopped", async () => {
    mockRequestCancel.mockReturnValue(true);
    await expect(cancel({})).resolves.toEqual({ success: true });
    expect(mockRequestCancel).toHaveBeenCalledTimes(1);
  });

  it("reports success:false when no run was in flight, without erroring", async () => {
    mockRequestCancel.mockReturnValue(false);
    // Not an error: the run had already finished, which is the outcome the user
    // was asking for anyway.
    await expect(cancel({})).resolves.toEqual({ success: false });
  });
});
