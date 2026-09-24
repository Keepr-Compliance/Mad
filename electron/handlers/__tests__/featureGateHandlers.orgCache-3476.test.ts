/**
 * @jest-environment node
 */

/**
 * BACKLOG-3476 — the strict reader reuses its membership answer.
 *
 * Before this, every strict read (every transaction open, for the Checklist
 * tab) ran the `organization_members` query before the plan cache could even
 * be consulted, so the tab appeared a network round trip after the others.
 *
 * Same harness as the BACKLOG-3349 suite: the REAL `featureGateService`, the
 * REAL membership helper, the PostgREST emulator standing in for the client.
 * What is counted here is `from("organization_members")` — one per network
 * round trip the membership lookup makes.
 *
 * The wrong implementations these controls are written against:
 *   - no cache at all (every read pays the query);
 *   - a cache keyed on nothing, or on the org, that a different user reads;
 *   - a cache that stores `error`, so one failed request pins "unknown" — or,
 *     worse, stores it as `none` and pins "blocked";
 *   - a cache that `invalidateCache()` / `clearCache()` / logout do not reach;
 *   - a cache with no expiry, which outlives the plan cache it sits beside.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_BROKERAGE_ORG_ID_2,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";
import type { StrictFeatureState } from "../../types/featureGate";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let emulator: Emulator;
let rpcAnswer: (orgId: string) => { data: unknown; error: unknown };
let rpcCalls: { fn: string; orgId: unknown }[] = [];
/** Every `from(table)` call — the membership lookup's network round trips. */
let fromCalls: string[] = [];
let fromThrows = false;

const mockSupabaseClient = {
  from: (table: string) => {
    fromCalls.push(table);
    if (fromThrows) {
      throw new Error("network down");
    }
    return emulator.from(table);
  },
  rpc: jest.fn(async (fn: string, args?: { p_org_id?: string }) => {
    rpcCalls.push({ fn, orgId: args?.p_org_id });
    return rpcAnswer(args?.p_org_id ?? "");
  }),
  auth: {
    getSession: jest.fn(),
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

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-3476") },
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      readFile: jest.fn(() =>
        Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
      ),
      writeFile: jest.fn(() => Promise.resolve()),
      unlink: jest.fn(() => Promise.resolve()),
    },
  };
});

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

const KEY = "transaction_checklists";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000347601"; // pii-allow-uuid: invented fixture id

function planAnswer(entries: Record<string, boolean>) {
  const features: Record<string, unknown> = {};
  for (const [key, enabled] of Object.entries(entries)) {
    features[key] = { enabled, value: String(enabled), source: "plan" };
  }
  return { data: { org_id: "fixture", features }, error: null };
}

let handlers: typeof import("../featureGateHandlers");
let featureGateService: typeof import("../../services/featureGateService").default;

async function invokeStrictState(): Promise<StrictFeatureState> {
  const handler = ipcHandlers.get("feature-gate:strict-state");
  if (!handler) throw new Error("feature-gate:strict-state was never registered");
  return (await handler({}, KEY)) as StrictFeatureState;
}

function signedInAs(userId: string | null): void {
  mockSupabaseClient.auth.getSession.mockResolvedValue({
    data: {
      session: userId ? { user: { id: userId, email: "fixture@example.test" } } : null,
    },
    error: null,
  });
}

