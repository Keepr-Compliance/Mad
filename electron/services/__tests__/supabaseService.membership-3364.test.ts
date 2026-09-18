/**
 * @jest-environment node
 */

/**
 * BACKLOG-3364 — the membership lookup contract.
 *
 * This suite drives the REAL `getActiveOrganizationMembershipOutcome` and the
 * REAL `getActiveOrganizationMembership` against the PostgREST emulator, which
 * answers from PR 1's captured responses. Nothing here mocks either method.
 *
 * What it holds (SR delta pm_comments 3e27deee ruling 7, the contract
 * BACKLOG-3349 consumes):
 *
 *   - `none` and `error` are different answers;
 *   - the method never throws, whatever happens;
 *   - a personal organization is never filtered out — it is returned with
 *     `is_personal: true` and the caller decides;
 *   - a brokerage row wins over a personal one, and the SQL order decides
 *     between two brokerage rows;
 *   - NO argument ever names `organizations.personal_owner_user_id`, so the
 *     query works on both sides of the migration;
 *   - the rows arrive ordered by two base columns of `organization_members`.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  personalMembership,
  PERSONAL_COLUMN,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_BROKERAGE_ORG_ID_2,
  FIXTURE_PERSONAL_ORG_ID,
  type Emulator,
  type EmbedShape,
} from "./helpers/postgrestEmulator";

let emulator: Emulator;

/** Survives `jest.resetModules()`; see the Sentry factory below. */
const mockCaptureException = jest.fn();

/**
 * What `client.from(table)` does, swappable per test.
 *
 * A mutable function rather than a second `jest.resetModules()` + re-import:
 * resetting the registry mid-test hands the service a FRESH `@sentry/electron`
 * mock, so the `Sentry.captureException` this file holds would record nothing
 * and the two reporting assertions below would pass vacuously in one direction
 * and fail in the other. One module instance, one Sentry mock.
 */
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

/**
 * Sentry, via a stable outer mock.
 *
 * `jest.resetModules()` in `beforeEach` gives the freshly imported service a
 * BRAND NEW copy of every module it requires, the Sentry mock included — so a
 * `jest.fn()` this file imported at load time would record nothing and the two
 * reporting assertions below would pass in neither direction. The factory
 * delegates to the `mockCaptureException` declared here, which survives the
 * reset. Same pattern, and same reason, as `supabaseService.test.ts` uses for
 * sessionService.
 */
