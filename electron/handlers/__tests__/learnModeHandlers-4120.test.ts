/**
 * @jest-environment node
 */

/**
 * BACKLOG-4120 PR2 — the Learn mode IPC surface.
 *
 *   SETS  the gated and ungated channel sets, by execution (every registered
 *         learn: channel is in exactly one list)
 *   C9    the switch matrix (SR 426498b4 change 3): {toggle on/off} x
 *         {autodetect_eval allowed / present-disabled / absent (production map)
 *         / unreadable} x {enable_auto_detect 0/1} x {ai_detection allowed /
 *         blocked}. Allowed iff toggle ON and autodetect_eval allowed. The
 *         refusal set includes enable_auto_detect=1 + ai_detection allowed, so an
 *         implementation that ORs AI detection into the gate goes red.
 *   P1    no session -> every channel refuses
 *   P3    a run makes 0 Supabase table/RPC calls once the gate has passed
 *   P5    (main) feature-gate:strict-state answers for autodetect_eval, blocked
 *         on the production map
 *   PV    preview: membership checks; attachments listed, never downloaded;
 *         canary body never logged, sent as an event, or reported to Sentry;
 *         no provider fetch module is even loaded
 *
 * It drives the REAL featureGateHandlers + featureGateService over the
 * PostgREST emulator (the BACKLOG-3365 harness), the REAL learn services and
 * the REAL schema.sql on the real driver. The feature map is TRANSCRIBED from
 * production (below), not invented.
 *
 * Synthetic data only: Canarytest / Testville / ZZ / 00000, @example.test.
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import {
  createPostgrestEmulator,
  brokerageMembership,
  FIXTURE_USER_ID,
  type Emulator,
} from "../../services/__tests__/helpers/postgrestEmulator";

// ---------------------------------------------------------------------------
// Real local database
// ---------------------------------------------------------------------------

let db: DatabaseType;
jest.mock("../../services/db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

// ---------------------------------------------------------------------------
// Supabase client over the emulator (BACKLOG-3365 harness)
// ---------------------------------------------------------------------------

let emulator: Emulator;
let rpcAnswer: (orgId: string) => { data: unknown; error: unknown };
const cloudCalls: string[] = [];

const mockSupabaseClient = {
  from: (table: string) => {
    cloudCalls.push(`from:${table}`);
    return emulator.from(table);
  },
  rpc: jest.fn(async (fn: string, args?: { p_org_id?: string }) => {
    cloudCalls.push(`rpc:${fn}`);
    return rpcAnswer(args?.p_org_id ?? "");
  }),
  auth: {
    getSession: jest.fn(),
    onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
  },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

// The desktop session file (the local user id).
let sessionUser: string | null = null;
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: {
    updateSession: jest.fn().mockResolvedValue(true),
    loadSession: jest.fn(async () => (sessionUser ? { user: { id: sessionUser } } : null)),
  },
}));

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: jest.fn(() => "/tmp/keepr-test-4120") },
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
        Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
      ),
      writeFile: jest.fn(() => Promise.resolve()),
      unlink: jest.fn(() => Promise.resolve()),
    },
  };
});

const logCalls: unknown[][] = [];
jest.mock("../../services/logService", () => {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      logCalls.push([level, ...args]);
    };
  const m = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
  return { __esModule: true, default: m, logService: m };
});

const sentryCalls: unknown[][] = [];
jest.mock("@sentry/electron/main", () => {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      sentryCalls.push([name, ...args]);
    };
  return {
    captureException: rec("captureException"),
    captureMessage: rec("captureMessage"),
    addBreadcrumb: rec("addBreadcrumb"),
    setExtra: rec("setExtra"),
    setContext: rec("setContext"),
    withScope: (fn: (scope: unknown) => void) =>
      fn({ setExtra: rec("scope.setExtra"), setTag: rec("scope.setTag"), setContext: rec("scope.setContext") }),
  };
});

// No provider fetch, download path or AI module may even be LOADED.
const loaded: string[] = [];
jest.mock("../../services/gmailFetchService", () => {
  loaded.push("gmailFetchService");
  return { __esModule: true, default: {} };
});
jest.mock("../../services/outlookFetchService", () => {
  loaded.push("outlookFetchService");
  return { __esModule: true, default: {} };
});
jest.mock("../../services/emailAttachmentService", () => {
  loaded.push("emailAttachmentService");
  return { __esModule: true, default: {} };
});
jest.mock("../../services/extraction/hybridExtractorService", () => {
  loaded.push("hybridExtractorService");
  return { hybridExtractorService: {} };
});
jest.mock("../../services/llm/llmConfigService", () => {
  loaded.push("llmConfigService");
  return { __esModule: true, default: {} };
});
jest.mock("../../services/transactionService", () => {
  loaded.push("transactionService");
  return { __esModule: true, default: {} };
});

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
 *  ORDER BY sort_order, key` — production, 2026-11-04, 29 rows, in that order.
 * autodetect_eval is absent: its migration is not applied. ai_detection is
 * present (default false).
 */