function membershipQueries(): number {
  return fromCalls.filter((t) => t === "organization_members").length;
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
  ipcHandlers.clear();
  rpcCalls = [];
  fromCalls = [];
  fromThrows = false;
  emulator = createPostgrestEmulator();
  emulator.set({ rows: { organization_members: [brokerageMembership()] } });
  rpcAnswer = () => planAnswer({ [KEY]: true });
  signedInAs(FIXTURE_USER_ID);

  handlers = await import("../featureGateHandlers");
  featureGateService = (await import("../../services/featureGateService")).default;
  handlers.registerFeatureGateHandlers();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// K1 — the second read is answered from memory
// ---------------------------------------------------------------------------

describe("K1 — repeat strict reads do not repeat the membership query", () => {
  it("K1: three reads by the same user run the membership query once and the plan RPC once", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");
    await expect(invokeStrictState()).resolves.toBe("allowed");
    await expect(invokeStrictState()).resolves.toBe("allowed");

    expect(membershipQueries()).toBe(1);
    expect(rpcCalls).toHaveLength(1);
  });

  it("K1b: a cached `none` still answers blocked, without a second query", async () => {
    emulator.set({ rows: { organization_members: [] } });

    await expect(invokeStrictState()).resolves.toBe("blocked");
    await expect(invokeStrictState()).resolves.toBe("blocked");

    expect(membershipQueries()).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// K2 — the cache belongs to one user
// ---------------------------------------------------------------------------

describe("K2 — another user never reads the cached answer", () => {
  it("K2: a different signed-in user is looked up afresh and gets their own org's plan", async () => {
    emulator.set({
      rows: {
        organization_members: [
          brokerageMembership(),
          brokerageMembership({ userId: OTHER_USER_ID, orgId: FIXTURE_BROKERAGE_ORG_ID_2 }),
        ],
      },
    });
    rpcAnswer = (orgId) =>
      planAnswer({ [KEY]: orgId === FIXTURE_BROKERAGE_ORG_ID });

    await expect(invokeStrictState()).resolves.toBe("allowed");

    signedInAs(OTHER_USER_ID);
    await expect(invokeStrictState()).resolves.toBe("blocked");

    expect(membershipQueries()).toBe(2);
    expect(rpcCalls.map((c) => c.orgId)).toEqual([
      FIXTURE_BROKERAGE_ORG_ID,
      FIXTURE_BROKERAGE_ORG_ID_2,
    ]);
  });

  it("K2b: signed out after a cached answer -> unknown, and nothing is queried", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");

    signedInAs(null);
    await expect(invokeStrictState()).resolves.toBe("unknown");
    expect(membershipQueries()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// K3 — a failed lookup is never remembered
// ---------------------------------------------------------------------------

describe("K3 — a failed membership lookup is not cached", () => {
  it("K3: an error, then a real answer -> unknown, then allowed, and the second read queries again", async () => {
    fromThrows = true;
    await expect(invokeStrictState()).resolves.toBe("unknown");

    fromThrows = false;
    await expect(invokeStrictState()).resolves.toBe("allowed");
    expect(membershipQueries()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// K4 — the existing invalidation points reach it
// ---------------------------------------------------------------------------

describe("K4 — invalidateCache / clearCache drop the cached membership", () => {
  it("K4: invalidateCache() -> the next read sees a membership that changed", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");

    emulator.set({ rows: { organization_members: [] } });
    featureGateService.invalidateCache();
    await expect(invokeStrictState()).resolves.toBe("blocked");
    expect(membershipQueries()).toBe(2);
  });

  it("K4b: clearCache() -> the next read sees a membership that changed", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");

    emulator.set({ rows: { organization_members: [] } });
    await featureGateService.clearCache();
    await expect(invokeStrictState()).resolves.toBe("blocked");
    expect(membershipQueries()).toBe(2);
  });

  it("K4c: the renderer's invalidate channel drops it too", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");

    emulator.set({ rows: { organization_members: [] } });
    const invalidate = ipcHandlers.get("feature-gate:invalidate-cache");
    if (!invalidate) throw new Error("feature-gate:invalidate-cache was never registered");
    await invalidate({});
    await expect(invokeStrictState()).resolves.toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// K5 — it does not outlive the plan cache
// ---------------------------------------------------------------------------

describe("K5 — the cached membership expires with the plan cache's TTL", () => {
  it("K5: five minutes later the membership is looked up again", async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(start);

    await expect(invokeStrictState()).resolves.toBe("allowed");

    emulator.set({ rows: { organization_members: [] } });
    now.mockReturnValue(start + 5 * 60 * 1000 - 1);
    await expect(invokeStrictState()).resolves.toBe("allowed");
    expect(membershipQueries()).toBe(1);

    now.mockReturnValue(start + 5 * 60 * 1000);
    await expect(invokeStrictState()).resolves.toBe("blocked");
    expect(membershipQueries()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// K6 — the non-strict readers are unchanged
// ---------------------------------------------------------------------------

describe("K6 — resolveOrgId keeps looking the membership up every time", () => {
  it("K6: resolveOrgId does not read the strict reader's cache", async () => {
    await expect(invokeStrictState()).resolves.toBe("allowed");
    emulator.set({ rows: { organization_members: [] } });

    await expect(handlers.resolveOrgId()).resolves.toBeNull();
    expect(membershipQueries()).toBe(2);
  });
});