jest.mock("@sentry/electron/main", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
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

type SupabaseServiceModule = typeof import("../supabaseService");

describe("BACKLOG-3364 — getActiveOrganizationMembershipOutcome", () => {
  let supabaseService: SupabaseServiceModule["default"];

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    emulator = createPostgrestEmulator();
    fromImpl = (table) => emulator.from(table);
    const mod = await import("../supabaseService");
    supabaseService = mod.default;
  });

  // -------------------------------------------------------------------------
  // none / error / member are three different answers
  // -------------------------------------------------------------------------

  it("answers `none` when the query succeeds and the user is in no organization", async () => {
    emulator.set({ rows: { organization_members: [] } });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({ status: "none" });
  });

  it("answers `error`, never `none`, when the query returns an error", async () => {
    // A query naming the column against a database that lacks it: the exact
    // 42703 response PR 1 captured, `data: null` and no throw.
    emulator.set({ columnPresent: false, rows: { organization_members: [] } });
    fromImpl = () => emulator.from("organization_members").select(PERSONAL_COLUMN);

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({ status: "error" });
  });

  it("answers `error` when the result is not a list of rows", async () => {
    fromImpl = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              // A single object where an array was expected: a shape this
              // code cannot read is not "no membership".
              order: () => Promise.resolve({ data: { organization_id: "x" }, error: null }),
            }),
          }),
        }),
      }),
    });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({ status: "error" });
  });

  it("answers `error` and reports it when the client throws, and never rethrows", async () => {
    const boom = new Error("network down");
    fromImpl = () => {
      throw boom;
    };

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({ status: "error" });
    // The Sentry tag string is part of the contract and must not drift (N3).
    expect(mockCaptureException).toHaveBeenCalledWith(boom, {
      tags: { service: "supabase-service", operation: "getActiveOrganizationMembership" },
    });
  });

  // -------------------------------------------------------------------------
  // A personal organization is returned, not filtered out
  // -------------------------------------------------------------------------

  describe.each<EmbedShape>(["object", "array"])("embed arriving as %s", (shape) => {
    it("returns the personal organization with is_personal true", async () => {
      emulator.set({
        rows: { organization_members: [personalMembership({ shape })] },
      });

      const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
        FIXTURE_USER_ID
      );

      expect(outcome).toEqual({
        status: "member",
        organization_id: FIXTURE_PERSONAL_ORG_ID,
        organization_name: "Personal",
        is_personal: true,
      });
    });

    it("returns a brokerage organization with is_personal false", async () => {
      emulator.set({
        rows: { organization_members: [brokerageMembership({ shape })] },
      });

      const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
        FIXTURE_USER_ID
      );

      expect(outcome).toEqual({
        status: "member",
        organization_id: FIXTURE_BROKERAGE_ORG_ID,
        organization_name: "Fixture Brokerage 3364",
        is_personal: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Which row wins
  // -------------------------------------------------------------------------

  it("prefers the brokerage row when the personal row comes back first", async () => {
    emulator.set({
      rows: {
        organization_members: [
          personalMembership({ createdAt: "2026-01-01T00:00:00.000Z" }),
          brokerageMembership({ createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      },
    });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toMatchObject({
      status: "member",
      organization_id: FIXTURE_BROKERAGE_ORG_ID,
      is_personal: false,
    });
  });

  it("keeps the SQL order between two brokerage rows", async () => {
    emulator.set({
      rows: {
        organization_members: [
          brokerageMembership({
            orgId: FIXTURE_BROKERAGE_ORG_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          brokerageMembership({
            orgId: FIXTURE_BROKERAGE_ORG_ID_2,
            createdAt: "2026-02-01T00:00:00.000Z",
          }),
        ],
      },
    });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toMatchObject({ organization_id: FIXTURE_BROKERAGE_ORG_ID });
  });

  it("ignores memberships whose licence is not active", async () => {
    emulator.set({
      rows: {
        organization_members: [
          brokerageMembership({ licenseStatus: "suspended" }),
        ],
      },
    });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({ status: "none" });
  });

  // -------------------------------------------------------------------------
  // The query itself — the part with no other guard
  // -------------------------------------------------------------------------

  it("resolves a brokerage member against a database WITHOUT the column", async () => {
    // The state every shipped build meets until migration 1 is applied. If any
    // argument named the column, the emulator would answer 42703 with
    // `data: null` and this would be `{ status: "error" }` — every real
    // brokerage member silently demoted.
    emulator.set({
      columnPresent: false,
      rows: {
        organization_members: [brokerageMembership({ phase: "pre" })],
      },
    });

    const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
      FIXTURE_USER_ID
    );

    expect(outcome).toEqual({
      status: "member",
      organization_id: FIXTURE_BROKERAGE_ORG_ID,
      organization_name: "Fixture Brokerage 3364",
      is_personal: false,
    });
  });

  it("names the personal column in no select, order or filter", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    await supabaseService.getActiveOrganizationMembershipOutcome(FIXTURE_USER_ID);

    expect(emulator.state.selects).toEqual([
      { table: "organization_members", columns: "organization_id, organizations(*)" },
    ]);
    for (const order of emulator.state.orders) {
      expect(order.column).not.toContain(PERSONAL_COLUMN);
    }
  });

  it("orders by two base columns of organization_members, ascending", async () => {
    // Deep-equal on the whole recorded call list. Deleting either `.order()`,
    // dropping the tie-break, swapping the direction, or moving the sort onto
    // the embed with `{ referencedTable: "organizations" }` each change this
    // value. Without this assertion none of those four red anything — measured
    // on the portal's three readers in PR 2 (SR bd8347f1 R3).
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    await supabaseService.getActiveOrganizationMembershipOutcome(FIXTURE_USER_ID);

    expect(emulator.state.orders).toEqual([
      { table: "organization_members", column: "created_at", options: { ascending: true } },
      { table: "organization_members", column: "id", options: { ascending: true } },
    ]);
  });
});

describe("BACKLOG-3364 — getActiveOrganizationMembership delegates to the outcome", () => {
  let supabaseService: SupabaseServiceModule["default"];

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    emulator = createPostgrestEmulator();
    fromImpl = (table) => emulator.from(table);
    const mod = await import("../supabaseService");
    supabaseService = mod.default;
  });

  it("returns the membership, carrying is_personal, for a member", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toEqual({
      organization_id: FIXTURE_PERSONAL_ORG_ID,
      organization_name: "Personal",
      is_personal: true,
    });
  });

  it("returns null for `none`", async () => {
    emulator.set({ rows: { organization_members: [] } });

    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toBeNull();
  });

  it("returns null for `error`, and captures it exactly once", async () => {
    fromImpl = () => {
      throw new Error("network down");
    };

    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toBeNull();
    // One capture, from the outcome method. The getter adds none of its own.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
