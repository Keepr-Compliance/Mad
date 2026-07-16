/**
 * @jest-environment node
 */

/**
 * Unit tests for EntitlementService (BACKLOG-2006a).
 *
 * The paywall's whole correctness surface is FAIL-CLOSED: every non-positive
 * path must resolve LOCKED. These tests prove each branch (online-no-unlock,
 * refunded, read-error, offline-cached, offline-uncached, not-authenticated)
 * and the cache-is-a-mirror-never-grantor invariant.
 */

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────
jest.mock("electron", () => ({
  net: { isOnline: jest.fn(() => true) },
}));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

jest.mock("../logService", () => {
  const fns = {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
  };
  return { __esModule: true, default: fns, logService: fns };
});

// Chainable Supabase query builder mock: from().select().eq().eq().is().limit().maybeSingle()
const mockMaybeSingle = jest.fn();
const makeQueryBuilder = () => {
  const qb: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.maybeSingle = mockMaybeSingle;
  return qb;
};
const mockFrom = jest.fn(() => makeQueryBuilder());
const mockRpc = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: mockFrom,
      rpc: mockRpc,
      auth: { getSession: mockGetSession },
    }),
    getAuthSession: mockGetAuthSession,
  },
}));

// Offline cache mock (in-memory, so we can assert the mirror invariant).
const cacheStore = new Map<string, { local_transaction_id: string; user_id: string; unlocked_at: string; funding_source: string | null; cached_at: string }>();
const key = (tx: string, u: string) => `${tx}::${u}`;
const mockUpsert = jest.fn();
const mockRemove = jest.fn();
jest.mock("../db/unlockCacheDbService", () => ({
  getCachedUnlock: (tx: string, u: string) => cacheStore.get(key(tx, u)) ?? null,
  upsertUnlock: (p: { localTransactionId: string; userId: string; unlockedAt: string; fundingSource?: string | null }) => {
    mockUpsert(p);
    cacheStore.set(key(p.localTransactionId, p.userId), {
      local_transaction_id: p.localTransactionId,
      user_id: p.userId,
      unlocked_at: p.unlockedAt,
      funding_source: p.fundingSource ?? null,
      cached_at: "now",
    });
  },
  removeCachedUnlock: (tx: string, u: string) => {
    mockRemove(tx, u);
    cacheStore.delete(key(tx, u));
  },
  clearUnlockCache: () => cacheStore.clear(),
}));

import { net } from "electron";
import entitlementService from "../entitlementService";

const USER = "user-1";
const TX = "tx-abc";

const setOnline = (v: boolean) => (net.isOnline as jest.Mock).mockReturnValue(v);

