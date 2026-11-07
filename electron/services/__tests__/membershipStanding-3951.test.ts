/**
 * BACKLOG-3951 — the membership standing read and its classifier.
 *
 * C6  classifier sweep: every status, the R2 two-row cases, someone else's
 *     personal row, only personal, none, error, non-array, billing-only.
 * C9  parity: the status lists copied into membershipStanding.ts equal the
 *     ones in packages/shared/src/billing/planRule.ts (read as text; electron
 *     cannot import packages/shared).
 * R1  the read is bounded: a query that never answers is `error` after the
 *     timeout.
 * The read runs through the REAL supabaseService over the 3364 PostgREST
 * emulator, so the select string and the user filter are the ones shipped.
 *
 * Fixture rows: helpers/membership3951Fixtures.ts (transcribed, R3).
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  createPostgrestEmulator,
  personalMembership,
  FIXTURE_USER_ID,
  type Emulator,
  type Row,
} from "./helpers/postgrestEmulator";
import { UNASSIGNED_MEMBER_ROW, BILLING_ONLY_ROW } from "./helpers/membership3951Fixtures";

let emulator: Emulator;
let fromImpl: (table: string) => unknown = (table) => emulator.from(table);

const mockSupabaseClient = {
  from: (table: string) => fromImpl(table),
  rpc: (fn: string, args?: unknown) => emulator.rpc(fn, args),
  auth: {
    getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: jest.fn(() => ({
      data: { subscription: { unsubscribe: jest.fn() } },
    })),
  },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  addBreadcrumb: jest.fn(),
  withScope: jest.fn((cb: (scope: unknown) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() })
  ),
}));

jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: jest.fn().mockResolvedValue(true) },
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

const OTHER_ORG = "00000000-0000-4000-8000-0000003951b0"; // pii-allow-uuid: invented fixture id

function at(status: string | null, over: Partial<Row> = {}): Row {
  return { ...UNASSIGNED_MEMBER_ROW, license_status: status, ...over };
}

/** A second brokerage, created later than the transcribed row. */
function laterBrokerage(status: string): Row {
  const org = UNASSIGNED_MEMBER_ROW.organizations as Record<string, unknown>;
  return at(status, {
    id: `${OTHER_ORG}-m`,
    organization_id: OTHER_ORG,
    created_at: "2026-11-01T00:00:00.000+00:00",
    organizations: { ...org, id: OTHER_ORG, name: "Second Fixture Brokerage" },
  });
}

type Mod = typeof import("../membershipStanding");
let mod: Mod;

beforeEach(async () => {
  jest.resetModules();
  emulator = createPostgrestEmulator();
  fromImpl = (table) => emulator.from(table);
  mod = await import("../membershipStanding");
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3951 C6: classifyMembershipStanding", () => {
  const U = FIXTURE_USER_ID;

  it.each<[string, unknown, string]>([
    ["active brokerage row", [at("active")], "licensed"],
    ["unassigned (transcribed keepr-test row)", [UNASSIGNED_MEMBER_ROW], "unlicensed"],
    ["billing-only login (unassigned, billing_only)", [BILLING_ONLY_ROW], "unlicensed"],
    ["suspended", [at("suspended")], "left_brokerage"],
    ["expired", [at("expired")], "left_brokerage"],
    ["suspended + own personal row", [at("suspended"), personalMembership()], "left_brokerage"],
    ["pending", [at("pending")], "unknown"],
    ["null status", [at(null)], "unknown"],
    ["a status this build has never seen", [at("on_hold")], "unknown"],
    // R2: any active brokerage row wins over an older non-granting one.
    ["older unassigned at A + active at B", [UNASSIGNED_MEMBER_ROW, laterBrokerage("active")], "licensed"],
    ["older suspended at A + active at B", [at("suspended"), laterBrokerage("active")], "licensed"],
    // BACKLOG-4155: else ANY unassigned brokerage row → unlicensed, in either order.
    ["older unassigned at A + suspended at B", [UNASSIGNED_MEMBER_ROW, laterBrokerage("suspended")], "unlicensed"],
    ["4155 C1 active at B listed first + unassigned at A", [laterBrokerage("active"), UNASSIGNED_MEMBER_ROW], "licensed"],
    ["4155 C3a suspended at A + unassigned at B + own personal", [at("suspended"), laterBrokerage("unassigned"), personalMembership()], "unlicensed"],
    ["4155 C3a reversed order", [laterBrokerage("unassigned"), at("suspended"), personalMembership()], "unlicensed"],
    ["4155 C3b suspended at A + unassigned at B", [at("suspended"), laterBrokerage("unassigned")], "unlicensed"],
    ["4155 C3b reversed order", [laterBrokerage("unassigned"), at("suspended")], "unlicensed"],
    ["4155 C5 (defensive) pending at A + unassigned at B", [at("pending"), laterBrokerage("unassigned")], "unlicensed"],
    ["4155 C5 (defensive) reversed order", [laterBrokerage("unassigned"), at("pending")], "unlicensed"],
    ["4155 C6 suspended at A + active at B, reversed order", [laterBrokerage("active"), at("suspended")], "licensed"],
    ["4155 C7 pending at A + active at B", [at("pending"), laterBrokerage("active")], "licensed"],
    ["4155 C7 reversed order", [laterBrokerage("active"), at("pending")], "licensed"],
    // The FIRST brokerage row still decides among rows that neither grant nor are unassigned.
    ["4155 tier 3: pending at A first + suspended at B", [at("pending"), laterBrokerage("suspended")], "unknown"],
    ["4155 tier 3: suspended at B first + pending at A", [laterBrokerage("suspended"), at("pending")], "left_brokerage"],
    ["only own personal row", [personalMembership()], "none"],
    // R3: a row for somebody else's personal organization is not a brokerage.
    [
      "member of someone else's personal organization",
      [personalMembership({ userId: U }), { ...personalMembership(), organizations: { name: "x", personal_owner_user_id: "someone-else" } }],
      "none",
    ],
    ["no rows", [], "none"],
    ["not an array (error result)", null, "error"],
    ["an object where a list was expected", { organization_id: "x" }, "error"],
  ])("%s", (_label, rows, expected) => {
    expect(mod.classifyMembershipStanding(rows, U).standing).toBe(expected);
  });

  it("another user's unassigned row does not decide for this user", () => {
    const rows = [{ ...UNASSIGNED_MEMBER_ROW, user_id: "another-user" }, personalMembership()];
    expect(mod.classifyMembershipStanding(rows, U).standing).toBe("none");
  });

  it("left_brokerage carries the brokerage name, with a fallback when it has none", () => {
    expect(mod.classifyMembershipStanding([at("suspended")], U)).toEqual({
      standing: "left_brokerage",
      organizationName: "Fixture Brokerage",
    });
    const org = UNASSIGNED_MEMBER_ROW.organizations as Record<string, unknown>;
    expect(
      mod.classifyMembershipStanding([at("expired", { organizations: { ...org, name: null } })], U),
    ).toEqual({ standing: "left_brokerage", organizationName: "your brokerage" });
  });

  it("reads the embed in the array shape too", () => {
    const org = UNASSIGNED_MEMBER_ROW.organizations as Record<string, unknown>;
    expect(
      mod.classifyMembershipStanding([at("unassigned", { organizations: [org] })], U).standing,
    ).toBe("unlicensed");
  });
});

