/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 — unlimited transactions in the export paywall, online (live
 * read) and offline (signed pass).
 *
 * Fixtures transcribed from the live producers:
 *   - get_org_features (public.get_org_features, read 2026-10-03):
 *       success  {org_id, plan_name, plan_tier, features:{<key>:{enabled, value,
 *                 value_type, name, source}}}
 *       refusal  {error:"not_authorized", features: []}   (features is an ARRAY)
 *   - membership: supabaseService.getActiveOrganizationMembershipOutcome
 *       {status:"member", organization_id, organization_name, is_personal} |
 *       {status:"none"} | {status:"error"}
 *   - issuer response: supabase/functions/issue-offline-pass/index.ts
 *       {pass:"<token>"} | {pass:null, reason}
 * Synthetic ids only. The Ed25519 key pair is generated in memory per run.
 *
 * Real modules under test: entitlementService, offlinePassVerifier,
 * offlinePassStore (temp userData dir, fake OS secret store).
 */

import { generateKeyPairSync, sign, type KeyObject } from "crypto";
import { mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";

// ── Mocks ────────────────────────────────────────────────────────────────
const mockIsOnline = jest.fn(() => true);
const mockUserData = { dir: "" };
jest.mock("electron", () => ({
  net: { isOnline: () => mockIsOnline() },
  app: { getPath: () => mockUserData.dir },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});

const mockKeyMap: Record<string, string> = {};
jest.mock("../../constants/offlinePassKeys", () => ({
  get OFFLINE_PASS_PUBLIC_KEYS() {
    return mockKeyMap;
  },
}));

const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn(() => {
  const qb: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) qb[m] = jest.fn(() => qb);
  qb.maybeSingle = mockMaybeSingle;
  return qb;
});
const mockRpc = jest.fn();
const mockInvoke = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthSession = jest.fn();
const mockMembership = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: mockFrom,
      rpc: mockRpc,
      auth: { getSession: mockGetSession },
      functions: { invoke: mockInvoke },
    }),
    getAuthSession: () => mockGetAuthSession(),
    getActiveOrganizationMembershipOutcome: (u: string) => mockMembership(u),
  },
}));

const cacheStore = new Map<string, true>();
const mockUpsert = jest.fn();
jest.mock("../db/unlockCacheDbService", () => ({
  getCachedUnlock: async (tx: string, u: string) => (cacheStore.has(`${tx}::${u}`) ? { tx } : null),
  upsertUnlock: async (p: { localTransactionId: string; userId: string }) => {
    mockUpsert(p);
    cacheStore.set(`${p.localTransactionId}::${p.userId}`, true);
  },
  removeCachedUnlock: async (tx: string, u: string) => {
    cacheStore.delete(`${tx}::${u}`);
  },
}));

// featureGateService is NOT a dependency of the paywall. If anything loads it,
// this mock says "everything allowed" — P10 proves it is never consulted.
const mockStrictAllowed = jest.fn(() => "allowed");
const mockFeatureGateLoads = { count: 0 };
jest.mock("../featureGateService", () => {
  mockFeatureGateLoads.count += 1; // the factory runs only when something requires the module
  return {
    __esModule: true,
    default: { isAllowed: () => true, isStrictFeatureAllowed: () => mockStrictAllowed() },
  };
});

// ── Test key + token helpers ─────────────────────────────────────────────
const { privateKey: K1_PRIV, publicKey: K1_PUB } = generateKeyPairSync("ed25519");
const K1_SPKI = K1_PUB.export({ format: "der", type: "spki" }).toString("base64");

const USER_A = "user-a-3675";
const USER_B = "user-b-3675";
const ORG_A = "org-a-3675";
const TX = "tx-3675-1";

const nowSec = () => Math.floor(Date.now() / 1000);
const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function makePass(over: Record<string, unknown> = {}, key: KeyObject = K1_PRIV, kid = "k1"): string {
  const iat = nowSec() - 60;
  const payload = {
    v: 1, sub: USER_A, ent: "unlimited_transactions", org: ORG_A,
    iat, exp: iat + 172800, pte: null, jti: "jti-3675",
    ...over,
  };
  const input = `${seg({ alg: "EdDSA", typ: "keepr-offline-pass", kid })}.${seg(payload)}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), key).toString("base64url")}`;
}