beforeEach(() => {
  jest.clearAllMocks();
  cacheStore.clear();
  setOnline(true);
  mockGetAuthSession.mockResolvedValue({ userId: USER });
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: USER } } } });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("EntitlementService.getUnlockStatus — FAIL-CLOSED", () => {
  it("online + live non-refunded unlock row ⇒ UNLOCKED and mirrors to cache", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { unlocked_at: "2026-07-15T00:00:00Z", funding_source: "grant", refunded_at: null },
      error: null,
    });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("unlocked");
    expect(r.fromCache).toBe(false);
    // Positive confirmation is mirrored into the offline cache.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ localTransactionId: TX, userId: USER }),
    );
  });

  it("online + NO unlock row ⇒ LOCKED (no_unlock) and purges stale cache", async () => {
    // Pre-seed a stale cache row to prove server truth wins + purges it.
    cacheStore.set(key(TX, USER), {
      local_transaction_id: TX, user_id: USER, unlocked_at: "x", funding_source: null, cached_at: "old",
    });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("locked");
    expect(r.lockReason).toBe("no_unlock");
    expect(mockRemove).toHaveBeenCalledWith(TX, USER);
  });

  it("online + read ERROR ⇒ LOCKED (error) when no cache (fail-closed)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom", code: "500" } });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("locked");
    expect(r.lockReason).toBe("error");
  });

  it("online + read ERROR but PRIOR cached unlock ⇒ UNLOCKED (fromCache)", async () => {
    cacheStore.set(key(TX, USER), {
      local_transaction_id: TX, user_id: USER, unlocked_at: "y", funding_source: null, cached_at: "c",
    });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "network", code: "0" } });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("unlocked");
    expect(r.fromCache).toBe(true);
  });

  it("offline + cached prior unlock ⇒ UNLOCKED (fromCache); server NEVER contacted", async () => {
    setOnline(false);
    cacheStore.set(key(TX, USER), {
      local_transaction_id: TX, user_id: USER, unlocked_at: "z", funding_source: null, cached_at: "c",
    });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("unlocked");
    expect(r.fromCache).toBe(true);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("offline + EMPTY cache ⇒ LOCKED (offline_uncached) — absence never unlocks", async () => {
    setOnline(false);
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("locked");
    expect(r.lockReason).toBe("offline_uncached");
  });

  it("no auth session ⇒ LOCKED (not_authenticated); never reads server", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("locked");
    expect(r.lockReason).toBe("not_authenticated");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("refunded rows are filtered by the query (.is refunded_at null) ⇒ treated LOCKED", async () => {
    // The query filters refunded_at IS NULL, so a refunded-only row returns no data.
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const r = await entitlementService.getUnlockStatus(TX);
    expect(r.status).toBe("locked");
    // Assert the query actually applied the refunded_at IS NULL filter.
    const qb = mockFrom.mock.results[0].value as { is: jest.Mock };
    expect(qb.is).toHaveBeenCalledWith("refunded_at", null);
  });
});

describe("EntitlementService.getExportDecision — authoritative export gate", () => {
  const txList = [
    { id: "tx-new", closed_at: null, created_at: "2026-07-14T00:00:00Z" }, // first (most recent)
    { id: "tx-old", closed_at: null, created_at: "2026-01-01T00:00:00Z" },
  ];

  it("unlocked ⇒ mode 'full'", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { unlocked_at: "u", funding_source: "card", refunded_at: null }, error: null,
    });
    const d = await entitlementService.getExportDecision("tx-old", txList, false);
    expect(d).toEqual({ allowed: true, mode: "full" });
  });

  it("locked + first tx + requestSample ⇒ mode 'sample'", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const d = await entitlementService.getExportDecision("tx-new", txList, true);
    expect(d).toEqual({ allowed: true, mode: "sample" });
  });

  it("BYPASS ATTEMPT: locked + NON-first tx + requestSample ⇒ BLOCKED (mode 'none')", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const d = await entitlementService.getExportDecision("tx-old", txList, true);
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe("none");
  });

  it("BYPASS ATTEMPT: locked + first tx + NO sample flag ⇒ BLOCKED (full export denied)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const d = await entitlementService.getExportDecision("tx-new", txList, false);
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe("none");
  });
});

describe("EntitlementService.unlockWithCredit", () => {
  it("offline ⇒ fails without calling the RPC", async () => {
    setOnline(false);
    const r = await entitlementService.unlockWithCredit(TX);
    expect(r.success).toBe(false);
    expect(r.error).toBe("offline");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("RPC succeeds AND re-read confirms ⇒ success + unlocked", async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    // The confirming re-read returns a live unlock row.
    mockMaybeSingle.mockResolvedValue({
      data: { unlocked_at: "u", funding_source: "grant", refunded_at: null }, error: null,
    });
    const r = await entitlementService.unlockWithCredit(TX);
    expect(mockRpc).toHaveBeenCalledWith("unlock_transaction", { p_local_transaction_id: TX });
    expect(r).toEqual({ success: true, status: "unlocked" });
  });

  it("RPC 'succeeds' but re-read still LOCKED ⇒ not confirmed (fail-closed)", async () => {
    mockRpc.mockResolvedValue({ data: {}, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const r = await entitlementService.unlockWithCredit(TX);
    expect(r.success).toBe(false);
    expect(r.status).toBe("locked");
  });
});