describe("BACKLOG-3951 C9: status lists match the portal's planRule", () => {
  const src = readFileSync(
    join(__dirname, "../../../packages/shared/src/billing/planRule.ts"),
    "utf8",
  );
  function list(name: string): string[] {
    const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    if (!m) throw new Error(`${name} not found in planRule.ts`);
    return m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean);
  }

  it("deactivated, unassigned and granting statuses are the same lists", () => {
    expect([...mod.MEMBER_DEACTIVATED_STATUSES]).toEqual(list("MEMBER_DEACTIVATED_STATUSES"));
    expect([...mod.MEMBER_GRANTING_STATUSES]).toEqual(list("PORTAL_GRANTING_LICENSE_STATUSES"));
    const unassigned = src.match(/export const MEMBER_UNASSIGNED_STATUS = '([^']+)'/);
    expect(unassigned?.[1]).toBe(mod.MEMBER_UNASSIGNED_STATUS);
  });
});

describe("BACKLOG-3951: readMembershipStanding over the real supabaseService", () => {
  it("unassigned keepr-test row → unlicensed; the query reads every status, never the personal column", async () => {
    emulator.set({ rows: { organization_members: [UNASSIGNED_MEMBER_ROW] } });
    await expect(mod.readMembershipStanding(FIXTURE_USER_ID)).resolves.toEqual({
      standing: "unlicensed",
    });
    const selects = emulator.state.selects.filter((s) => s.table === "organization_members");
    expect(selects).toHaveLength(1);
    expect(selects[0].columns).not.toContain("personal_owner_user_id");
    expect(emulator.state.orders.map((o) => o.column)).toEqual(["created_at", "id"]);
  });

  it("only this user's rows are read (user filter applied)", async () => {
    emulator.set({
      rows: {
        organization_members: [{ ...UNASSIGNED_MEMBER_ROW, user_id: "another-user" }, personalMembership()],
      },
    });
    await expect(mod.readMembershipStanding(FIXTURE_USER_ID)).resolves.toEqual({ standing: "none" });
  });

  it("a query that answers an error → error (never none)", async () => {
    fromImpl = () => ({
      select: () => ({
        eq: () => ({
          order: () => ({ order: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      }),
    });
    await expect(mod.readMembershipStanding(FIXTURE_USER_ID)).resolves.toEqual({ standing: "error" });
  });

  it("R1: a query that never answers → error after the bound", async () => {
    jest.useFakeTimers();
    fromImpl = () => ({
      select: () => ({
        eq: () => ({ order: () => ({ order: () => new Promise(() => undefined) }) }),
      }),
    });
    let settled: unknown = "pending";
    void mod.readMembershipStanding(FIXTURE_USER_ID).then((r) => {
      settled = r;
    });
    await jest.advanceTimersByTimeAsync(mod.MEMBERSHIP_STANDING_READ_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ standing: "error" });
  });
});