function orgFeatures(enabled: unknown, extra: Record<string, unknown> = {}) {
  return {
    org_id: ORG_A,
    plan_name: "Individual",
    plan_tier: "individual",
    features: {
      transaction_checklists: { enabled: true, value: "true", value_type: "boolean", name: "Transaction checklists", source: "override" },
      unlimited_transactions: { enabled, value: "false", value_type: "boolean", name: "Unlimited transactions", source: enabled === true ? "override" : "plan" },
      ...extra,
    },
  };
}
const NOT_AUTHORIZED = { error: "not_authorized", features: [] as unknown[] };
const MEMBER = { status: "member", organization_id: ORG_A, organization_name: "Personal", is_personal: true };

type Service = typeof import("../entitlementService").default;
let service: Service;
let store: typeof import("../offlinePass/offlinePassStore");

const rpcNames = () => mockRpc.mock.calls.map((c) => c[0]);
const orgFeatureCalls = () => rpcNames().filter((n) => n === "get_org_features").length;

function entitledLive() {
  mockMembership.mockResolvedValue(MEMBER);
  mockRpc.mockImplementation(async (name: string) =>
    name === "get_org_features" ? { data: orgFeatures(true), error: null } : { data: { ok: true }, error: null },
  );
}
function notEntitledLive() {
  mockMembership.mockResolvedValue(MEMBER);
  mockRpc.mockImplementation(async (name: string) =>
    name === "get_org_features" ? { data: orgFeatures(false), error: null } : { data: { ok: true }, error: null },
  );
}
function errorLive() {
  mockMembership.mockResolvedValue({ status: "error" });
  mockRpc.mockImplementation(async () => ({ data: { ok: true }, error: null }));
}
const passFile = () => path.join(mockUserData.dir, "offline-pass.bin");

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  cacheStore.clear();
  for (const k of Object.keys(mockKeyMap)) delete mockKeyMap[k];
  mockKeyMap.k1 = K1_SPKI;
  mockUserData.dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3675-svc-"));
  mockIsOnline.mockReturnValue(true);
  mockGetAuthSession.mockResolvedValue({ userId: USER_A });
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: USER_A } } } });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null }); // no unlock row
  mockInvoke.mockResolvedValue({ data: { pass: null, reason: "not_entitled" }, error: null });
  notEntitledLive();

  // Fresh module graph per test (memo state), with a fake OS secret store.
  const provider = require("../../capabilities/secretStoreProvider");
  provider.installSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`ENC1:${Buffer.from(s).toString("base64")}`),
    decryptString: (b: Buffer) => {
      const t = b.toString();
      if (!t.startsWith("ENC1:")) throw new Error("not ciphertext");
      return Buffer.from(t.slice(5), "base64").toString();
    },
  });
  service = require("../entitlementService").default;
  store = require("../offlinePass/offlinePassStore");
});

const flush = () => new Promise((r) => setImmediate(r));

