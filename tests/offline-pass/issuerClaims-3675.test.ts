/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 — issuer claims and signing (supabase/functions/_shared/
 * offlinePassClaims.ts), checked against the desktop verifier.
 *
 * Lives under tests/ because CI does not run supabase/functions/** tests
 * (BACKLOG-2690) and electron/ cannot import supabase/ (rootDir).
 *
 * The Ed25519 key pair is generated in memory per run; nothing is written.
 * The deployed runtime (Deno) is confirmed after deploy: the desktop verifier
 * must accept a pass from the deployed function and reject it with one byte
 * flipped.
 */

import { generateKeyPairSync, sign as nodeSign } from "crypto";
import { readFileSync } from "fs";
import path from "path";

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../electron/services/logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});
jest.mock("../../electron/services/sessionService", () => ({ __esModule: true, default: {} }));

import {
  chooseMembership,
  computePassClaims,
  isUnlimitedEnabled,
  parsePaidThrough,
  signOfflinePass,
  OFFLINE_PASS_MAX_WINDOW_SEC as ISSUER_MAX,
  OFFLINE_PASS_TYP as ISSUER_TYP,
  OFFLINE_PASS_ENTITLEMENT as ISSUER_ENT,
  type MembershipRowLike,
} from "../../supabase/functions/_shared/offlinePassClaims";
import {
  verifyOfflinePass,
  OFFLINE_PASS_MAX_WINDOW_SEC as DESKTOP_MAX,
  OFFLINE_PASS_TYP as DESKTOP_TYP,
  OFFLINE_PASS_ENTITLEMENT as DESKTOP_ENT,
} from "../../electron/services/offlinePass/offlinePassVerifier";
import supabaseService from "../../electron/services/supabaseService";
import { UNLIMITED_TRANSACTIONS_FEATURE_KEY } from "../../electron/services/entitlementService";

const ROOT = path.join(__dirname, "../..");
const SUB = "user-a-3675";
const ORG = "org-a-3675";
const JTI = "jti-3675";
const IAT = 1_790_000_000;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PKCS8_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const SPKI_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

describe("BACKLOG-3675 issuer: claims", () => {
  it("issuer and desktop agree on the window, typ and entitlement key", () => {
    expect(ISSUER_MAX).toBe(DESKTOP_MAX);
    expect(ISSUER_TYP).toBe(DESKTOP_TYP);
    expect(ISSUER_ENT).toBe(DESKTOP_ENT);
    expect(ISSUER_ENT).toBe(UNLIMITED_TRANSACTIONS_FEATURE_KEY);
  });

  it("no paid_through ⇒ exp = iat + 48 h, pte null", () => {
    const c = computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: null, jti: JTI });
    expect(c).toEqual({ v: 1, sub: SUB, ent: "unlimited_transactions", org: ORG, iat: IAT, exp: IAT + 172800, pte: null, jti: JTI });
  });

  it("P4 pte = iat + 3600 ⇒ exp = iat + 3600 (min, not max)", () => {
    expect(computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT + 3600, jti: JTI })?.exp).toBe(IAT + 3600);
  });

  it("P4 pte beyond 48 h ⇒ exp = iat + 48 h", () => {
    expect(computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT + 10 * 86400, jti: JTI })?.exp).toBe(IAT + 172800);
  });

  it("P4 pte <= iat ⇒ no pass; pte = iat + 1 ⇒ exp = iat + 1", () => {
    expect(computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT, jti: JTI })).toBeNull();
    expect(computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT - 1, jti: JTI })).toBeNull();
    expect(computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT + 1, jti: JTI })?.exp).toBe(IAT + 1);
  });

  it.each([
    ["absent override", null, { ok: true, pte: null }],
    ["override without paid_through", { enabled: true }, { ok: true, pte: null }],
    ["ISO paid_through", { enabled: true, paid_through: "2026-11-02T17:00:00Z" }, { ok: true, pte: Date.parse("2026-11-02T17:00:00Z") / 1000 }],
    ["malformed paid_through", { enabled: true, paid_through: "next month" }, { ok: false }],
    ["numeric paid_through", { enabled: true, paid_through: 1790000000 }, { ok: false }],
    ["impossible date", { enabled: true, paid_through: "2026-13-45T99:00:00Z" }, { ok: false }],
  ])("parsePaidThrough: %s", (_n, override, expected) => {
    expect(parsePaidThrough(override)).toEqual(expected);
  });

  it.each([
    ["enabled true", { features: { unlimited_transactions: { enabled: true } } }, true],
    ["enabled false", { features: { unlimited_transactions: { enabled: false } } }, false],
    ['enabled "true"', { features: { unlimited_transactions: { enabled: "true" } } }, false],
    ["key missing", { features: { transaction_checklists: { enabled: true } } }, false],
    ["not_authorized refusal", { error: "not_authorized", features: [] }, false],
    ["null", null, false],
  ])("isUnlimitedEnabled: %s", (_n, data, expected) => {
    expect(isUnlimitedEnabled(data)).toBe(expected);
  });
});