const PROD_FEATURE_ROWS: FeatureRow[] = [
  { key: "max_seats", name: "Maximum Seats", value_type: "integer", default_value: "false" },
  { key: "broker_text_view", name: "Broker Text View", value_type: "boolean", default_value: "true" },
  { key: "desktop_text_export", name: "Desktop Text Export", value_type: "boolean", default_value: "false" },
  { key: "broker_email_view", name: "Broker Email View", value_type: "boolean", default_value: "true" },
  { key: "desktop_email_export", name: "Desktop Email Export", value_type: "boolean", default_value: "false" },
  { key: "broker_text_attachments", name: "Broker Text Attachments", value_type: "boolean", default_value: "false" },
  { key: "desktop_text_attachments", name: "Desktop Text Attachments", value_type: "boolean", default_value: "false" },
  { key: "broker_email_attachments", name: "Broker Email Attachments", value_type: "boolean", default_value: "false" },
  { key: "desktop_email_attachments", name: "Desktop Email Attachments", value_type: "boolean", default_value: "false" },
  { key: "desktop_hide_from_export", name: "Hide from export", value_type: "boolean", default_value: "false" },
  { key: "call_log", name: "Call Log Access", value_type: "boolean", default_value: "false" },
  { key: "max_transaction_size", name: "Max Transaction Size", value_type: "integer", default_value: "10" },
  { key: "iphone_sync", name: "iPhone Sync", value_type: "boolean", default_value: "true" },
  { key: "email_sync", name: "Email Sync", value_type: "boolean", default_value: "true" },
  { key: "voice_transcription", name: "Voice Message Transcription", value_type: "boolean", default_value: "false" },
  { key: "custom_retention", name: "Custom Retention Period", value_type: "boolean", default_value: "false" },
  { key: "sso_login", name: "SSO Login", value_type: "boolean", default_value: "false" },
  { key: "broker_portal_access", name: "Broker Portal Access", value_type: "boolean", default_value: "false" },
  { key: "portal_my_transactions", name: "My Transactions", value_type: "boolean", default_value: "false" },
  { key: "broker_submission", name: "Broker Submission", value_type: "boolean", default_value: "false" },
  { key: "account_suspended", name: "Account suspended", value_type: "boolean", default_value: "false" },
  { key: "transaction_checklists", name: "Transaction checklists", value_type: "boolean", default_value: "false" },
  { key: "team_management", name: "Team Management", value_type: "boolean", default_value: "false" },
  { key: "multi_seat", name: "Multi-Seat", value_type: "boolean", default_value: "false" },
  { key: "scim_provisioning", name: "SCIM Provisioning", value_type: "boolean", default_value: "false" },
  { key: "jit_provisioning", name: "Just-in-Time Provisioning", value_type: "boolean", default_value: "false" },
  { key: "ai_detection", name: "AI Detection", value_type: "boolean", default_value: "false" },
  { key: "email_contact_inference", name: "Contacts from email", value_type: "boolean", default_value: "false" },
  { key: "unlimited_transactions", name: "Unlimited transactions", value_type: "boolean", default_value: "false" },
];

/** The row this item's migration adds (NOT applied). */
const EVAL_ROW: FeatureRow = {
  key: "autodetect_eval",
  name: "Help Keepr learn",
  value_type: "boolean",
  default_value: "false",
};

/** get_org_features' projection (copied from the BACKLOG-3365 suite). */
function orgFeatures(rows: FeatureRow[], enabled: Record<string, boolean> = {}): { data: unknown; error: unknown } {
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
  const named = Object.keys(enabled).length > 0;
  return {
    data: { org_id: "fixture", plan_name: named ? "Individual" : "none", plan_tier: named ? "individual" : "none", features },
    error: null,
  };
}

const RPC_FAILED = { data: null, error: { message: "network error", code: "PGRST000", details: null, hint: null } };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = FIXTURE_USER_ID;
const CANARY_ADDRESS = "4120 Canarytest Lane, Testville, ZZ 00000";
const CANARY_BODY = `Canarybody: offer accepted on ${CANARY_ADDRESS}. Closing next month, escrow opened.`;
const CANARY_HTML = `<p>Canaryhtml</p><img src="https://tracker.example.test/pixel.gif">`;

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));

type Handlers = typeof import("../learnModeHandlers");
let handlers: Handlers;
let featureGateHandlers: typeof import("../featureGateHandlers");

const sent: Array<[string, unknown]> = [];
const fakeEvent = {
  sender: {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push([channel, payload]);
    },
  },
};

