/**
 * @jest-environment node
 */

/**
 * BACKLOG-3364 — the personal organization MUST still reach the feature gate.
 *
 * This is the other half of `licenseHandlers.personalOrg-3364.test.ts`, and the
 * two want opposite things from the same row. The licence reader must ignore a
 * personal organization; `resolveOrgId` must USE it, because the personal
 * organization is the only place a solo user's plan is recorded.
 *
 * **This suite deliberately does not mock `supabaseService`.** It drives the
 * REAL `getActiveOrganizationMembership` against the PostgREST emulator. That
 * is the whole point: the most likely wrong implementation of this item is a
 * single `is_personal` filter placed INSIDE the shared getter (plan 0b9fef3c,
 * W2). With that filter, `license:get` looks perfectly correct — its own suite
 * stays green — while `resolveOrgId` returns null for every solo user, no solo
 * user's plan is ever read, and BACKLOG-3349 and BACKLOG-3365 stay blocked
 * forever with nothing red anywhere. A suite that mocked the getter could not
 * see it.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  personalMembership,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";

let emulator: Emulator;

const mockSupabaseClient = {
  from: (table: string) => emulator.from(table),
  rpc: (fn: string, args?: unknown) => emulator.rpc(fn, args),
  auth: {
    getSession: jest.fn().mockResolvedValue({
      data: { session: { user: { id: FIXTURE_USER_ID, email: "fixture@example.test" } } },
      error: null,
    }),
    onAuthStateChange: jest.fn(() => ({
      data: { subscription: { unsubscribe: jest.fn() } },
    })),
  },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { updateSession: jest.fn().mockResolvedValue(true) },
}));

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-3364") },
  ipcMain: { handle: jest.fn() },
}));

jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: {
    checkFeature: jest.fn(),
    getAllFeatures: jest.fn(),
    invalidateCache: jest.fn(),
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

describe("BACKLOG-3364 — resolveOrgId keeps the personal organization", () => {
  let resolveOrgId: () => Promise<string | null>;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    emulator = createPostgrestEmulator();
    mockSupabaseClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: FIXTURE_USER_ID, email: "fixture@example.test" } } },
      error: null,
    });
    const mod = await import("../featureGateHandlers");
    resolveOrgId = mod.resolveOrgId;
  });

  it("resolves a solo user's PERSONAL organization — this is where their plan lives", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(resolveOrgId()).resolves.toBe(FIXTURE_PERSONAL_ORG_ID);
  });

  it("resolves the brokerage when the user has both, personal row first", async () => {
    emulator.set({
      rows: {
        organization_members: [
          personalMembership({ createdAt: "2026-01-01T00:00:00.000Z" }),
          brokerageMembership({ createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      },
    });

    await expect(resolveOrgId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("resolves a brokerage member's organization", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    await expect(resolveOrgId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("resolves null when the user is in no organization at all", async () => {
    emulator.set({ rows: { organization_members: [] } });

    await expect(resolveOrgId()).resolves.toBeNull();
  });

  it("resolves null, not a wrong organization, when there is no session", async () => {
    mockSupabaseClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(resolveOrgId()).resolves.toBeNull();
  });

  it("resolves a brokerage member against a database WITHOUT the column", async () => {
    // The state a shipped build meets until migration 1 is applied. A query
    // naming the column would get 42703 / `data: null` here, and this brokerage
    // member would lose every plan feature they have.
    emulator.set({
      columnPresent: false,
      rows: { organization_members: [brokerageMembership({ phase: "pre" })] },
    });

    await expect(resolveOrgId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });
});