afterEach(async () => {
  // Exports start the pass refresh without awaiting it (by design). Let any
  // such write/delete settle before removing the temp userData dir — Windows
  // refuses to remove a directory another write is still filling.
  for (let i = 0; i < 20; i += 1) await flush();
  try {
    rmSync(mockUserData.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Each test has its own mkdtemp dir, so a leftover cannot affect another test.
  }
});

// ── Online, live read ────────────────────────────────────────────────────
describe("BACKLOG-3675 online: live entitlement read", () => {
  it("C1 entitled + no unlock row ⇒ export allowed; enforceExportGate does not throw", async () => {
    entitledLive();
    expect(await service.getExportDecision(TX)).toEqual({ allowed: true, mode: "full" });
    const { enforceExportGate } = require("../exportGate");
    await expect(enforceExportGate({ transactionId: TX, userId: USER_A, communications: [] })).resolves.not.toThrow();
  });

  it("C2/P15 entitled ⇒ no debit RPC, no unlock-cache write, no quote/balance fetch", async () => {
    entitledLive();
    const status = await service.getEntitlementStatus(TX);
    expect(status.status).toBe("unlocked");
    expect(rpcNames()).not.toContain("unlock_transaction");
    expect(rpcNames()).not.toContain("get_next_unlock_quote");
    expect(rpcNames()).not.toContain("get_credit_balance");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["membership none", () => mockMembership.mockResolvedValue({ status: "none" })],
    ["membership error", () => mockMembership.mockResolvedValue({ status: "error" })],
    ["membership throws", () => mockMembership.mockRejectedValue(new Error("boom"))],
    ["not_authorized refusal (features array)", () => {
      mockMembership.mockResolvedValue(MEMBER);
      mockRpc.mockResolvedValue({ data: NOT_AUTHORIZED, error: null });
    }],
    ["rpc error", () => {
      mockMembership.mockResolvedValue(MEMBER);
      mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    }],
    ["key missing", () => {
      mockMembership.mockResolvedValue(MEMBER);
      const f = orgFeatures(true);
      delete (f.features as Record<string, unknown>).unlimited_transactions;
      mockRpc.mockResolvedValue({ data: f, error: null });
    }],
    ['enabled is the string "true"', () => {
      mockMembership.mockResolvedValue(MEMBER);
      mockRpc.mockResolvedValue({ data: orgFeatures("true"), error: null });
    }],
    ["enabled false", () => notEntitledLive()],
  ])("C3 %s, no pass ⇒ PAYWALL_LOCKED with lockReason no_unlock", async (_name, arrange) => {
    arrange();
    const d = await service.getExportDecision(TX);
    expect(d).toEqual({ allowed: false, mode: "none", reason: "no_unlock" });
    const { enforceExportGate } = require("../exportGate");
    await expect(enforceExportGate({ transactionId: TX, userId: USER_A, communications: [] })).rejects.toThrow(/PAYWALL_LOCKED/);
  });

  it("C3 a hanging read times out after 5 s ⇒ locked", async () => {
    jest.useFakeTimers();
    try {
      mockMembership.mockReturnValue(new Promise(() => {}));
      const pending = service.getExportDecision(TX);
      await jest.advanceTimersByTimeAsync(5_001);
      expect(await pending).toEqual({ allowed: false, mode: "none", reason: "no_unlock" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("C4 deal unlocked by a row ⇒ no membership read, no get_org_features", async () => {
    entitledLive();
    mockMaybeSingle.mockResolvedValue({
      data: { unlocked_at: "2026-10-01T00:00:00Z", funding_source: "grant", refunded_at: null },
      error: null,
    });
    expect((await service.getUnlockStatus(TX)).status).toBe("unlocked");
    expect(mockMembership).not.toHaveBeenCalled();
    expect(orgFeatureCalls()).toBe(0);
  });

  it("C4 offline ⇒ no live read; row read failed ⇒ no live read", async () => {
    entitledLive();
    mockIsOnline.mockReturnValue(false);
    await service.getUnlockStatus(TX);
    mockIsOnline.mockReturnValue(true);
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "net", code: "0" } });
    await service.getUnlockStatus(TX);
    expect(mockMembership).not.toHaveBeenCalled();
    expect(orgFeatureCalls()).toBe(0);
  });

  it("C5 bulk: 3 deals through enforceExportGate, entitled ⇒ none throw; exactly one live read", async () => {
    entitledLive();
    const { enforceExportGate } = require("../exportGate");
    for (const tx of ["tx-b1", "tx-b2", "tx-b3"]) {
      await expect(enforceExportGate({ transactionId: tx, userId: USER_A, communications: [] })).resolves.not.toThrow();
    }
    expect(mockMembership).toHaveBeenCalledTimes(1);
    expect(orgFeatureCalls()).toBe(1);
  });

  it("C7 revoke: entitled, then override removed, 61 s later ⇒ locked", async () => {
    const t0 = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(t0);
    try {
      entitledLive();
      expect((await service.getExportDecision(TX)).allowed).toBe(true);
      notEntitledLive();
      spy.mockReturnValue(t0 + 30_000);
      expect((await service.getExportDecision(TX)).allowed).toBe(true); // inside the memo
      spy.mockReturnValue(t0 + 61_000);
      expect(await service.getExportDecision(TX)).toEqual({ allowed: false, mode: "none", reason: "no_unlock" });
    } finally {
      spy.mockRestore();
    }
  });

  it("C8 user A entitled, user B not ⇒ B locked", async () => {
    mockMembership.mockImplementation(async () => MEMBER);
    mockRpc.mockImplementation(async (name: string) => {
      const session = await mockGetAuthSession();
      return name === "get_org_features"
        ? { data: orgFeatures(session.userId === USER_A), error: null }
        : { data: {}, error: null };
    });
    expect((await service.getExportDecision(TX)).allowed).toBe(true);
    mockGetAuthSession.mockResolvedValue({ userId: USER_B });
    expect((await service.getExportDecision(TX)).allowed).toBe(false);
  });

  it("C9 the service's feature key equals the key the migration inserts", () => {
    const { UNLIMITED_TRANSACTIONS_FEATURE_KEY } = require("../entitlementService");
    const fs = require("fs");
    const sql: string = fs.readFileSync(
      path.join(__dirname, "../../../supabase/migrations/20261003140000_backlog_3675_unlimited_transactions_feature.sql"),
      "utf8",
    );
    const inserted = [...sql.matchAll(/VALUES \(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inserted).toEqual([UNLIMITED_TRANSACTIONS_FEATURE_KEY]);
    expect(sql).toMatch(new RegExp(`fd\\.key = '${UNLIMITED_TRANSACTIONS_FEATURE_KEY}'`));
  });

  it("P10 featureGateService (disk feature cache) says allowed, network down, no pass ⇒ locked; never loaded", async () => {
    mockStrictAllowed.mockReturnValue("allowed");
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "net", code: "0" } });
    expect(await service.getExportDecision(TX)).toEqual({ allowed: false, mode: "none", reason: "error" });
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(false);
    expect(mockStrictAllowed).not.toHaveBeenCalled();
    // beforeEach loaded a fresh entitlementService graph; featureGateService was not in it.
    expect(mockFeatureGateLoads.count).toBe(0);
  });
});

// ── Offline pass ─────────────────────────────────────────────────────────
describe("BACKLOG-3675 offline pass", () => {
  it("P6 offline, no unlock cache, valid pass ⇒ export allowed", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    mockIsOnline.mockReturnValue(false);
    expect(await service.getExportDecision(TX)).toEqual({ allowed: true, mode: "full" });
    const { enforceExportGate } = require("../exportGate");
    await expect(enforceExportGate({ transactionId: TX, userId: USER_A, communications: [] })).resolves.not.toThrow();
  });

  it("P6 control: offline, no pass ⇒ locked offline_uncached", async () => {
    mockIsOnline.mockReturnValue(false);
    expect(await service.getExportDecision(TX)).toEqual({ allowed: false, mode: "none", reason: "offline_uncached" });
  });

  it("flipped byte in the stored pass ⇒ offline export locked", async () => {
    const [h, p, s] = makePass().split(".");
    const sig = Buffer.from(s, "base64url");
    sig[0] ^= 0x80;
    await store.storeOfflinePass(`${h}.${p}.${sig.toString("base64url")}`, nowSec() - 60);
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(false);
  });

  it("expired stored pass ⇒ offline export locked", async () => {
    const iat = nowSec() - 172800 - 10;
    await store.storeOfflinePass(makePass({ iat, exp: iat + 172800 }), iat);
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(false);
  });

  it("pass for another user ⇒ offline export locked", async () => {
    await store.storeOfflinePass(makePass({ sub: USER_B }), nowSec() - 60);
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(false);
  });

  it.each([
    ["enabled false", () => notEntitledLive()],
    ["membership none", () => mockMembership.mockResolvedValue({ status: "none" })],
    ["not_authorized", () => {
      mockMembership.mockResolvedValue(MEMBER);
      mockRpc.mockResolvedValue({ data: NOT_AUTHORIZED, error: null });
    }],
  ])("P7 online row 'no', valid pass stored, live %s ⇒ locked no_unlock AND pass deleted", async (_n, arrange) => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    arrange();
    expect(await service.getExportDecision(TX)).toEqual({ allowed: false, mode: "none", reason: "no_unlock" });
    expect(existsSync(passFile())).toBe(false);
  });

  it("P7 a remembered live 'no' beats a pass still on disk (e.g. a delete that failed)", async () => {
    notEntitledLive();
    expect((await service.getExportDecision("tx-m1")).allowed).toBe(false); // memo: not_entitled
    await store.storeOfflinePass(makePass(), nowSec() - 60); // pass reappears on disk
    expect(await service.getExportDecision("tx-m2")).toEqual({ allowed: false, mode: "none", reason: "no_unlock" });
    expect(mockMembership).toHaveBeenCalledTimes(1); // the second answer came from the memo
  });

  it("P7 entitled live + valid pass ⇒ unlocked from the live read (exactly one), not the pass", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    entitledLive();
    const r = await service.getUnlockStatus(TX);
    expect(r).toEqual({ status: "unlocked", fromCache: false });
    expect(mockMembership).toHaveBeenCalledTimes(1);
  });

  it("P7 live read error + valid pass (online, row 'no') ⇒ unlocked from the pass", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    errorLive();
    expect(await service.getUnlockStatus(TX)).toEqual({ status: "unlocked", fromCache: false, fromPass: true });
  });

  it("P7b row read fails, no cache, valid pass ⇒ unlocked; no live read", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "net", code: "0" } });
    expect(await service.getUnlockStatus(TX)).toEqual({ status: "unlocked", fromCache: false, fromPass: true });
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it("P7b row read fails, no cache, no pass ⇒ locked error", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "net", code: "0" } });
    expect(await service.getUnlockStatus(TX)).toEqual({ status: "locked", fromCache: false, lockReason: "error" });
  });

  it("P12 bulk offline: 3 deals, valid pass ⇒ none throw", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    mockIsOnline.mockReturnValue(false);
    const { enforceExportGate } = require("../exportGate");
    for (const tx of ["tx-o1", "tx-o2", "tx-o3"]) {
      await expect(enforceExportGate({ transactionId: tx, userId: USER_A, communications: [] })).resolves.not.toThrow();
    }
  });

  it("P15 pass path ⇒ unlock cache never written", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    mockIsOnline.mockReturnValue(false);
    await service.getUnlockStatus(TX);
    mockIsOnline.mockReturnValue(true);
    errorLive();
    await service.getUnlockStatus(TX);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("P13b a far-future high-water mark does not block a freshly issued pass", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    await store.readOfflinePass(nowSec() + 10 * 365 * 86400); // forward clock jump observed
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(false);

    mockIsOnline.mockReturnValue(true);
    entitledLive();
    mockInvoke.mockResolvedValue({ data: { pass: makePass() }, error: null });
    await service.runOfflinePassRefreshTick();
    mockIsOnline.mockReturnValue(false);
    expect((await service.getExportDecision(TX)).allowed).toBe(true);
  });
});