async function invoke(channel: string, payload?: unknown): Promise<Record<string, unknown>> {
  const h = ipcHandlers.get(channel);
  if (!h) throw new Error(`${channel} was never registered`);
  return (await (payload === undefined ? h(fakeEvent) : h(fakeEvent, payload))) as Record<string, unknown>;
}

/** A valid payload for every channel, so a refusal can only come from the gate. */
const VALID: Record<string, unknown> = {
  "learn:run": { windowMonths: 12 },
  "learn:cleanup-next": undefined,
  "learn:cleanup-answer": { detectionId: "d1", answer: "yes" },
  "learn:sample-draw": { windowMonths: 12 },
  "learn:sample-next": undefined,
  "learn:sample-answer": { rowId: "row-4120-x", answer: "skip" },
  "learn:score": undefined,
  "learn:delete-answers": undefined,
  "learn:preview": { kind: "bulk", rowId: "row-4120-x" },
  "learn:attachment-open": { detectionId: "d1", attachmentId: "att-4120-x" },
  "learn:get-state": undefined,
  "learn:set-enabled": { enabled: true },
};

function signedIn(on = true): void {
  sessionUser = on ? USER : null;
  mockSupabaseClient.auth.getSession.mockResolvedValue(
    on
      ? { data: { session: { user: { id: USER, email: "fixture@example.test" } } }, error: null }
      : { data: { session: null }, error: null },
  );
}

type EvalState = "allowed" | "disabled" | "absent" | "unreadable";

function planMap(evalState: EvalState, aiDetection: boolean): void {
  if (evalState === "unreadable") {
    rpcAnswer = () => RPC_FAILED;
    return;
  }
  const rows = evalState === "absent" ? PROD_FEATURE_ROWS : [...PROD_FEATURE_ROWS, EVAL_ROW];
  const enabled: Record<string, boolean> = { ai_detection: aiDetection };
  if (evalState !== "absent") enabled.autodetect_eval = evalState === "allowed";
  rpcAnswer = () => orgFeatures(rows, enabled);
}

function setToggle(on: boolean): void {
  run(
    `INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at)
     VALUES ('lms-4120-a', ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    USER,
    on ? 1 : 0,
  );
}

function setAutoDetect(on: boolean): void {
  run(`INSERT INTO llm_settings (id, user_id, enable_auto_detect) VALUES ('llm-4120-a', ?, ?)`, USER, on ? 1 : 0);
}

let emailSeq = 0;
function seedEmail(opts: { sentAt: string; subject?: string; body?: string; html?: string | null; externalId?: string }): string {
  emailSeq += 1;
  const id = `e-${String(emailSeq).padStart(5, "0")}`;
  run(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, body_plain, body_html, has_attachments)
     VALUES (?, ?, ?, 'gmail', 'acct-0', ?, 'agent@example.test', 'me@example.test', ?, ?, ?, 1)`,
    id,
    USER,
    opts.externalId ?? `ext-${emailSeq}`,
    opts.subject ?? "Hello",
    opts.sentAt,
    opts.body ?? "Lunch on Friday?",
    opts.html ?? null,
  );
  return id;
}

