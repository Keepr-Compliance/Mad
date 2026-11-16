/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245: the strict reader answers for `beta_updates`, through the REAL
 * featureGateService and membership helper (harness copied from
 * featureGateHandlers.contactInference-3349). The eligibility module calls
 * `resolveStrictFeatureState("beta_updates")` and grants only on "allowed".
 *
 * S1 allowed only on a positive read; disabled -> blocked; key missing (no
 *    definition row yet) -> blocked; no membership -> blocked
 * S2 unknown (never allowed): signed out, RPC fails with no cache,
 *    not_authorized (empty map), the query throws
 * E14 KNOWN RESIDUAL, pinned: RPC failing, membership answering, and a
 *    persisted plan file that still says allowed -> "allowed". A later
 *    source-aware read for this key must change this test on purpose.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let emulator: Emulator;

/** The persisted feature-cache.json contents, or null for no file. */
let mockPersisted: string | null = null;

/** What `get_org_features` answers, per organization id. Set per test. */
let rpcAnswer: (orgId: string) => { data: unknown; error: unknown };

/** Every `get_org_features` call, so "which org's plan was read" is measurable. */
let rpcCalls: { fn: string; orgId: unknown }[] = [];

/** Set true by a test that wants the query itself to throw. */
let fromThrows = false;

/**
 * Set by a test that wants the query to come back as an ERROR RESULT — the
 * shape PostgREST actually returns, with `data: null` and no throw at all.
 */
let queryError: { code: string; message: string; details: null; hint: null } | null = null;

/** The smallest chain that answers an error result to any call sequence. */
function erroringChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "not", "filter", "or", "order", "limit", "single", "maybeSingle"]) {
    chain[method] = () => chain;
  }
  chain.then = (onFulfilled: (r: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: queryError, status: 400 }).then(onFulfilled, onRejected);
  return chain;
}

const mockSupabaseClient = {
  from: (table: string) => {
    if (fromThrows) {
      throw new Error("network down");
    }
    if (queryError) {
      return erroringChain() as ReturnType<Emulator["from"]>;
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

/** Registered IPC handlers, so the channel can be invoked as the renderer does. */
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-4245") },
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

/**
 * `fs.promises` only. `readFileSync` stays REAL because the emulator reads the
 * committed PostgREST fixtures with it at module load — mocking the whole
 * module would leave this suite testing against fixtures that failed to load.
 */
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      readFile: jest.fn(() =>
        mockPersisted === null
          ? Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
          : Promise.resolve(mockPersisted)
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

/** A successful `get_org_features` payload carrying exactly these keys. */
function planAnswer(entries: Record<string, boolean>) {
  const features: Record<string, unknown> = {};
  for (const [key, enabled] of Object.entries(entries)) {
    features[key] = { enabled, value: String(enabled), source: "plan" };
  }
  return { data: { org_id: "fixture", features }, error: null };
}

/**
 * What `get_org_features` returns to a caller it will not answer for.
 * `features` is an EMPTY ARRAY, not an object — transcribed from the RPC's own
 * shape, and the reason an empty feature map is never read as "your plan grants
 * nothing" (the service stores it as `{}`).
 */
const NOT_AUTHORIZED = { data: { error: "not_authorized", features: [] }, error: null };

/** The RPC could not be answered at all. */
const RPC_FAILED = {
  data: null,
  error: { message: "network error", code: "PGRST000", details: null, hint: null },
};

type Handlers = typeof import("../featureGateHandlers");

let handlers: Handlers;


function signedIn(): void {
  mockSupabaseClient.auth.getSession.mockResolvedValue({
    data: { session: { user: { id: FIXTURE_USER_ID, email: "fixture@example.test" } } },
    error: null,
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.resetModules();
  ipcHandlers.clear();
  rpcCalls = [];
  fromThrows = false;
  queryError = null;
  emulator = createPostgrestEmulator();
  rpcAnswer = () => planAnswer({});
  signedIn();

  handlers = await import("../featureGateHandlers");
  handlers.registerFeatureGateHandlers();
  mockPersisted = null;
});


const KEY = "beta_updates" as const;

describe("S1 positive reads only", () => {
  beforeEach(() => emulator.set({ rows: { organization_members: [brokerageMembership()] } }));

  it("enabled -> allowed", async () => {
    rpcAnswer = () => planAnswer({ [KEY]: true, ai_detection: false });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("allowed");
  });
  it("disabled -> blocked", async () => {
    rpcAnswer = () => planAnswer({ [KEY]: false, ai_detection: false });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("blocked");
  });
  it("key missing from a real answer (no definition row) -> blocked", async () => {
    rpcAnswer = () => planAnswer({ ai_detection: true });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("blocked");
  });
  it("no membership -> blocked", async () => {
    emulator.set({ rows: { organization_members: [] } });
    rpcAnswer = () => planAnswer({ [KEY]: true });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("blocked");
  });
});

describe("S2 unknown, never allowed", () => {
  beforeEach(() => emulator.set({ rows: { organization_members: [brokerageMembership()] } }));

  it("signed out", async () => {
    mockSupabaseClient.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("unknown");
  });
  it("RPC fails and there is no persisted file", async () => {
    rpcAnswer = () => RPC_FAILED;
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("unknown");
  });
  it("not_authorized (empty map)", async () => {
    rpcAnswer = () => NOT_AUTHORIZED;
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("unknown");
  });
  it("the membership query throws", async () => {
    fromThrows = true;
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("unknown");
  });
});

describe("E14 known residual: a persisted plan file is served when the RPC fails", () => {
  it("RPC failing + membership answering + persisted file allowed -> allowed (pinned)", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => RPC_FAILED;
    mockPersisted = JSON.stringify({
      features: { [KEY]: { allowed: true, value: "true", source: "override" } },
      fetchedAt: Date.now() - 24 * 60 * 60 * 1000,
      orgId: FIXTURE_BROKERAGE_ORG_ID,
    });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("allowed");
  });

  it("the same file is ignored once it is older than 7 days -> unknown", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => RPC_FAILED;
    mockPersisted = JSON.stringify({
      features: { [KEY]: { allowed: true, value: "true", source: "override" } },
      fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      orgId: FIXTURE_BROKERAGE_ORG_ID,
    });
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("unknown");
  });
});
