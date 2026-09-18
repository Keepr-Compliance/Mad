/**
 * @jest-environment node
 *
 * BACKLOG-1717 — the gate in front of people found in the user's email.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * Two things have to be true before a single email address reaches a picker:
 * the customer's PLAN includes the feature, and the user's own Settings switch
 * for that mailbox is on. Both are read in the main process, both fail closed,
 * and neither is re-checked in the renderer — the renderer cannot grant what
 * main denies.
 *
 * The producer is MOCKED here on purpose. These controls are about the gate, so
 * what matters is whether the producer is called at all, and with which
 * mailboxes — which a spy can answer and a real read cannot. The producer's own
 * behaviour is controlled against the real engine in
 * `services/db/__tests__/emailDerivedContacts-1717.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATE MODULE IS MOCKED AT ITS OWN BOUNDARY
 * ---------------------------------------------------------------------------
 * `resolveContactInferenceState` bottoms out in a NETWORK read of the user's
 * org membership and plan. Mocking the module lets each case state the answer
 * it is about — including `unknown`, which is "I could not find out" and is a
 * different sentence from "not in your plan". The map that turns a provider
 * into a plan key is NOT mocked: it is the real one, so a control can assert
 * the resolver is consulted once per distinct KEY rather than once per mailbox.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

// --- the plan gate -----------------------------------------------------------
const mockResolveState = jest.fn();
jest.mock("../handlers/featureGateHandlers", () => ({
  ...(jest.requireActual("../handlers/featureGateHandlers") as object),
  resolveContactInferenceState: (...a: unknown[]) => mockResolveState(...a),
}));

// --- the user's own switches -------------------------------------------------
const mockSourceEnabled = jest.fn();
jest.mock("../utils/preferenceHelper", () => ({
  ...(jest.requireActual("../utils/preferenceHelper") as object),
  isContactSourceEnabled: (...a: unknown[]) => mockSourceEnabled(...a),
}));

// --- the producer ------------------------------------------------------------
const mockProducer = jest.fn();
jest.mock("../services/db/emailDerivedContactDbService", () => ({
  __esModule: true,
  getEmailDerivedContactsAsync: (...a: unknown[]) => mockProducer(...a),
  getMailboxAddress: jest.fn(() => "owner@example.com"),
}));

let mockShadowRows: any[] = [];

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(() => Promise.resolve({})) },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve([])),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
  },
}));

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
}));

jest.mock("../services/db/contactDbService", () => ({
  ...(jest.requireActual("../services/db/contactDbService") as object),
  getContactEmailEntries: jest.fn(() => []),
  getContactPhoneEntries: jest.fn(() => []),
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import logService from "../services/logService";

const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: invented, not from any live row
const mockEvent = {} as IpcMainInvokeEvent;

/** One address-book row, so "the rest of the picker survives" is assertable. */
const SHADOW_ROW = {
  id: "ext-1",
  user_id: USER,
  name: "Ana Whitfield",
  phones: ["+15550101"],
  emails: ["ana@example.com"],
  company: null,
  source: "macos",
  external_record_id: "rec-1",
  external_uuid: null,
  last_message_at: null,
  synced_at: "2026-09-01T00:00:00.000Z",
};

const EMAIL_PERSON = {
  id: "email_avery@example.com",
  name: "Avery Example",
  phone: null,
  email: "avery@example.com",
  company: null,
  source: "email_derived",
  allPhones: [],
  allEmails: ["avery@example.com"],
  isFromDatabase: false,
  last_communication_at: "2026-03-02T10:00:00Z",
};

const GMAIL_PERSON = { ...EMAIL_PERSON, id: "email_gina@example.com", email: "gina@example.com" };

async function getAvailable(): Promise<any> {
  const handler = registeredHandlers.get("contacts:get-available");
  expect(handler).toBeDefined(); // the channel really is registered
  return handler(mockEvent, USER);
}

const emailRows = (res: any): any[] =>
  (res.contacts ?? []).filter((c: any) => String(c.id).startsWith("email_"));