function seedAttachment(emailId: string, id: string, filename: string, storagePath: string | null): void {
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, storage_path) VALUES (?, ?, ?, 'application/pdf', 1234, ?)`,
    id,
    emailId,
    filename,
    storagePath,
  );
}

beforeEach(async () => {
  jest.resetModules();
  ipcHandlers.clear();
  cloudCalls.length = 0;
  logCalls.length = 0;
  sentryCalls.length = 0;
  sent.length = 0;
  emailSeq = 0;

  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);

  emulator = createPostgrestEmulator();
  emulator.set({ rows: { organization_members: [brokerageMembership()] } });
  planMap("allowed", false);
  signedIn();

  featureGateHandlers = await import("../featureGateHandlers");
  featureGateHandlers.registerFeatureGateHandlers();
  handlers = await import("../learnModeHandlers");
  handlers.registerLearnModeHandlers();
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
describe("C0 the transcribed production map", () => {
  it("carries 29 production keys, ai_detection among them, autodetect_eval not", () => {
    expect(PROD_FEATURE_ROWS).toHaveLength(29);
    const keys = PROD_FEATURE_ROWS.map((r) => r.key);
    expect(new Set(keys).size).toBe(29);
    expect(keys).toContain("ai_detection");
    expect(keys).not.toContain("autodetect_eval");
  });
});

// ---------------------------------------------------------------------------
describe("SETS gated and ungated channels, by execution", () => {
  it("every registered learn: channel is in exactly one list, and the lists match registration", () => {
    const registered = [...ipcHandlers.keys()].filter((c) => c.startsWith("learn:")).sort();
    const listed = [...handlers.LEARN_GATED_CHANNELS, ...handlers.LEARN_UNGATED_CHANNELS].sort();
    expect(registered).toEqual(listed);
    expect(registered).toHaveLength(12);
    expect(Object.keys(VALID).sort()).toEqual(listed);
  });

  it("with the toggle OFF and the key allowed, exactly the gated set refuses as 'off'", async () => {
    setToggle(false);
    const refused: string[] = [];
    for (const channel of Object.keys(VALID)) {
      const r = await invoke(channel, VALID[channel]);
      if (r.success === false && r.error === handlers.LEARN_NOT_ON_ERROR) refused.push(channel);
    }
    expect(refused.sort()).toEqual([...handlers.LEARN_GATED_CHANNELS].sort());
  });
});

// ---------------------------------------------------------------------------
describe("C9 switch matrix", () => {
  const evalStates: EvalState[] = ["allowed", "disabled", "absent", "unreadable"];
  const cases: Array<{ toggle: boolean; evalState: EvalState; autoDetect: boolean; aiDetection: boolean }> = [];
  for (const toggle of [true, false])
    for (const evalState of evalStates)
      for (const autoDetect of [false, true])
        for (const aiDetection of [true, false]) cases.push({ toggle, evalState, autoDetect, aiDetection });

  it("has 32 cases, including refusals with enable_auto_detect=1 and ai_detection allowed", () => {
    expect(cases).toHaveLength(32);
    expect(
      cases.filter((c) => !(c.toggle && c.evalState === "allowed") && c.autoDetect && c.aiDetection).length,
    ).toBe(7);
  });

  it.each(cases)(
    "toggle=$toggle autodetect_eval=$evalState enable_auto_detect=$autoDetect ai_detection=$aiDetection",
    async ({ toggle, evalState, autoDetect, aiDetection }) => {
      setToggle(toggle);
      setAutoDetect(autoDetect);
      planMap(evalState, aiDetection);
      const expectAllowed = toggle && evalState === "allowed";

      await expect(handlers.isLearnModeAllowed(USER)).resolves.toBe(expectAllowed);
      for (const channel of handlers.LEARN_GATED_CHANNELS) {
        const r = await invoke(channel, VALID[channel]);
        const refusedByGate = r.success === false && r.error === handlers.LEARN_NOT_ON_ERROR;
        expect({ channel, refusedByGate }).toEqual({ channel, refusedByGate: !expectAllowed });
      }
      if (expectAllowed) {
        const r = await invoke("learn:run", { windowMonths: 12 });
        expect(r.success).toBe(true);
      }
      // get-state reports availability from the strict key alone.
      const state = await invoke("learn:get-state");
      expect(state).toEqual({
        success: true,
        available: evalState === "allowed",
        enabled: expectAllowed,
        answers: { deal: 0, bulk: 0 },
      });
    },
  );

  it("set-enabled checks only the strict key: refused on the production map, allowed when the key is on", async () => {
    planMap("absent", true);
    expect(await invoke("learn:set-enabled", { enabled: true })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_AVAILABLE_ERROR,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM learn_mode_settings`).get()).toEqual({ n: 0 });

    planMap("allowed", false);
    // A fresh module set so the plan map is re-read (the strict reader caches per user).
    jest.resetModules();
    ipcHandlers.clear();
    (await import("../featureGateHandlers")).registerFeatureGateHandlers();
    handlers = await import("../learnModeHandlers");
    handlers.registerLearnModeHandlers();
    expect(await invoke("learn:set-enabled", { enabled: true })).toEqual({ success: true, enabled: true });
    expect(await invoke("learn:get-state")).toEqual({
      success: true,
      available: true,
      enabled: true,
      answers: { deal: 0, bulk: 0 },
    });
  });

  it("set-enabled false always succeeds, even when the key is off, and keeps the row off if the key returns", async () => {
    setToggle(true);
    planMap("disabled", true);
    expect(await invoke("learn:set-enabled", { enabled: false })).toEqual({ success: true, enabled: false });
    expect(db.prepare(`SELECT enabled FROM learn_mode_settings WHERE user_id = ?`).get(USER)).toEqual({ enabled: 0 });
    expect(await invoke("learn:set-enabled", { enabled: true })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_AVAILABLE_ERROR,
    });
  });
});

// ---------------------------------------------------------------------------
describe("P1 no session", () => {
  it("every channel refuses when the desktop session names no user", async () => {
    setToggle(true);
    signedIn(false);
    for (const channel of Object.keys(VALID)) {
      const r = await invoke(channel, VALID[channel]);
      expect({ channel, r }).toEqual({ channel, r: { success: false, error: handlers.LEARN_NO_SESSION_ERROR } });
    }
  });
});

