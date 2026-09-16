/**
 * @jest-environment node
 */

/**
 * BACKLOG-3365 — the hide-from-export plan gate.
 *
 * ---------------------------------------------------------------------------
 * What this suite is for
 * ---------------------------------------------------------------------------
 * BACKLOG-3349 built the strict reader and BACKLOG-3349's own suite is its
 * regression guard. This item adds ONE KEY to it, so this suite tests the key
 * and nothing else: that `desktop_hide_from_export` reaches the plan reader,
 * that an absent row reads BLOCKED rather than unknown or allowed, and that
 * `isHideFromExportAllowed` says yes only to a positive read.
 *
 * It drives the REAL `featureGateService` and the REAL membership helper over
 * BACKLOG-3364's PostgREST emulator, mocking only the Supabase client chain and
 * `fs.promises`. Mocking the service would make the one wrong implementation
 * that matters invisible: routing this read through
 * `featureGateService.checkFeature`, which answers ALLOWED for a key that is
 * not in the cache and for no cache at all. The row is NOT applied to
 * production, so under that mistake every organization would read allowed.
 *
 * ---------------------------------------------------------------------------
 * The feature map below is TRANSCRIBED, not invented
 * ---------------------------------------------------------------------------
 * `REAL_FEATURE_ROWS` is the live `public.feature_definitions` table read on
 * 2026-09-16 — 23 rows, `ORDER BY sort_order, key`, which is the exact query
 * `get_org_features` loops over. `orgFeatures()` then applies the function's
 * own projection, read out of `pg_get_functiondef(get_org_features)` the same
 * day: one entry per row, `{enabled, value, value_type, name, source}`, wrapped
 * in `{org_id, plan_name, plan_tier, features}`.
 *
 * Neither strict key is among those 23 rows. That is the shipped state of every
 * organization, and it is the state this suite asserts on.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  personalMembership,
  FIXTURE_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";
import type { StrictFeatureState } from "../../types/featureGate";

// ---------------------------------------------------------------------------
// Harness — the shape of BACKLOG-3349's own suite, which this key plugs into
// ---------------------------------------------------------------------------

let emulator: Emulator;
let rpcAnswer: (orgId: string) => { data: unknown; error: unknown };
let rpcCalls: { fn: string; orgId: unknown }[] = [];
let fromThrows = false;

const mockSupabaseClient = {
  from: (table: string) => {
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
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-3365") },
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

/**
 * `fs.promises` only. `readFileSync` stays REAL because the emulator reads the
 * committed PostgREST fixtures with it at module load.
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

// ---------------------------------------------------------------------------
// The transcribed producer
// ---------------------------------------------------------------------------

interface FeatureRow {
  key: string;
  name: string;
  value_type: string;
  default_value: string;
}

/**
 * `SELECT key, name, value_type, default_value FROM public.feature_definitions
 *  ORDER BY sort_order, key` — production, 2026-09-16, 23 rows, in that order.
 *
 * NOT hand-picked and NOT trimmed: an abridged map would let a wrong
 * implementation that reads some other key pass by accident.
 */
const REAL_FEATURE_ROWS: FeatureRow[] = [
  { key: "max_seats", name: "Maximum Seats", value_type: "integer", default_value: "false" },
  { key: "broker_text_view", name: "Broker Text View", value_type: "boolean", default_value: "true" },
  { key: "desktop_text_export", name: "Desktop Text Export", value_type: "boolean", default_value: "false" },
  { key: "broker_email_view", name: "Broker Email View", value_type: "boolean", default_value: "true" },
  { key: "desktop_email_export", name: "Desktop Email Export", value_type: "boolean", default_value: "false" },
  { key: "broker_text_attachments", name: "Broker Text Attachments", value_type: "boolean", default_value: "false" },
  { key: "desktop_text_attachments", name: "Desktop Text Attachments", value_type: "boolean", default_value: "false" },
  { key: "broker_email_attachments", name: "Broker Email Attachments", value_type: "boolean", default_value: "false" },
  { key: "desktop_email_attachments", name: "Desktop Email Attachments", value_type: "boolean", default_value: "false" },
  { key: "call_log", name: "Call Log Access", value_type: "boolean", default_value: "false" },
  { key: "max_transaction_size", name: "Max Transaction Size", value_type: "integer", default_value: "10" },
  { key: "iphone_sync", name: "iPhone Sync", value_type: "boolean", default_value: "true" },
  { key: "email_sync", name: "Email Sync", value_type: "boolean", default_value: "true" },
  { key: "voice_transcription", name: "Voice Message Transcription", value_type: "boolean", default_value: "false" },
  { key: "custom_retention", name: "Custom Retention Period", value_type: "boolean", default_value: "false" },
  { key: "sso_login", name: "SSO Login", value_type: "boolean", default_value: "false" },
  { key: "broker_portal_access", name: "Broker Portal Access", value_type: "boolean", default_value: "false" },
  { key: "broker_submission", name: "Broker Submission", value_type: "boolean", default_value: "false" },
  { key: "team_management", name: "Team Management", value_type: "boolean", default_value: "false" },
  { key: "multi_seat", name: "Multi-Seat", value_type: "boolean", default_value: "false" },
  { key: "scim_provisioning", name: "SCIM Provisioning", value_type: "boolean", default_value: "false" },
  { key: "jit_provisioning", name: "Just-in-Time Provisioning", value_type: "boolean", default_value: "false" },
  { key: "ai_detection", name: "AI Detection", value_type: "boolean", default_value: "false" },
];