// ── Debit ────────────────────────────────────────────────────────────────
describe("BACKLOG-3675 no debit for an unlimited account", () => {
  it("P9/C10 online entitled ⇒ unlockWithCredit returns unlocked, zero unlock_transaction", async () => {
    entitledLive();
    expect(await service.unlockWithCredit(TX)).toEqual({ success: true, status: "unlocked" });
    expect(rpcNames()).not.toContain("unlock_transaction");
  });

  it("C10 the debit read bypasses a stale 'no' memo", async () => {
    notEntitledLive();
    await service.getExportDecision(TX); // memo: not_entitled
    entitledLive();
    expect(await service.unlockWithCredit(TX)).toEqual({ success: true, status: "unlocked" });
    expect(rpcNames()).not.toContain("unlock_transaction");
  });

  it("C10b live read error + valid pass ⇒ unlocked, zero RPC", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    errorLive();
    expect(await service.unlockWithCredit(TX)).toEqual({ success: true, status: "unlocked" });
    expect(rpcNames()).not.toContain("unlock_transaction");
  });

  it("C10b live read error + no pass ⇒ entitlement_unverified, zero RPC", async () => {
    errorLive();
    expect(await service.unlockWithCredit(TX)).toEqual({
      success: false, status: "locked", error: "entitlement_unverified",
    });
    expect(rpcNames()).not.toContain("unlock_transaction");
  });

  it("not entitled ⇒ today's debit path runs", async () => {
    notEntitledLive();
    await service.unlockWithCredit(TX);
    expect(mockRpc).toHaveBeenCalledWith("unlock_transaction", { p_local_transaction_id: TX });
  });
});