/** plan state per provider, and Settings switch per provider. */
function gate(opts: {
  plan?: "allowed" | "blocked" | "unknown" | Error;
  outlookPref?: boolean;
  gmailPref?: boolean;
}): void {
  mockResolveState.mockImplementation(() => {
    if (opts.plan instanceof Error) return Promise.reject(opts.plan);
    return Promise.resolve(opts.plan ?? "allowed");
  });
  mockSourceEnabled.mockImplementation(
    (_u: string, category: string, key: string, fallback: boolean) => {
      if (category !== "inferred") return Promise.resolve(fallback);
      if (key === "outlookEmails") return Promise.resolve(opts.outlookPref ?? true);
      if (key === "gmailEmails") return Promise.resolve(opts.gmailPref ?? true);
      return Promise.resolve(fallback);
    },
  );
}

describe("BACKLOG-1717 — the gate in front of people found in email", () => {
  beforeEach(() => {
    mockDb = openTestDb();
    mockDb.exec(CONTACT_IDENTITY_SCHEMA);
    mockShadowRows = [SHADOW_ROW];
    registeredHandlers.clear();
    jest.clearAllMocks();
    mockProducer.mockResolvedValue([EMAIL_PERSON, GMAIL_PERSON]);
    gate({});
    registerContactHandlers({} as any);
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  /** PRECONDITION — without this every control below would pass vacuously. */
  it("G0: the picker returns the address-book row the fixtures set up", async () => {
    const res = await getAvailable();
    expect(res.success).toBe(true);
    expect(res.contacts.length).toBeGreaterThan(0);
    expect(res.contacts.some((c: any) => c.id === "ext-1")).toBe(true);
  });

  /** G2 — both gates open: the people are offered. */
  it("G2: offers email people when the plan allows it and the switches are on", async () => {
    const res = await getAvailable();
    expect(emailRows(res).map((c) => c.email)).toEqual([
      "avery@example.com",
      "gina@example.com",
    ]);
  });

  /** G2b — the record shape survives the handler, asserted by value. */
  it("G2b: the rows carry the synthetic source and are not marked as saved", async () => {
    const [row] = emailRows(await getAvailable());
    expect(row.source).toBe("email_derived");
    expect(row.isFromDatabase).toBe(false);
  });

  /** G1 — plan says no: nothing, however the switches are set. */
  it("G1: offers nobody when the plan does not include the feature", async () => {
    gate({ plan: "blocked" });
    const res = await getAvailable();
    expect(emailRows(res)).toEqual([]);
    // and the rest of the picker is untouched
    expect(res.contacts.some((c: any) => c.id === "ext-1")).toBe(true);
  });

  /** G1b — and the database is not read at all. */
  it("G1b: does not even run the read when nothing is enabled", async () => {
    gate({ plan: "blocked" });
    await getAvailable();
    expect(mockProducer).not.toHaveBeenCalled();
  });

  /** G3 — flipping the gate changes the outcome. */
  it("G3: flipping the plan between two reads changes what is offered", async () => {
    gate({ plan: "allowed" });
    expect(emailRows(await getAvailable())).toHaveLength(2);
    gate({ plan: "blocked" });
    expect(emailRows(await getAvailable())).toHaveLength(0);
  });

  /** G4 — the user's own switch, both off. */
  it("G4: offers nobody when both Settings switches are off", async () => {
    gate({ outlookPref: false, gmailPref: false });
    expect(emailRows(await getAvailable())).toEqual([]);
    expect(mockProducer).not.toHaveBeenCalled();
  });

  /**
   * G4g / G1b-g — one mailbox on, one off.
   *
   * The read must cover the ON mailbox ONLY. This is the "toggle read but not
   * applied" shape: a handler that reads the Gmail preference and then hands
   * the producer both mailboxes anyway would pass a test that only checked the
   * preference was read.
   */
  it("G4g: reads only the mailbox whose switch is on", async () => {
    gate({ outlookPref: true, gmailPref: false });
    await getAvailable();
    expect(mockProducer).toHaveBeenCalledTimes(1);
    expect(mockProducer).toHaveBeenCalledWith(USER, ["outlook"]);
  });

  it("G4g: and the other way round", async () => {
    gate({ outlookPref: false, gmailPref: true });
    await getAvailable();
    expect(mockProducer).toHaveBeenCalledTimes(1);
    expect(mockProducer).toHaveBeenCalledWith(USER, ["gmail"]);
  });

  it("G1b-g: calls the read ONCE for both mailboxes, not once per mailbox", async () => {
    await getAvailable();
    expect(mockProducer).toHaveBeenCalledTimes(1);
    expect(mockProducer).toHaveBeenCalledWith(USER, ["outlook", "gmail"]);
  });

  /**
   * G-gate-key — resolve once per DISTINCT PLAN KEY.
   *
   * Every resolution is a network read. Both mailboxes share one key today, so
   * two resolutions would double the cost of every picker open for nothing. If
   * the founder ever splits the key this becomes two, with no code change.
   */
  it("G-gate-key: asks the plan once for two mailboxes on one key", async () => {
    await getAvailable();
    expect(mockResolveState).toHaveBeenCalledTimes(1);
  });

  /**
   * G5 — the gate itself failing is not permission.
   *
   * `unknown` is "I could not find out" — offline, no session, a membership
   * error. It must not open the gate, and the call must still succeed.
   */
  it("G5: offers nobody when the plan cannot be read, and still succeeds", async () => {
    gate({ plan: "unknown" });
    const res = await getAvailable();
    expect(res.success).toBe(true);
    expect(emailRows(res)).toEqual([]);
    expect(mockProducer).not.toHaveBeenCalled();
  });

  it("G5: a rejected plan read fails closed rather than throwing", async () => {
    gate({ plan: new Error("membership read failed") });
    const res = await getAvailable();
    expect(res.success).toBe(true);
    expect(emailRows(res)).toEqual([]);
    expect(res.contacts.some((c: any) => c.id === "ext-1")).toBe(true);
  });

  /**
   * G7 — a producer failure must not take the address book down with it.
   *
   * A worker timeout or a pool rejection here would otherwise reject the whole
   * handler, and the picker would show NOTHING — no macOS contacts, no Outlook
   * cards — because one optional list could not be built.
   */
  it("G7: a failed email read leaves the rest of the picker intact", async () => {
    mockProducer.mockRejectedValue(new Error("worker timed out"));
    const res = await getAvailable();
    expect(res.success).toBe(true);
    expect(emailRows(res)).toEqual([]);
    expect(res.contacts.some((c: any) => c.id === "ext-1")).toBe(true);
  });

  /**
   * Required change 11 / D6 — one reason per mailbox, and the PLAN reason is
   * the state WORD.
   *
   * `allowed | blocked | unknown` collapses to one `false` in the boolean
   * helper, and the founder's first report will be "nobody shows up". An
   * offline but entitled user told "not in your plan" has been told something
   * false about what he bought.
   */
  it("logs which of the reasons produced an empty list, per mailbox", async () => {
    gate({ plan: "unknown" });
    await getAvailable();
    const lines = (logService.info as jest.Mock).mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("No email-derived people"));
    expect(line).toBeDefined();
    expect(line).toContain("outlook: plan unknown");
    expect(line).toContain("gmail: plan unknown");
    // never an address
    expect(line).not.toContain("@");
  });

  it("names the Settings switch separately from the plan", async () => {
    gate({ plan: "allowed", outlookPref: false, gmailPref: false });
    await getAvailable();
    const lines = (logService.info as jest.Mock).mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("No email-derived people"));
    expect(line).toContain("outlook: switched off in Settings");
    expect(line).toContain("gmail: switched off in Settings");
  });

  /**
   * G6 — the other two contact reads never carry these rows.
   *
   * The producer has exactly one caller. If a future change appended email
   * people to the SAVED list instead, the picker would select a synthetic id
   * and attach a person with no contact row behind them — the BACKLOG-3194
   * shape this item exists to avoid.
   */
  it("G6: the saved-contact reads never contain an email-derived row", async () => {
    const getAll = registeredHandlers.get("contacts:get-all");
    expect(getAll).toBeDefined();
    const res = await getAll(mockEvent, USER);
    const ids = (res.contacts ?? []).map((c: any) => String(c.id));
    expect(ids.filter((id: string) => id.startsWith("email_"))).toEqual([]);
  });
});