/** The row this item's migration adds. Absent from production until it is applied. */
const HIDE_ROW: FeatureRow = {
  key: "desktop_hide_from_export",
  name: "Hide from export",
  value_type: "boolean",
  default_value: "false",
};

/** The row BACKLOG-3349's migration adds. Also absent, also unapplied. */
const INFERENCE_ROW: FeatureRow = {
  key: "email_contact_inference",
  name: "Contacts from email",
  value_type: "boolean",
  default_value: "false",
};

/**
 * `get_org_features`'s own projection, applied to whichever rows are present.
 *
 * `enabled`/`value`/`source` follow the function's plan branch when `enabled`
 * is given for a key, and its no-plan branch otherwise — which is exactly what
 * the function does for an organization with no `organization_plans` row.
 */
function orgFeatures(
  rows: FeatureRow[],
  enabled: Record<string, boolean> = {}
): { data: unknown; error: unknown } {
  const features: Record<string, unknown> = {};
  for (const row of rows) {
    const onPlan = Object.prototype.hasOwnProperty.call(enabled, row.key);
    const isEnabled = onPlan ? enabled[row.key] : row.default_value === "true";
    features[row.key] = {
      enabled: isEnabled,
      value: onPlan ? String(isEnabled) : row.default_value,
      value_type: row.value_type,
      name: row.name,
      source: onPlan ? "plan" : "default",
    };
  }
  return {
    data: {
      org_id: "fixture",
      plan_name: onPlanName(enabled),
      plan_tier: onPlanName(enabled) === "none" ? "none" : "individual",
      features,
    },
    error: null,
  };
}

function onPlanName(enabled: Record<string, boolean>): string {
  return Object.keys(enabled).length > 0 ? "Individual" : "none";
}

/** The RPC could not be answered at all. */
const RPC_FAILED = {
  data: null,
  error: { message: "network error", code: "PGRST000", details: null, hint: null },
};

/** What `get_org_features` returns to a caller it will not answer for. */
const NOT_AUTHORIZED = { data: { error: "not_authorized", features: [] }, error: null };

type Handlers = typeof import("../featureGateHandlers");

let handlers: Handlers;
let featureGateService: typeof import("../../services/featureGateService").default;

const KEY = "desktop_hide_from_export";

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
  emulator = createPostgrestEmulator();
  rpcAnswer = () => orgFeatures(REAL_FEATURE_ROWS);
  signedIn();

  handlers = await import("../featureGateHandlers");
  featureGateService = (await import("../../services/featureGateService")).default;
  handlers.registerFeatureGateHandlers();
});

// ---------------------------------------------------------------------------
// C0 — the fixture is the production key set, and neither strict key is in it
// ---------------------------------------------------------------------------

describe("C0 — the transcribed map", () => {
  it("carries the 23 production keys and neither strict key", () => {
    // Without this, every "absent key" assertion below could be passing because
    // the fixture is empty rather than because the row is missing.
    expect(REAL_FEATURE_ROWS).toHaveLength(23);
    const keys = REAL_FEATURE_ROWS.map((r) => r.key);
    expect(new Set(keys).size).toBe(23);
    expect(keys).not.toContain("desktop_hide_from_export");
    expect(keys).not.toContain("email_contact_inference");
    // The producer's entry shape, so a reader of this file can check it against
    // `pg_get_functiondef(get_org_features)` without running anything.
    const map = (orgFeatures(REAL_FEATURE_ROWS).data as { features: Record<string, unknown> })
      .features;
    expect(Object.keys(map)).toHaveLength(23);
    expect(map.desktop_text_export).toEqual({
      enabled: false,
      value: "false",
      value_type: "boolean",
      name: "Desktop Text Export",
      source: "default",
    });
  });
});

// ---------------------------------------------------------------------------
// C1 — isHideFromExportAllowed says yes only to a positive read
// ---------------------------------------------------------------------------