// ── Refresher ────────────────────────────────────────────────────────────
describe("BACKLOG-3675 P16 offline pass refresher", () => {
  it("entitled tick ⇒ issuer invoked once; verified pass stored", async () => {
    entitledLive();
    mockInvoke.mockResolvedValue({ data: { pass: makePass() }, error: null });
    await service.runOfflinePassRefreshTick();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("issue-offline-pass", { body: {} });
    expect(existsSync(passFile())).toBe(true);
  });

  it("issuer returns a pass for another user ⇒ not stored", async () => {
    entitledLive();
    mockInvoke.mockResolvedValue({ data: { pass: makePass({ sub: USER_B }) }, error: null });
    await service.runOfflinePassRefreshTick();
    expect(existsSync(passFile())).toBe(false);
  });

  it("issuer returns a pass signed by an unlisted key ⇒ not stored", async () => {
    entitledLive();
    const other = generateKeyPairSync("ed25519").privateKey;
    mockInvoke.mockResolvedValue({ data: { pass: makePass({}, other) }, error: null });
    await service.runOfflinePassRefreshTick();
    expect(existsSync(passFile())).toBe(false);
  });

  it("'no' tick ⇒ stored pass deleted; issuer not invoked", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    notEntitledLive();
    await service.runOfflinePassRefreshTick();
    expect(existsSync(passFile())).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("error tick ⇒ stored pass kept; issuer not invoked", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    errorLive();
    await service.runOfflinePassRefreshTick();
    expect(existsSync(passFile())).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("issuer error ⇒ stored pass kept", async () => {
    await store.storeOfflinePass(makePass(), nowSec() - 60);
    entitledLive();
    mockInvoke.mockResolvedValue({ data: null, error: new Error("FunctionsHttpError") });
    await service.runOfflinePassRefreshTick();
    expect(existsSync(passFile())).toBe(true);
  });

  it("offline tick ⇒ nothing invoked, nothing read", async () => {
    mockIsOnline.mockReturnValue(false);
    await service.runOfflinePassRefreshTick();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it("an entitled export triggers at most one refresh per 10 minutes", async () => {
    entitledLive();
    mockInvoke.mockResolvedValue({ data: { pass: makePass() }, error: null });
    await service.getExportDecision("tx-r1");
    await service.getExportDecision("tx-r2");
    // Wait for the background refresh to finish storing the pass: the
    // "stored" log line is written only after the file write has resolved.
    const log = require("../logService").default as { info: jest.Mock };
    const stored = () => log.info.mock.calls.some((c) => c[0] === "[Entitlement] Offline pass stored");
    for (let i = 0; i < 200 && !stored(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(stored()).toBe(true);
    expect(existsSync(passFile())).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("startOfflinePassRefresher is inert under jest (NODE_ENV=test)", () => {
    const spy = jest.spyOn(global, "setInterval");
    service.startOfflinePassRefresher();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
