/**
 * @jest-environment node
 */

/**
 * BACKLOG-1802 (Lifecycle T2): the founder auto-sync test matrix.
 *
 * planFetchWindows is the pure heart of the policy; ensureTransactionEmailsSynced
 * wires it to the fetch + bounds + throttle. Both are covered here with all
 * external services mocked (computeTransactionDateRange is REAL so windows are
 * genuine).
 *
 * Matrix coverage:
 *  - fresh install → old window → full-window fetch WITHOUT a manual sync
 *  - returning user, window extended into the un-cached PAST → backfill delta
 *  - new-mail freshness throttle (skip within threshold; export/date-change bypass)
 *  - date-change delta (forward + backfill deltas only)
 *  - provider failure → non-throwing
 */

import { jest } from "@jest/globals";

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

const mockGetTxn = jest.fn();
jest.mock("../transactionService", () => ({
  __esModule: true,
  default: { getTransactionWithContacts: mockGetTxn },
}));

const mockSyncTransactionEmails = jest.fn();
jest.mock("../emailSyncService", () => ({
  __esModule: true,
  default: { syncTransactionEmails: mockSyncTransactionEmails },
  EMAIL_CACHE_FRESHNESS_MS: 10 * 60 * 1000,
}));

const mockAutoLink = jest.fn();
jest.mock("../autoLinkService", () => ({
  autoLinkCommunicationsForContact: mockAutoLink,
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockGetEmailsByContactId = jest.fn();
jest.mock("../db/contactDbService", () => ({
  getEmailsByContactId: mockGetEmailsByContactId,
}));

const mockResolveAccountId = jest.fn();
const mockGetSyncState = jest.fn();
const mockUpdateCachedBounds = jest.fn();
const mockRecordSuccess = jest.fn();
const mockRecordFailure = jest.fn();
jest.mock("../db/emailSyncStateService", () => ({
  resolveMailboxAccountId: mockResolveAccountId,
  getSyncState: mockGetSyncState,
  updateCachedBounds: mockUpdateCachedBounds,
  recordSyncSuccess: mockRecordSuccess,
  recordSyncFailure: mockRecordFailure,
}));

import {
  planFetchWindows,
  ensureTransactionEmailsSynced,
  __resetSyncThrottleForTests,
} from "../transactionSyncTrigger";

const reqStart = new Date("2026-01-01T00:00:00.000Z");
const reqEnd = new Date("2026-04-01T00:00:00.000Z");

function acct(newest: string | null, oldest: string | null) {
  return {
    provider: "microsoft" as const,
    accountId: "acct-ms",
    state: newest && oldest
      ? ({ newest_cached_at: newest, oldest_cached_at: oldest } as never)
      : undefined,
  };
}

describe("planFetchWindows (pure)", () => {
  it("fresh install (no bounds) → single full-window sweep [reqStart, reqEnd]", () => {
    const windows = planFetchWindows([acct(null, null)], reqStart, reqEnd);
    expect(windows).toHaveLength(1);
    expect(windows[0].after.getTime()).toBe(reqStart.getTime());
    expect(windows[0].before.getTime()).toBe(reqEnd.getTime());
  });

  it("window fully covered by cache → no windows", () => {
    const windows = planFetchWindows(
      [acct("2026-05-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z")],
      reqStart,
      reqEnd,
    );
    expect(windows).toHaveLength(0);
  });

  it("new mail past the cache → forward-fill delta only (ends at reqEnd)", () => {
    // cached forward only to Mar 1, back past reqStart → just forward-fill
    const windows = planFetchWindows(
      [acct("2026-03-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z")],
      reqStart,
      reqEnd,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].before.getTime()).toBe(reqEnd.getTime());
    // starts before the newest watermark (buffer padding), never at reqStart
    expect(windows[0].after.getTime()).toBeLessThan(new Date("2026-03-01T00:00:00.000Z").getTime());
    expect(windows[0].after.getTime()).toBeGreaterThan(reqStart.getTime());
  });

  it("window predates the oldest cached email → backfill delta only (starts at reqStart)", () => {
    // cached forward past reqEnd, but only back to Feb 1 → just backfill
    const windows = planFetchWindows(
      [acct("2026-05-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")],
      reqStart,
      reqEnd,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].after.getTime()).toBe(reqStart.getTime());
    // ends just after the oldest watermark (buffer padding)
    expect(windows[0].before.getTime()).toBeGreaterThan(new Date("2026-02-01T00:00:00.000Z").getTime());
  });

  it("date-change extends BOTH ends → two deltas (forward + backfill)", () => {
    const windows = planFetchWindows(
      [acct("2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")],
      reqStart,
      reqEnd,
    );
    expect(windows).toHaveLength(2);
  });

  it("takes the LEAST-covered account across providers", () => {
    const windows = planFetchWindows(
      [
        acct("2026-05-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z"), // fully covers
        {
          provider: "google" as const,
          accountId: "acct-gg",
          state: { newest_cached_at: "2026-02-01T00:00:00.000Z", oldest_cached_at: "2026-02-01T00:00:00.000Z" } as never,
        },
      ],
      reqStart,
      reqEnd,
    );
    // second account is under-covered → deltas required
    expect(windows.length).toBeGreaterThan(0);
  });
});

describe("ensureTransactionEmailsSynced", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSyncThrottleForTests();
    mockGetTxn.mockResolvedValue({
      id: "tx-1",
      user_id: "user-1",
      started_at: "2026-01-01T00:00:00.000Z",
      closed_at: "2026-03-01T00:00:00.000Z",
      contact_assignments: [{ contact_id: "c1" }],
    });
    mockGetEmailsByContactId.mockReturnValue(["agent@example.com"]);
    mockResolveAccountId.mockImplementation((_u: unknown, provider: unknown) =>
      provider === "microsoft" ? "acct-ms" : null,
    );
    mockGetSyncState.mockReturnValue(undefined); // fresh by default
    (mockSyncTransactionEmails as jest.Mock).mockResolvedValue({ success: true });
    (mockAutoLink as jest.Mock).mockResolvedValue({ emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0, errors: 0 });
  });

  it("FRESH INSTALL: fetches the full audit window with NO manual sync click", async () => {
    const result = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "create" });

    expect(result.ran).toBe(true);
    expect(result.windowsFetched).toBe(1);
    expect(mockSyncTransactionEmails).toHaveBeenCalledTimes(1);
    const call = (mockSyncTransactionEmails.mock.calls[0] as [Record<string, unknown>])[0];
    const window = call.window as { after: Date; before: Date };
    // full window starts at the transaction's started_at (the audit window floor)
    expect(window.after.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // bounds advanced + success recorded
    expect(mockUpdateCachedBounds).toHaveBeenCalled();
    expect(mockRecordSuccess).toHaveBeenCalled();
  });

  it("FRESHNESS THROTTLE: a second open within the window is skipped", async () => {
    await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });
    mockSyncTransactionEmails.mockClear();

    const second = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });
    expect(second.ran).toBe(false);
    expect(second.skipped).toBe("throttled");
    expect(mockSyncTransactionEmails).not.toHaveBeenCalled();
  });

  it("EXPORT bypasses the throttle (completeness backstop)", async () => {
    await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });
    mockSyncTransactionEmails.mockClear();

    // export runs even though we just synced (throttle bypassed)
    const exported = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "export" });
    expect(exported.skipped).not.toBe("throttled");
    expect(mockSyncTransactionEmails).toHaveBeenCalledTimes(1);
  });

  it("COVERED window: no fetch, but auto-link still runs (cross-transaction completeness)", async () => {
    mockGetSyncState.mockReturnValue({
      newest_cached_at: "2026-06-01T00:00:00.000Z",
      oldest_cached_at: "2025-01-01T00:00:00.000Z",
    });
    const result = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });

    expect(result.skipped).toBe("covered");
    expect(mockSyncTransactionEmails).not.toHaveBeenCalled();
    expect(mockAutoLink).toHaveBeenCalledWith({ contactId: "c1", transactionId: "tx-1" });
  });

  it("no connected provider → skipped:no_provider", async () => {
    mockResolveAccountId.mockReturnValue(null);
    const result = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });
    expect(result.skipped).toBe("no_provider");
    expect(mockSyncTransactionEmails).not.toHaveBeenCalled();
  });

  it("is NON-THROWING when the provider fetch fails, and records the failure", async () => {
    (mockSyncTransactionEmails as jest.Mock).mockRejectedValue(new Error("graph 500"));
    const result = await ensureTransactionEmailsSynced({ transactionId: "tx-1", reason: "open" });
    expect(result.ran).toBe(false);
    expect(result.error).toContain("graph 500");
    expect(mockRecordFailure).toHaveBeenCalled();
  });

  it("returns skipped:not_found for a missing transaction", async () => {
    mockGetTxn.mockResolvedValue(null);
    const result = await ensureTransactionEmailsSynced({ transactionId: "nope", reason: "open" });
    expect(result.skipped).toBe("not_found");
  });
});