// ---------------------------------------------------------------------------
describe("P3 no cloud calls in a run once the gate has passed", () => {
  it("learn:run, cleanup and score make 0 Supabase table or RPC calls after the first gate read", async () => {
    setToggle(true);
    seedEmail({ sentAt: "2026-10-01T10:00:00.000Z", subject: "Offer accepted", body: CANARY_BODY });
    // Warm the strict reader (one membership read + one plan read).
    await expect(handlers.isLearnModeAllowed(USER)).resolves.toBe(true);
    expect(cloudCalls.length).toBeGreaterThan(0);
    cloudCalls.length = 0;

    const r = await invoke("learn:run", { windowMonths: 12 });
    expect(r.success).toBe(true);
    await invoke("learn:cleanup-next");
    await invoke("learn:score");
    expect(cloudCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("P5 (main) strict state for autodetect_eval", () => {
  async function strictState(): Promise<unknown> {
    const h = ipcHandlers.get("feature-gate:strict-state");
    if (!h) throw new Error("feature-gate:strict-state not registered");
    return h({}, "autodetect_eval");
  }

  it("absent from the production map -> blocked; enabled -> allowed; unreadable -> unknown", async () => {
    planMap("absent", true);
    await expect(strictState()).resolves.toBe("blocked");
  });

  it("allowed when the plan carries it enabled", async () => {
    planMap("allowed", false);
    await expect(strictState()).resolves.toBe("allowed");
  });

  it("unknown when the plan cannot be read", async () => {
    planMap("unreadable", true);
    await expect(strictState()).resolves.toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
describe("PV preview channel", () => {
  async function runWithCanaryDeal(): Promise<{ emailId: string; detectionId: string }> {
    if (!db.prepare(`SELECT 1 FROM learn_mode_settings`).get()) setToggle(true);
    const emailId = seedEmail({
      sentAt: "2026-10-01T10:00:00.000Z",
      subject: "Offer accepted",
      body: CANARY_BODY,
      html: CANARY_HTML,
    });
    seedEmail({ sentAt: "2026-10-02T10:00:00.000Z", subject: "Lunch", body: "Lunch on Friday?" });
    seedAttachment(emailId, "att-4120-1", "Canary purchase agreement.pdf", null);
    seedAttachment(emailId, "att-4120-2", "Canary disclosure.pdf", "/tmp/keepr-test-4120/att-4120-2.pdf");
    const r = await invoke("learn:run", { windowMonths: 12 });
    expect(r.success).toBe(true);
    const summary = r.summary as { detectionIds: string[] };
    expect(summary.detectionIds).toHaveLength(1);
    return { emailId, detectionId: summary.detectionIds[0] };
  }

  it("a detection of the current run previews its messages; attachments listed, none downloaded", async () => {
    const { emailId, detectionId } = await runWithCanaryDeal();
    const r = await invoke("learn:preview", { kind: "cleanup", detectionId });
    expect(r.success).toBe(true);
    const emails = r.emails as Array<Record<string, unknown>>;
    expect(r.totalEmails).toBe(1);
    expect(emails.map((e) => e.id)).toEqual([emailId]);
    expect(emails[0].bodyPlain).toBe(CANARY_BODY);
    expect(emails[0].bodyHtml).toBe(CANARY_HTML);
    expect(emails[0].attachments).toEqual([
      {
        id: "att-4120-2",
        filename: "Canary disclosure.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        downloaded: true,
        storagePath: "/tmp/keepr-test-4120/att-4120-2.pdf",
      },
      {
        id: "att-4120-1",
        filename: "Canary purchase agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        downloaded: false,
        storagePath: null,
      },
    ]);
    // No download happened: the not-downloaded row is unchanged on disk.
    expect(
      db.prepare(`SELECT storage_path FROM attachments WHERE id = 'att-4120-1'`).get(),
    ).toEqual({ storage_path: null });
  });

  it("an id outside the current run, or with no run, is refused", async () => {
    setToggle(true);
    expect(await invoke("learn:preview", { kind: "cleanup", detectionId: "d1" })).toEqual({
      success: false,
      error: handlers.LEARN_NO_RUN_ERROR,
    });
    const { detectionId } = await runWithCanaryDeal();
    expect(detectionId).toBe("d1");
    expect(await invoke("learn:preview", { kind: "cleanup", detectionId: "d2" })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_IN_SET_ERROR,
    });
  });

  it("a bulk preview needs a LIVE sample row of this user, and resolves through the provider key", async () => {
    setToggle(true);
    const emailId = seedEmail({ sentAt: "2026-10-01T10:00:00.000Z", body: CANARY_BODY, externalId: "ext-canary" });
    run(
      `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, rule_version, created_at, updated_at)
       VALUES ('row-4120-live', ?, 'gmail', 'ext-canary', '2026-11-01T00:00:00Z', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
      USER,
    );
    run(
      `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, rule_version, created_at, updated_at, deleted_at)
       VALUES ('row-4120-gone', ?, 'gmail', 'ext-canary', '2026-11-01T00:00:00Z', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')`,
      USER,
    );
    const ok = await invoke("learn:preview", { kind: "bulk", rowId: "row-4120-live" });
    expect(ok.success).toBe(true);
    expect((ok.emails as Array<{ id: string }>).map((e) => e.id)).toEqual([emailId]);
    expect(await invoke("learn:preview", { kind: "bulk", rowId: "row-4120-gone" })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_IN_SET_ERROR,
    });
    expect(await invoke("learn:preview", { kind: "bulk", rowId: "row-4120-none" })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_IN_SET_ERROR,
    });
  });

  it("canary text never reaches a log line, an event, or Sentry; no fetch module is loaded", async () => {
    const fetchSpy = jest.fn();
    const realFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { detectionId } = await runWithCanaryDeal();
      await invoke("learn:cleanup-next");
      await invoke("learn:preview", { kind: "cleanup", detectionId });
      await invoke("learn:cleanup-answer", { detectionId, answer: "yes" });
      await invoke("learn:score");
      // a failing request: the error path must not leak either
      await invoke("learn:preview", { kind: "cleanup", detectionId: "d9" });
    } finally {
      global.fetch = realFetch;
    }
    const dump = JSON.stringify({ logCalls, sentryCalls, sent });
    expect(logCalls.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    for (const canary of ["Canarytest", "canarytest", "Canarybody", "Canaryhtml", "Canary purchase", "Offer accepted"]) {
      expect({ canary, found: dump.includes(canary) }).toEqual({ canary, found: false });
    }
    expect(sentryCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loaded).toEqual([]);
    // events carry ids and counts only
    for (const [channel, payload] of sent) {
      expect(channel).toBe(handlers.LEARN_RUN_PROGRESS_CHANNEL);
      expect(Object.keys(payload as object).sort()).toEqual(["pagesDone", "rowsScanned", "runId"]);
    }
  });

  it("a thrown error is logged by name only and not sent to Sentry", async () => {
    const { detectionId } = await runWithCanaryDeal();
    logCalls.length = 0;
    // Break the attachments read with an error whose MESSAGE quotes the canary.
    const dbService = await import("../../services/db/learnModeDbService");
    const spy = jest.spyOn(dbService, "previewAttachments").mockImplementation(() => {
      throw new Error(`read failed near ${CANARY_ADDRESS}`);
    });
    const r = await invoke("learn:preview", { kind: "cleanup", detectionId });
    expect(r).toEqual({ success: false, error: handlers.LEARN_FAILED_ERROR });
    expect(logCalls).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logCalls)).not.toMatch(/canary/i);
    expect(logCalls[0][3]).toEqual({ channel: "learn:preview", errorName: "Error" });
    expect(sentryCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR3
// ---------------------------------------------------------------------------

const OTHER = "user-4120-other";

function seedOtherUser(): void {
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, OTHER);
}

function seedAnswers(userId: string, tag: string): void {
  run(
    `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
     VALUES (?, ?, 'run-x', ?, 'somewhere', 'yes', '2026-11-01T00:00:00Z', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    `dla-${tag}`,
    userId,
    `key-${tag}`,
  );
  run(
    `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, answered_at, rule_version, created_at, updated_at)
     VALUES (?, ?, 'gmail', ?, '2026-11-01T00:00:00Z', 'skip', '2026-11-01T00:00:00Z', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    `lba-${tag}`,
    userId,
    `ext-${tag}`,
  );
  run(
    `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, answered_at, rule_version, created_at, updated_at)
     VALUES (?, ?, 'gmail', ?, '2026-11-01T00:00:00Z', NULL, NULL, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    `lbu-${tag}`,
    userId,
    `ext-u-${tag}`,
  );
}

function liveCounts(userId: string): { deal: number; bulk: number } {
  return {
    deal: (db.prepare(`SELECT COUNT(*) AS n FROM learn_deal_answers WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as { n: number }).n,
    bulk: (db.prepare(`SELECT COUNT(*) AS n FROM learn_bulk_answers WHERE user_id = ? AND deleted_at IS NULL`).get(userId) as { n: number }).n,
  };
}

describe("DEL delete answers is ungated (founder, 2026-11-04)", () => {
  it.each([
    { label: "toggle OFF, key absent (production map)", toggle: false, evalState: "absent" as EvalState },
    { label: "toggle ON, key disabled", toggle: true, evalState: "disabled" as EvalState },
    { label: "toggle OFF, plan unreadable", toggle: false, evalState: "unreadable" as EvalState },
    { label: "toggle ON, key allowed", toggle: true, evalState: "allowed" as EvalState },
  ])("$label: the caller's answers are soft-removed, another user's are untouched", async ({ toggle, evalState }) => {
    seedOtherUser();
    setToggle(toggle);
    planMap(evalState, true);
    seedAnswers(USER, "u");
    seedAnswers(OTHER, "o");

    const r = await invoke("learn:delete-answers");
    expect(r).toEqual({ success: true, removed: { deal: 1, bulk: 2 } });
    expect(liveCounts(USER)).toEqual({ deal: 0, bulk: 0 });
    expect(liveCounts(OTHER)).toEqual({ deal: 1, bulk: 2 });
    // Soft: every row is still on disk.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learn_deal_answers`).get() as { n: number }).n).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learn_bulk_answers`).get() as { n: number }).n).toBe(4);
  });

  it("get-state reports the saved-answer count whatever the toggle and the key say", async () => {
    seedOtherUser();
    setToggle(false);
    planMap("absent", false);
    seedAnswers(USER, "u");
    seedAnswers(OTHER, "o");
    expect(await invoke("learn:get-state")).toEqual({
      success: true,
      available: false,
      enabled: false,
      answers: { deal: 1, bulk: 1 },
    });
    await invoke("learn:delete-answers");
    expect(await invoke("learn:get-state")).toEqual({
      success: true,
      available: false,
      enabled: false,
      answers: { deal: 0, bulk: 0 },
    });
  });
});

describe("CN cleanup-next: skip for now", () => {
  function seedDeal(address: string, sentAt: string): void {
    seedEmail({
      sentAt,
      subject: "Offer accepted",
      body: `Offer accepted on ${address}. Closing next month, escrow opened.`,
    });
  }

  it("an excluded detection is passed over; nothing is stored; without the list it comes back", async () => {
    setToggle(true);
    seedDeal("4120 Canarytest Lane, Testville, ZZ 00000", "2026-10-01T10:00:00.000Z");
    seedDeal("4121 Canarytest Lane, Testville, ZZ 00000", "2026-10-03T10:00:00.000Z");
    expect((await invoke("learn:run", { windowMonths: 12 })).success).toBe(true);

    const first = (await invoke("learn:cleanup-next")).question as { detectionId: string };
    const second = (await invoke("learn:cleanup-next", { exclude: [first.detectionId] })).question as {
      detectionId: string;
    };
    expect(second.detectionId).not.toBe(first.detectionId);
    expect(await invoke("learn:cleanup-next", { exclude: [first.detectionId, second.detectionId] })).toEqual({
      success: true,
      question: null,
    });
    expect(((await invoke("learn:cleanup-next")).question as { detectionId: string }).detectionId).toBe(
      first.detectionId,
    );
    expect(liveCounts(USER).deal).toBe(0);
  });

  it("a malformed exclude list is refused", async () => {
    setToggle(true);
    expect(await invoke("learn:cleanup-next", { exclude: ["not-a-detection"] })).toEqual({
      success: false,
      error: handlers.LEARN_INVALID_ERROR,
    });
  });
});

describe("AT the one attachment a cleanup question is about", () => {
  type OpenFn = NonNullable<import("../learnModeHandlers").LearnModeHandlerDeps["openQuestionAttachment"]>;
  const openCalls: Array<{ userId: string; id: string }> = [];
  const fakeOpen: OpenFn = async (userId, row) => {
    openCalls.push({ userId, id: row.id });
    return { ok: true, dataUrl: "data:application/pdf;base64,AAAA", downloadedNow: row.storage_path === null };
  };

  function withDownloader(): void {
    openCalls.length = 0;
    handlers.registerLearnModeHandlers({ openQuestionAttachment: fakeOpen });
  }

  function seedAttachmentTyped(emailId: string, id: string, filename: string, mime: string | null): void {
    run(
      `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, storage_path) VALUES (?, ?, ?, ?, 1234, NULL)`,
      id,
      emailId,
      filename,
      mime,
    );
  }

  /** Two messages about one deal (older + newer), a second deal, and OTHER's attachment. */
  async function seedTwoDeals(): Promise<{ deal: string; otherDeal: string }> {
    setToggle(true);
    const older = seedEmail({ sentAt: "2026-10-01T10:00:00.000Z", subject: "Offer accepted", body: CANARY_BODY });
    const newer = seedEmail({
      sentAt: "2026-10-05T10:00:00.000Z",
      subject: "Counter offer",
      body: `Counter offer on ${CANARY_ADDRESS}. Escrow opened, closing next month.`,
    });
    seedAttachmentTyped(older, "att-old-pdf", "Older agreement.pdf", "application/pdf");
    seedAttachmentTyped(newer, "att-new-jpg", "Photo.jpg", "image/jpeg");
    seedAttachmentTyped(newer, "att-new-pdf", "Newer agreement.pdf", "application/pdf");
    seedAttachmentTyped(newer, "att-new-pdf2", "Zz addendum.pdf", "application/pdf");
    const otherDealEmail = seedEmail({
      sentAt: "2026-10-07T10:00:00.000Z",
      subject: "Offer accepted",
      body: "Offer accepted on 77 Canarytest Road, Testville, ZZ 00000. Closing next month, escrow opened.",
    });
    seedAttachmentTyped(otherDealEmail, "att-other-deal", "Other deal.pdf", "application/pdf");
    seedOtherUser();
    run(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, body_plain, has_attachments)
       VALUES ('e-other', ?, 'ext-o', 'gmail', 'acct-o', 'x', 'a@example.test', 'b@example.test', '2026-10-02T10:00:00.000Z', 'x', 1)`,
      OTHER,
    );
    seedAttachmentTyped("e-other", "att-other-user", "Theirs.pdf", "application/pdf");

    const r = await invoke("learn:run", { windowMonths: 12 });
    expect(r.success).toBe(true);
    const ids = (r.summary as { detectionIds: string[] }).detectionIds;
    expect(ids).toHaveLength(2);
    // Which detection is which: ask the preview.
    const p1 = await invoke("learn:preview", { kind: "cleanup", detectionId: ids[0] });
    const hasCanary = (p1.emails as Array<{ id: string }>).some((e) => e.id === older || e.id === newer);
    return hasCanary ? { deal: ids[0], otherDeal: ids[1] } : { deal: ids[1], otherDeal: ids[0] };
  }

  it("the preview names the first PDF of the NEWEST message; bulk previews name none", async () => {
    withDownloader();
    const { deal, otherDeal } = await seedTwoDeals();
    const p = await invoke("learn:preview", { kind: "cleanup", detectionId: deal });
    expect(p.questionAttachmentId).toBe("att-new-pdf");
    const q = await invoke("learn:preview", { kind: "cleanup", detectionId: otherDeal });
    expect(q.questionAttachmentId).toBe("att-other-deal");
    expect(openCalls).toEqual([]);
  });

  it("opening it calls the downloader exactly once, for that id and this user", async () => {
    withDownloader();
    const { deal } = await seedTwoDeals();
    openCalls.length = 0;
    const r = await invoke("learn:attachment-open", { detectionId: deal, attachmentId: "att-new-pdf" });
    expect(r).toEqual({ success: true, dataUrl: "data:application/pdf;base64,AAAA", downloadedNow: true });
    expect(openCalls).toEqual([{ userId: USER, id: "att-new-pdf" }]);
  });

  it.each([
    ["a sibling PDF on the same message", "att-new-pdf2"],
    ["a non-PDF sibling", "att-new-jpg"],
    ["the older message's PDF", "att-old-pdf"],
    ["another detection's attachment", "att-other-deal"],
    ["another user's attachment", "att-other-user"],
    ["an unknown id", "att-nope"],
  ])("%s is refused with 0 downloader calls", async (_label, attachmentId) => {
    withDownloader();
    const { deal } = await seedTwoDeals();
    openCalls.length = 0;
    expect(await invoke("learn:attachment-open", { detectionId: deal, attachmentId })).toEqual({
      success: false,
      error: handlers.LEARN_NOT_IN_SET_ERROR,
    });
    expect(openCalls).toEqual([]);
  });

  it("preview, cleanup-next, sample-draw, sample-next and score never download", async () => {
    withDownloader();
    const { deal, otherDeal } = await seedTwoDeals();
    await invoke("learn:cleanup-next");
    await invoke("learn:cleanup-next", { exclude: [deal] });
    await invoke("learn:preview", { kind: "cleanup", detectionId: deal });
    await invoke("learn:preview", { kind: "cleanup", detectionId: otherDeal });
    await invoke("learn:sample-draw", { windowMonths: 12 });
    const next = (await invoke("learn:sample-next")).question as { rowId: string } | null;
    if (next) await invoke("learn:preview", { kind: "bulk", rowId: next.rowId });
    await invoke("learn:score");
    expect(openCalls).toEqual([]);
    // and nothing on disk changed
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE storage_path IS NOT NULL`).get() as { n: number }).n,
    ).toBe(0);
  });

  it("with no downloader wired, the one attachment is reported unavailable", async () => {
    const { deal } = await seedTwoDeals();
    expect(await invoke("learn:attachment-open", { detectionId: deal, attachmentId: "att-new-pdf" })).toEqual({
      success: false,
      error: handlers.LEARN_ATTACHMENT_UNAVAILABLE_ERROR,
    });
  });
});
