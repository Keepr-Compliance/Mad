/**
 * @jest-environment node
 */

/**
 * BACKLOG-3349 — the strict (fail-closed) plan gate.
 *
 * ---------------------------------------------------------------------------
 * What this suite is for, and what it deliberately does NOT mock
 * ---------------------------------------------------------------------------
 * It drives the REAL `featureGateService` and the REAL membership helper, and
 * mocks only the Supabase client chain (through the emulator BACKLOG-3364
 * committed) and the filesystem. That is not thoroughness for its own sake —
 * two of the wrong implementations this gate has to survive are invisible to a
 * suite that mocks either one:
 *
 *   - Routing the strict read through `featureGateService.checkFeature`. That
 *     method answers ALLOWED for a key that is not in the cache and for no
 *     cache at all, which is correct for an export and catastrophic here: every
 *     organization would read allowed until the feature row is applied. With
 *     the service mocked, the two candidates are indistinguishable.
 *   - Filtering personal organizations out inside the shared membership helper
 *     (BACKLOG-3364 plan W2). The licence reader looks perfectly correct under
 *     that mistake; only a plan read notices, and only against a real helper.
 *
 * The emulator answers PostgREST 400 / 42703 whenever any part of a query names
 * `personal_owner_user_id` and the fixture is pre-migration, from responses
 * captured on a real stack (`supabase/tests/backlog-3364/fixtures/`). That is
 * what makes G3 a control rather than a restatement of the code.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  personalMembership,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  PERSONAL_COLUMN,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";
import type { StrictFeatureState } from "../../types/featureGate";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let emulator: Emulator;

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
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-3349") },
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
let supabaseService: typeof import("../../services/supabaseService").default;
let featureGateService: typeof import("../../services/featureGateService").default;
let KEY: string;

/** Invoke the strict-state channel exactly as the preload bridge does. */
async function invokeStrictState(featureKey: unknown): Promise<StrictFeatureState> {
  const handler = ipcHandlers.get("feature-gate:strict-state");
  if (!handler) throw new Error("feature-gate:strict-state was never registered");
  return (await handler({}, featureKey)) as StrictFeatureState;
}

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
  supabaseService = (await import("../../services/supabaseService")).default;
  featureGateService = (await import("../../services/featureGateService")).default;
  handlers.registerFeatureGateHandlers();
  KEY = handlers.CONTACT_INFERENCE_FEATURE_KEYS.outlook;
});

// ---------------------------------------------------------------------------
// C1-C3 — the gate answers the plan
// ---------------------------------------------------------------------------