describe("BACKLOG-3675 P18 issuer and desktop choose the same organization", () => {
  const BROKER_1 = "org-broker-1-3675";
  const BROKER_2 = "org-broker-2-3675";
  const PERSONAL = "org-personal-3675";
  // Row shape of `organization_members select organization_id, organizations(*)`,
  // already ordered by (created_at, id) by the query.
  const cases: Array<[string, MembershipRowLike[]]> = [
    ["personal first, brokerage second", [
      { organization_id: PERSONAL, organizations: { personal_owner_user_id: SUB } },
      { organization_id: BROKER_1, organizations: { personal_owner_user_id: null } },
    ]],
    ["two brokerages after personal", [
      { organization_id: PERSONAL, organizations: { personal_owner_user_id: SUB } },
      { organization_id: BROKER_2, organizations: { personal_owner_user_id: null } },
      { organization_id: BROKER_1, organizations: [{ personal_owner_user_id: null }] },
    ]],
    ["personal only", [{ organization_id: PERSONAL, organizations: [{ personal_owner_user_id: SUB }] }]],
    ["pre-migration rows (no personal_owner_user_id key)", [
      { organization_id: BROKER_2, organizations: {} },
      { organization_id: BROKER_1, organizations: null },
    ]],
  ];

  it.each(cases)("%s", async (_n, rows) => {
    const qb: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) qb[m] = jest.fn(() => qb);
    let orders = 0;
    qb.order = jest.fn(() => (++orders === 2 ? Promise.resolve({ data: rows, error: null }) : qb));
    const svc = supabaseService as unknown as { _ensureClient: () => unknown };
    const spy = jest.spyOn(svc, "_ensureClient").mockReturnValue({ from: () => qb });
    try {
      const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(SUB);
      expect(outcome.status).toBe("member");
      expect(chooseMembership(rows)).toBe((outcome as { organization_id: string }).organization_id);
    } finally {
      spy.mockRestore();
    }
  });

  it("no rows ⇒ no organization", () => {
    expect(chooseMembership([])).toBeNull();
  });
});

describe("BACKLOG-3675 issuer signing ⇄ desktop verifier", () => {
  const claims = computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: null, jti: JTI })!;

  it("WebCrypto signature is byte-equal to node's Ed25519 signature over the same input", async () => {
    const token = await signOfflinePass({ claims, kid: "k1", pkcs8Base64: PKCS8_B64 });
    const [h, p, s] = token.split(".");
    const expected = nodeSign(null, Buffer.from(`${h}.${p}`, "ascii"), privateKey).toString("base64url");
    expect(s).toBe(expected);
  });

  it("an issued pass verifies on the desktop with the matching public key", async () => {
    const token = await signOfflinePass({ claims, kid: "k1", pkcs8Base64: PKCS8_B64 });
    const v = verifyOfflinePass({ token, nowSec: IAT + 60, keys: { k1: SPKI_B64 }, userId: SUB, highWaterSec: 0 });
    expect(v).toEqual({ ok: true, kid: "k1", payload: claims });
  });

  it("the same pass with one byte flipped is rejected", async () => {
    const token = await signOfflinePass({ claims, kid: "k1", pkcs8Base64: PKCS8_B64 });
    const [h, p, s] = token.split(".");
    for (const which of ["signature", "payload"] as const) {
      const buf = Buffer.from(which === "signature" ? s : p, "base64url");
      buf[3] ^= 0x01;
      const flipped = which === "signature"
        ? `${h}.${p}.${buf.toString("base64url")}`
        : `${h}.${buf.toString("base64url")}.${s}`;
      const v = verifyOfflinePass({ token: flipped, nowSec: IAT + 60, keys: { k1: SPKI_B64 }, userId: SUB, highWaterSec: 0 });
      expect(v.ok).toBe(false);
    }
  });

  it("a pass issued with a paid-period end verifies and carries it", async () => {
    const c = computePassClaims({ sub: SUB, org: ORG, nowSec: IAT, pte: IAT + 3600, jti: JTI })!;
    const token = await signOfflinePass({ claims: c, kid: "k1", pkcs8Base64: PKCS8_B64 });
    const ok = verifyOfflinePass({ token, nowSec: IAT + 3599, keys: { k1: SPKI_B64 }, userId: SUB, highWaterSec: 0 });
    expect(ok.ok).toBe(true);
    const late = verifyOfflinePass({ token, nowSec: IAT + 3600, keys: { k1: SPKI_B64 }, userId: SUB, highWaterSec: 0 });
    expect(late).toEqual({ ok: false, reason: "expired" });
  });
});

describe("BACKLOG-3675 Edge Function source constraints", () => {
  const shared = readFileSync(path.join(ROOT, "supabase/functions/_shared/offlinePassClaims.ts"), "utf8");
  const fn = readFileSync(path.join(ROOT, "supabase/functions/issue-offline-pass/index.ts"), "utf8");

  it("the shared claims module has zero imports", () => {
    expect(shared).not.toMatch(/^\s*import\s/m);
    expect(shared).not.toMatch(/\brequire\(/);
    expect(shared).not.toMatch(/\bimport\(/);
  });

  it("the issuer pins supabase-js to an exact version and uses no service-role key", () => {
    const imports = [...fn.matchAll(/supabase-js@([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["2.110.2"]);
    expect(fn).not.toMatch(/SERVICE_ROLE/);
  });

  it("the issuer takes the user id from the token, not the body, and answers 401 without a user", () => {
    expect(fn).not.toMatch(/req\.json\(|request\.json\(/);
    expect(fn).toMatch(/auth\.getUser\(\)/);
    expect(fn).toMatch(/if \(!sub\) \{\s*return reply\(401/);
  });
});
