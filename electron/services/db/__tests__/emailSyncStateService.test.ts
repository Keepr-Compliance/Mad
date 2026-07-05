/**
 * @jest-environment node
 */

/**
 * BACKLOG-1802 (Lifecycle T2): unit tests for the per-account email_sync_state
 * service. The load-bearing behavior is the EXTEND-ONLY bounds update (newest only
 * advances forward, oldest only advances backward) — this is what makes the
 * once-only backfill rule hold. Core DB is mocked; we assert the SQL params.
 */

import { jest } from "@jest/globals";

const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: mockDbGet,
  dbRun: mockDbRun,
}));

const mockLogService = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("../../logService", () => mockLogService);

import {
  resolveMailboxAccountId,
  getSyncState,
  updateCachedBounds,
  recordSyncSuccess,
  recordSyncFailure,
  ensureSyncStateRow,
  getCursor,
  setCursor,
} from "../emailSyncStateService";

const USER = "user-1";
const ACCT = "acct-ms-1";

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER,
    account_id: ACCT,
    provider: "microsoft",
    phase: "active",
    cursor: null,
    newest_cached_at: "2026-03-01T00:00:00.000Z",
    oldest_cached_at: "2026-02-01T00:00:00.000Z",
    last_reconciled_at: null,
    last_error: null,
    failure_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("emailSyncStateService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbRun.mockReturnValue({ changes: 1, lastInsertRowid: 0 });
  });

  describe("resolveMailboxAccountId", () => {
    it("returns the oauth_tokens.id for a connected mailbox", () => {
      mockDbGet.mockReturnValueOnce({ id: "acct-xyz" });
      expect(resolveMailboxAccountId(USER, "microsoft")).toBe("acct-xyz");
      const [sql, params] = mockDbGet.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("FROM oauth_tokens");
      expect(sql).toContain("purpose = 'mailbox'");
      expect(params).toEqual([USER, "microsoft"]);
    });

    it("returns null when no mailbox is connected for the provider", () => {
      mockDbGet.mockReturnValueOnce(undefined);
      expect(resolveMailboxAccountId(USER, "google")).toBeNull();
    });
  });

  describe("getSyncState", () => {
    it("reads the row by (user_id, account_id)", () => {
      mockDbGet.mockReturnValueOnce(stateRow());
      const row = getSyncState(USER, ACCT);
      expect(row?.newest_cached_at).toBe("2026-03-01T00:00:00.000Z");
      const [, params] = mockDbGet.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([USER, ACCT]);
    });
  });

  describe("updateCachedBounds (extend-only)", () => {
    it("advances newest forward and oldest backward on an existing row", () => {
      mockDbGet.mockReturnValueOnce(stateRow());
      updateCachedBounds(USER, ACCT, "microsoft", {
        newest: "2026-04-01T00:00:00.000Z", // later than existing 03-01 → advances
        oldest: "2026-01-01T00:00:00.000Z", // earlier than existing 02-01 → advances
      });
      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE email_sync_state");
      expect(params[0]).toBe("2026-04-01T00:00:00.000Z"); // newest
      expect(params[1]).toBe("2026-01-01T00:00:00.000Z"); // oldest
    });

    it("does NOT shrink bounds when given a narrower range (once-only backfill)", () => {
      mockDbGet.mockReturnValueOnce(stateRow());
      updateCachedBounds(USER, ACCT, "microsoft", {
        newest: "2026-02-15T00:00:00.000Z", // earlier than existing 03-01 → keep 03-01
        oldest: "2026-02-20T00:00:00.000Z", // later than existing 02-01 → keep 02-01
      });
      const [, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(params[0]).toBe("2026-03-01T00:00:00.000Z"); // newest unchanged
      expect(params[1]).toBe("2026-02-01T00:00:00.000Z"); // oldest unchanged
    });

    it("INSERTs a fresh row when none exists, using the given bounds", () => {
      mockDbGet.mockReturnValueOnce(undefined);
      updateCachedBounds(USER, ACCT, "google", {
        newest: "2026-05-01T00:00:00.000Z",
        oldest: "2026-01-05T00:00:00.000Z",
      });
      const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO email_sync_state");
      expect(params).toEqual([
        USER,
        ACCT,
        "google",
        "2026-05-01T00:00:00.000Z",
        "2026-01-05T00:00:00.000Z",
      ]);
    });
  });

  describe("getCursor / setCursor (BACKLOG-1831)", () => {
    it("getCursor returns the stored cursor string, or null when unset", () => {
      mockDbGet.mockReturnValueOnce(stateRow({ cursor: '{"inbox":"link-1"}' }));
      expect(getCursor(USER, ACCT)).toBe('{"inbox":"link-1"}');

      mockDbGet.mockReturnValueOnce(stateRow({ cursor: null }));
      expect(getCursor(USER, ACCT)).toBeNull();

      mockDbGet.mockReturnValueOnce(undefined); // no row at all
      expect(getCursor(USER, ACCT)).toBeNull();
    });

    it("setCursor UPDATEs the cursor column by (user_id, account_id)", () => {
      const map = JSON.stringify({ inbox: "link-a", "folder-2": "link-b" });
      setCursor(USER, ACCT, map);
      expect(mockDbRun).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE email_sync_state");
      expect(sql).toContain("SET cursor = ?");
      expect(params).toEqual([map, USER, ACCT]);
    });

    it("round-trips a multi-folder JSON cursor map", () => {
      const map = { inbox: "delta-inbox", archive: "delta-archive", "custom-3": "delta-3" };
      setCursor(USER, ACCT, JSON.stringify(map));
      const [, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      mockDbGet.mockReturnValueOnce(stateRow({ cursor: params[0] as string }));
      expect(JSON.parse(getCursor(USER, ACCT) as string)).toEqual(map);
    });
  });

  describe("ensureSyncStateRow", () => {
    it("uses INSERT OR IGNORE so it never resurrects a cleared row", () => {
      ensureSyncStateRow(USER, ACCT, "microsoft");
      const [sql] = mockDbRun.mock.calls[0] as [string];
      expect(sql).toContain("INSERT OR IGNORE INTO email_sync_state");
    });
  });

  describe("recordSyncSuccess / recordSyncFailure", () => {
    it("success clears last_error and resets failure_count", () => {
      recordSyncSuccess(USER, ACCT, "microsoft");
      // First call ensures the row; the UPDATE is the last dbRun call.
      const last = mockDbRun.mock.calls[mockDbRun.mock.calls.length - 1] as [string];
      expect(last[0]).toContain("last_error = NULL");
      expect(last[0]).toContain("failure_count = 0");
    });

    it("failure stores the message and increments failure_count", () => {
      recordSyncFailure(USER, ACCT, "microsoft", new Error("boom"));
      const last = mockDbRun.mock.calls[mockDbRun.mock.calls.length - 1] as [string, unknown[]];
      expect(last[0]).toContain("failure_count = failure_count + 1");
      expect(last[1][0]).toBe("boom");
    });
  });
});