describe("C1-C3 — a positive read, and only a positive read, allows", () => {
  it("C1: the key is enabled on the plan -> allowed", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => planAnswer({ [KEY]: true, ai_detection: false });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("allowed");
    await expect(handlers.isContactInferenceAllowed("outlook")).resolves.toBe(true);
  });

  it("C2: the key is present and disabled -> blocked", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => planAnswer({ [KEY]: false, ai_detection: false });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("blocked");
    await expect(handlers.isContactInferenceAllowed("outlook")).resolves.toBe(false);
  });

  it("C3: flipping the plan value changes the answer once the cache is invalidated", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    rpcAnswer = () => planAnswer({ [KEY]: true });
    await expect(handlers.resolveStrictFeatureState(KEY as never)).resolves.toBe("allowed");

    rpcAnswer = () => planAnswer({ [KEY]: false });
    featureGateService.invalidateCache();
    await expect(handlers.resolveStrictFeatureState(KEY as never)).resolves.toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// C4-C7, G6 — everything that is not a positive read
// ---------------------------------------------------------------------------

describe("C4-C7, G6 — no answer is never an allowance, and never a plan claim", () => {
  it("C4: the lookup succeeded and found no active membership -> blocked", async () => {
    emulator.set({ rows: { organization_members: [] } });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("blocked");
    expect(rpcCalls).toHaveLength(0);
  });

  it("C5: the plan answered and does not carry the key -> blocked", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => planAnswer({ ai_detection: false, text_export: true });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("blocked");
  });

  it("C6: the plan RPC failed and there is no persisted cache -> unknown", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => RPC_FAILED;

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");
    await expect(handlers.isContactInferenceAllowed("outlook")).resolves.toBe(false);
  });

  it("C7: a not_authorized response is unknown, NOT blocked", async () => {
    // An empty feature map says nothing about the plan. Calling it "blocked"
    // would put "not in your plan" on screen for a read that never saw a plan.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => NOT_AUTHORIZED;

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");
  });

  it("G6: a FAILED membership lookup is unknown, while zero rows is blocked", async () => {
    // The two arrive as the same `null` through the old getter. Collapsing them
    // here would tell every brokerage member, during one failed request, that
    // the feature is not in their plan.
    emulator.set({ columnPresent: true, rows: {} });
    fromThrows = true;
    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");

    fromThrows = false;
    emulator.set({ rows: { organization_members: [] } });
    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("blocked");
  });

  it("G6b: no signed-in session -> unknown, and the plan is never read", async () => {
    mockSupabaseClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");
    expect(rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G1, G2 — which organization's plan is read
// ---------------------------------------------------------------------------

describe("G1, G2 — the organization whose plan applies", () => {
  it("G1: a brokerage row beats a personal row, and the brokerage plan decides", async () => {
    // The two plans are given OPPOSITE values, so picking the wrong row changes
    // the STATE and not merely a spy. A control that only asserted the spy
    // would pass against an implementation that read the right org and then
    // ignored the answer.
    emulator.set({
      rows: {
        organization_members: [
          personalMembership({ createdAt: "2026-01-01T00:00:00.000Z" }),
          brokerageMembership({ createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      },
    });
    rpcAnswer = (orgId) =>
      planAnswer({ [KEY]: orgId === FIXTURE_PERSONAL_ORG_ID });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("blocked");
    expect(rpcCalls).toEqual([
      { fn: "get_org_features", orgId: FIXTURE_BROKERAGE_ORG_ID },
    ]);
  });

  it("G2: a solo user's PERSONAL organization is where their plan is read", async () => {
    // The wrong implementation this catches filters personal organizations out
    // inside the shared membership helper. Under it the licence reader stays
    // correct and every solo user silently loses every plan feature.
    emulator.set({ rows: { organization_members: [personalMembership()] } });
    rpcAnswer = () => planAnswer({ [KEY]: true });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("allowed");
    expect(rpcCalls).toEqual([
      { fn: "get_org_features", orgId: FIXTURE_PERSONAL_ORG_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// G3 — a database that has not had BACKLOG-3364's migration applied
// ---------------------------------------------------------------------------

describe("G3 — the gate works before the personal-organization column exists", () => {
  it("reads a brokerage member's plan on a pre-migration database", async () => {
    // Naming the column in the select, in an order or in a filter returns
    // 400 / 42703 with data null and NO throw. Every reader would take that for
    // "no membership", and every real brokerage member would lose their plan.
    emulator.set({
      columnPresent: false,
      rows: { organization_members: [brokerageMembership({ phase: "pre" })] },
    });
    rpcAnswer = () => planAnswer({ [KEY]: true });

    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("allowed");
  });

  it("issues no query argument that names the personal column", async () => {
    emulator.set({
      columnPresent: false,
      rows: { organization_members: [brokerageMembership({ phase: "pre" })] },
    });
    rpcAnswer = () => planAnswer({ [KEY]: true });

    await handlers.resolveContactInferenceState("outlook");

    const named = [
      ...emulator.state.selects.map((s) => s.columns),
      ...emulator.state.orders.map((o) => `${o.column} ${JSON.stringify(o.options ?? {})}`),
    ].filter((text) => text.includes(PERSONAL_COLUMN));
    expect(named).toEqual([]);
    expect(emulator.state.selects.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C8, G8 — the IPC channel
// ---------------------------------------------------------------------------

describe("C8, G8 — the channel", () => {
  it("C8: answers exactly what the resolver answers, on every non-positive read", async () => {
    const cases: { label: string; setup: () => void; expected: StrictFeatureState }[] = [
      {
        label: "C5 key absent",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => planAnswer({ ai_detection: false });
        },
        expected: "blocked",
      },
      {
        label: "C6 rpc failed",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => RPC_FAILED;
        },
        expected: "unknown",
      },
      {
        label: "C7 not_authorized",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => NOT_AUTHORIZED;
        },
        expected: "unknown",
      },
      {
        label: "C1 enabled",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => planAnswer({ [KEY]: true });
        },
        expected: "allowed",
      },
    ];

    for (const testCase of cases) {
      testCase.setup();
      featureGateService.invalidateCache();
      const viaChannel = await invokeStrictState(KEY);
      featureGateService.invalidateCache();
      const viaResolver = await handlers.resolveStrictFeatureState(KEY as never);

      expect([testCase.label, viaChannel]).toEqual([testCase.label, testCase.expected]);
      expect([testCase.label, viaChannel]).toEqual([testCase.label, viaResolver]);
    }
  });

  it("G8: a key that is not on the strict list answers unknown and reads no plan", async () => {
    // The renderer can send anything over IPC. `"constructor"` and `"__proto__"`
    // are truthy through the prototype chain, so a membership test written with
    // `in`, or a truthiness check on the lookup, would treat them as real keys.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => planAnswer({ [KEY]: true });

    const refused: unknown[] = [
      "desktop_text_export",
      "constructor",
      "__proto__",
      "toString",
      undefined,
      null,
      123,
      { key: KEY },
      [KEY],
    ];

    for (const featureKey of refused) {
      await expect(invokeStrictState(featureKey)).resolves.toBe("unknown");
    }

    expect(rpcCalls).toHaveLength(0);
    expect(emulator.state.selects).toHaveLength(0);
  });

  it("G8b: the strict key itself is accepted by the same check", async () => {
    // Without this, G8 passes against a channel that refuses EVERYTHING.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => planAnswer({ [KEY]: true });

    await expect(invokeStrictState(KEY)).resolves.toBe("allowed");
    expect(handlers.isStrictFeatureKey(KEY)).toBe(true);
    expect(handlers.isStrictFeatureKey("constructor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G9 — the half of the membership contract this item did NOT change
// ---------------------------------------------------------------------------

describe("G9 — resolveOrgId and the membership getter keep today's contract", () => {
  it("answers null, without throwing, when the lookup returns an ERROR RESULT", async () => {
    // The exact pre-migration failure, transcribed: 400 / 42703, data null, no
    // throw. `resolveOrgId` and the getter have always answered null here, and
    // re-routing them through the three-way outcome must not change that.
    queryError = {
      code: "42703",
      message: `column organizations_1.${PERSONAL_COLUMN} does not exist`,
      details: null,
      hint: null,
    };

    await expect(handlers.resolveOrgId()).resolves.toBeNull();
    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toBeNull();
    // ...and the strict gate can still tell that apart from "no membership".
    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");
  });

  it("answers null, without throwing, when the query THROWS", async () => {
    fromThrows = true;

    await expect(handlers.resolveOrgId()).resolves.toBeNull();
    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toBeNull();
  });

  it("answers null when there is NO active membership", async () => {
    emulator.set({ rows: { organization_members: [] } });

    await expect(handlers.resolveOrgId()).resolves.toBeNull();
    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toBeNull();
  });

  it("answers the personal organization id for a solo user", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(handlers.resolveOrgId()).resolves.toBe(FIXTURE_PERSONAL_ORG_ID);
    await expect(
      supabaseService.getActiveOrganizationMembership(FIXTURE_USER_ID)
    ).resolves.toMatchObject({
      organization_id: FIXTURE_PERSONAL_ORG_ID,
      is_personal: true,
    });
  });

  it("answers the brokerage id when the user holds both rows", async () => {
    emulator.set({
      rows: {
        organization_members: [
          personalMembership({ createdAt: "2026-01-01T00:00:00.000Z" }),
          brokerageMembership({ createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      },
    });

    await expect(handlers.resolveOrgId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("keeps throwing out of resolveOrgId when the session read throws", async () => {
    // Today's behaviour, which three call sites already live with. The strict
    // resolver catches for itself; resolveOrgId must not start swallowing.
    mockSupabaseClient.auth.getSession.mockRejectedValue(new Error("session boom"));

    await expect(handlers.resolveOrgId()).rejects.toThrow("session boom");
    await expect(handlers.resolveContactInferenceState("outlook")).resolves.toBe("unknown");
  });
});