describe("C1 — a positive read, and only a positive read, allows hiding", () => {
  it("the key is enabled on the plan -> true", () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => orgFeatures([...REAL_FEATURE_ROWS, HIDE_ROW], { [KEY]: true });

    return expect(handlers.isHideFromExportAllowed()).resolves.toBe(true);
  });

  it("the key is present and disabled -> false", () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => orgFeatures([...REAL_FEATURE_ROWS, HIDE_ROW], { [KEY]: false });

    return expect(handlers.isHideFromExportAllowed()).resolves.toBe(false);
  });

  it("the OTHER strict key is enabled and this one is absent -> false", async () => {
    // The likeliest slip in a file where both strict keys now live is a
    // copy-pasted `email_contact_inference`. Under it this map reads ALLOWED.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () =>
      orgFeatures([...REAL_FEATURE_ROWS, INFERENCE_ROW], { email_contact_inference: true });

    await expect(handlers.isHideFromExportAllowed()).resolves.toBe(false);
    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("blocked");
  });

  it("every non-positive read answers false", async () => {
    const cases: { label: string; setup: () => void }[] = [
      {
        label: "the production map, which does not carry the key",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => orgFeatures(REAL_FEATURE_ROWS);
        },
      },
      {
        label: "no active membership",
        setup: () => emulator.set({ rows: { organization_members: [] } }),
      },
      {
        label: "the plan RPC failed",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => RPC_FAILED;
        },
      },
      {
        label: "not_authorized",
        setup: () => {
          emulator.set({ rows: { organization_members: [brokerageMembership()] } });
          rpcAnswer = () => NOT_AUTHORIZED;
        },
      },
      {
        label: "the membership lookup threw",
        setup: () => {
          emulator.set({ columnPresent: true, rows: {} });
          fromThrows = true;
        },
      },
      {
        label: "nobody is signed in",
        setup: () => {
          mockSupabaseClient.auth.getSession.mockResolvedValue({
            data: { session: null },
            error: null,
          });
        },
      },
    ];

    for (const testCase of cases) {
      testCase.setup();
      featureGateService.invalidateCache();
      const allowed = await handlers.isHideFromExportAllowed();
      expect([testCase.label, allowed]).toEqual([testCase.label, false]);
      fromThrows = false;
    }
  });
});

// ---------------------------------------------------------------------------
// C2 — the absent row reads BLOCKED, not unknown, and not allowed
// ---------------------------------------------------------------------------

describe("C2 — the shipped state of every organization: the row is not applied", () => {
  it("the real production map answers BLOCKED through the channel", async () => {
    // `blocked` and `unknown` are both refusals, so a boolean assertion cannot
    // tell them apart — and the difference is the whole discriminator. `unknown`
    // here would mean the key never reached the plan reader at all: the right
    // answer for the wrong reason, and a reading that would put "we can't check
    // your plan" on screen for a plan that was read perfectly well.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => orgFeatures(REAL_FEATURE_ROWS);

    await expect(invokeStrictState(KEY)).resolves.toBe("blocked");
    expect(rpcCalls.map((c) => c.fn)).toEqual(["get_org_features"]);
  });

  it("the channel accepts this key and answers exactly what the resolver answers", async () => {
    // Without this, the control above would pass against a channel that refuses
    // every key it is given.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => orgFeatures([...REAL_FEATURE_ROWS, HIDE_ROW], { [KEY]: true });

    expect(handlers.isStrictFeatureKey(KEY)).toBe(true);
    const viaChannel = await invokeStrictState(KEY);
    featureGateService.invalidateCache();
    const viaResolver = await handlers.resolveStrictFeatureState(KEY);

    expect(viaChannel).toBe("allowed");
    expect(viaChannel).toBe(viaResolver);
  });

  it("a read that never saw a plan is unknown, never blocked", async () => {
    // "Not in your plan" is a claim. A failed RPC has not seen one, and telling
    // an entitled user their plan lacks a feature they paid for is the one
    // wrong sentence this three-state read exists to prevent.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });
    rpcAnswer = () => RPC_FAILED;

    await expect(invokeStrictState(KEY)).resolves.toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// C3 — a solo user's personal organization is where the plan is read
// ---------------------------------------------------------------------------

describe("C3 — BACKLOG-3364's personal organization carries the plan", () => {
  it("a personal-org member with the feature enabled may hide", async () => {
    // The wrong implementation this catches filters personal organizations out
    // of the membership helper. Under it the licence reader stays correct and
    // every solo user — which is most of them — silently loses this feature.
    emulator.set({ rows: { organization_members: [personalMembership()] } });
    rpcAnswer = () => orgFeatures([...REAL_FEATURE_ROWS, HIDE_ROW], { [KEY]: true });

    await expect(handlers.isHideFromExportAllowed()).resolves.toBe(true);
    expect(rpcCalls).toEqual([
      { fn: "get_org_features", orgId: FIXTURE_PERSONAL_ORG_ID },
    ]);
  });

  it("a personal-org member on the shipped map may not", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });
    rpcAnswer = () => orgFeatures(REAL_FEATURE_ROWS);

    await expect(handlers.resolveStrictFeatureState(KEY)).resolves.toBe("blocked");
    await expect(handlers.isHideFromExportAllowed()).resolves.toBe(false);
  });
});
