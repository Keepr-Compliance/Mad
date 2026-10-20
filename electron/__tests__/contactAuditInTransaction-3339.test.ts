/**
 * @jest-environment node
 *
 * BACKLOG-3339 slice C — contact create / edit / remove / restore and the
 * phone-type save write their audit entry in the same database transaction
 * as the change, through the REAL handlers.
 *
 * REAL driver (better-sqlite3-multiple-ciphers), REAL shipped schema (CHECK,
 * foreign keys, the audit immutability triggers), REAL handlers
 * (`contactHandlers`, `userSettingsHandlers`), REAL `databaseService`,
 * `contactDbService`, `userDbService`, `auditService` and `auditLogDbService`.
 * Mocked: the IPC registry, Sentry, the application log, the cloud (a fake
 * that records what would be sent), and side services the handlers register
 * but these channels do not use.
 *
 * Per site:
 *   K0  success: the change and exactly one success entry.
 *   K1  the audit INSERT fails (a real BEFORE INSERT trigger, success rows
 *       only): the change is absent, ONE failure entry with a fixed code, and
 *       the user gets the fixed "not saved" message.
 *   K2  a crash between the change and its entry (the entry call throws after
 *       the change was written): both absent.
 *   K3  the change itself fails (a real trigger): no change, one failure
 *       entry `change_failed:SqliteError`, the original error.
 *   W   every write the handler makes runs inside one open transaction
 *       (measured on the real connection), and the count of those writes is N.
 *   S   crash sweep: for k = 1..N, the k-th write throws. Nothing the handler
 *       wrote survives, and no success entry exists.
 *   G   edit / remove / restore of a contact that is not there: refused with
 *       "This contact no longer exists.", nothing written.
 *   U   phone type with the audit service not initialised: cancelled, the
 *       setting is unchanged.
 *   C1  the committed entry reaches the cloud with the 60 s interval off.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/__tests__/contactAuditInTransaction-3339.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Database as DatabaseType } from "better-sqlite3";
import type { IpcMainInvokeEvent } from "electron";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(),
  Notification: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data"), getVersion: jest.fn(() => "0.0.0-test") },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn() },
}));
// The edit handler starts a review-queue re-scan after the save (not awaited).
jest.mock("../services/reviewStateService", () => ({
  syncReviewQueueForTransaction: jest.fn().mockResolvedValue(undefined),
}));
// userSettingsHandlers registers these siblings; none is on the phone-type path.
jest.mock("../handlers/systemHandlers", () => ({ ensureUserInLocalDb: jest.fn() }));
jest.mock("../handlers/accountSetupHandlers", () => ({ registerAccountSetupHandlers: jest.fn() }));
jest.mock("../handlers/tourStateHandlers", () => ({ registerTourStateHandlers: jest.fn() }));
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(), syncPreferences: jest.fn() },
}));

import { auditService, type AuditLogEntry } from "../services/auditService";
import databaseService from "../services/databaseService";
import { registerContactHandlers } from "../handlers/contactHandlers";
import { registerUserSettingsHandlers } from "../handlers/userSettingsHandlers";
import {
  CONTACT_AUDIT_NOT_SAVED_MESSAGE,
  CONTACT_NO_LONGER_EXISTS_MESSAGE,
} from "../services/contactChangeAudit";
import { getRawDatabase } from "../services/db/core/dbConnection";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../services/db/contactIdentitySchemaSql";
import { openAuditProbeDb, realAuditDb, settle } from "../services/db/__tests__/fixtures/auditTxProbe";

// Real UUIDs: the handlers' validators reject anything else. Invented.
const USER = "33390000-0000-4000-8000-0000000000c1"; // pii-allow-uuid: invented fixture id
const DANA = "33390000-0000-4000-8000-0000000000d1"; // pii-allow-uuid: invented fixture id
const GONE = "33390000-0000-4000-8000-0000000000e1"; // pii-allow-uuid: invented fixture id

let db: DatabaseType;
let uploads: AuditLogEntry[][];

const fakeCloud = {
  getAuthSession: async () => ({ userId: USER }),
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    uploads.push(entries.map((e) => ({ ...e })));
  },
};

const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]): Promise<any> => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};

function resetAuditService(init = true): void {
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.localInsertFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  // Before `initialize`, the service holds no database (the production state
  // before `initializeDatabase` has run).
  svc.databaseService = null;
  if (init) {
    auditService.setSupportAccessGate(null);
    auditService.initialize(realAuditDb as never, fakeCloud as never);
    auditService.stopSyncInterval();
  }
}

beforeAll(() => {
  registerContactHandlers({} as never);
  registerUserSettingsHandlers();
});

beforeEach(() => {
  db = openAuditProbeDb();
  db.exec("PRAGMA foreign_keys = ON");
  const hasLinks = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'contact_source_links'")
    .get() as { n: number };
  if (hasLinks.n === 0) db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-3339c@example.test", "oauth-3339-c");
  jest.spyOn(databaseService, "getRawDatabase").mockImplementation(() => getRawDatabase() as never);
  jest.spyOn(databaseService, "isInitialized").mockImplementation(() => true);
  uploads = [];
  resetAuditService();
});

afterEach(async () => {
  jest.restoreAllMocks();
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

// ---------------------------------------------------------------------------
// helpers — every read is raw SQL, never the code under test
// ---------------------------------------------------------------------------

function seedContact(opts: { removed?: boolean } = {}): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported, removed_at, removed_reason) VALUES (?, ?, 'Dana Example', 'manual', 1, ?, ?)",
  ).run(DANA, USER, opts.removed ? "2026-01-01 00:00:00" : null, opts.removed ? "user_unimported" : null);
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('em-dana', ?, 'dana@example.com', 1)",
  ).run(DANA);
}

/** Every row the contact sites can write, excluding the audit log. */
function changeState(): Record<string, unknown[]> {
  const q = (sql: string) => db.prepare(sql).all();
  return {
    contacts: q("SELECT id, user_id, display_name, company, title, source, is_imported, removed_at, removed_reason FROM contacts ORDER BY id"),
    emails: q("SELECT contact_id, email, is_primary, source FROM contact_emails ORDER BY contact_id, email"),
    phones: q("SELECT contact_id, phone_e164, is_primary, source FROM contact_phones ORDER BY contact_id, phone_e164"),
    links: q("SELECT * FROM contact_source_links ORDER BY 1"),
    users: q("SELECT id, mobile_phone_type FROM users_local ORDER BY id"),
  };
}

type Row = { action: string; resource_id: string | null; user_id: string; success: number; error_message: string | null };
function entries(): Row[] {
  return db
    .prepare("SELECT action, resource_id, user_id, success, error_message FROM audit_logs ORDER BY timestamp, rowid")
    .all() as Row[];
}

function failSuccessEntries(): void {
  db.exec(
    `CREATE TRIGGER k1_fail_entry BEFORE INSERT ON audit_logs WHEN NEW.success = 1
     BEGIN SELECT RAISE(ABORT, 'forced audit insert failure'); END`,
  );
}

function crashAtEntry(): void {
  jest.spyOn(auditService, "recordInTransaction").mockImplementation(() => {
    throw new Error("simulated crash between change and audit entry");
  });
}

/**
 * Instruments the real connection: every `Statement.run` is counted and the
 * transaction state at that moment recorded. With `failAt = k`, the k-th run
 * throws once (later runs, such as the failure entry, go through).
 */
function instrumentWrites(failAt?: number): { writes: Array<{ sql: string; inTx: boolean }> } {
  const log: { writes: Array<{ sql: string; inTx: boolean }> } = { writes: [] };
  const realPrepare = db.prepare.bind(db);
  jest.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const stmt = realPrepare(sql) as any;
    const realRun = stmt.run.bind(stmt);
    stmt.run = (...params: unknown[]) => {
      log.writes.push({ sql: sql.replace(/\s+/g, " ").trim().slice(0, 60), inTx: db.inTransaction });
      if (failAt !== undefined && log.writes.length === failAt) {
        throw new Error(`injected write failure at write ${failAt}`);
      }
      return realRun(...params);
    };
    return stmt;
  }) as never);
  return log;
}

// ---------------------------------------------------------------------------
// The five sites, as data: how to seed, how to call, what K0 must leave.
// ---------------------------------------------------------------------------

interface Site {
  name: string;
  action: string;
  kind: keyof typeof CONTACT_AUDIT_NOT_SAVED_MESSAGE;
  seed: () => void;
  call: () => Promise<any>;
  /** The resource id the success entry carries (null = known only after). */
  resourceId: string | null;
  /** A trigger that makes the change itself fail. */
  failChange: string;
}

const CREATE_INPUT = {
  name: "Robin Fixture",
  email: "robin@example.com",
  phone: "+12065550101",
  allEmails: ["robin@example.com", "robin.work@example.com"],
  allPhones: ["+12065550101", "+12065550102"],
};

const SITES: Site[] = [
  {
    name: "contacts:create",
    action: "CONTACT_CREATE",
    kind: "save",
    seed: () => undefined,
    call: () => invoke("contacts:create", USER, CREATE_INPUT),
    resourceId: null,
    failChange: "CREATE TRIGGER k3 BEFORE INSERT ON contacts BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
  },
  {
    name: "contacts:update",
    action: "CONTACT_UPDATE",
    kind: "save",
    seed: () => seedContact(),
    call: () =>
      invoke("contacts:update", DANA, {
        name: "Dana Renamed",
        company: "Fixture Co",
        title: "Agent",
        emails: [
          { email: "dana@example.com", is_primary: true },
          { email: "dana.two@example.com", is_primary: false },
        ],
        phones: [{ phone: "+12065550199", is_primary: true }],
      }),
    resourceId: DANA,
    failChange: "CREATE TRIGGER k3 BEFORE UPDATE ON contacts BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
  },
  {
    name: "contacts:remove",
    action: "CONTACT_DELETE",
    kind: "remove",
    seed: () => seedContact(),
    call: () => invoke("contacts:remove", DANA),
    resourceId: DANA,
    failChange: "CREATE TRIGGER k3 BEFORE UPDATE ON contacts BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
  },
  {
    name: "contacts:restore",
    action: "CONTACT_UPDATE",
    kind: "restore",
    seed: () => seedContact({ removed: true }),
    call: () => invoke("contacts:restore", DANA),
    resourceId: DANA,
    failChange: "CREATE TRIGGER k3 BEFORE UPDATE ON contacts BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
  },
  {
    name: "user:set-phone-type",
    action: "SETTINGS_CHANGE",
    kind: "phoneType",
    seed: () => undefined,
    call: () => invoke("user:set-phone-type", USER, "android"),
    resourceId: USER,
    failChange: "CREATE TRIGGER k3 BEFORE UPDATE ON users_local BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
  },
];

test("R0 the real driver, the shipped schema and every handler are under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get(),
  ).toEqual({ n: 1 });
  for (const s of SITES) expect(registeredHandlers.has(s.name)).toBe(true);
});

/** Measured write counts per site, filled by the W tests and used by S. */
const measured: Record<string, number> = {};

describe.each(SITES)("$name", (site) => {
  test("K0 the change and exactly one success entry", async () => {
    site.seed();
    const before = changeState();
    const res = await site.call();
    expect(res.success).toBe(true);
    expect(changeState()).not.toEqual(before);
    const rid = site.resourceId ?? res.contact.id;
    expect(entries()).toEqual([
      { action: site.action, resource_id: rid, user_id: USER, success: 1, error_message: null },
    ]);
  });

  test("K1 a failed entry cancels the change, records the attempt, and says so", async () => {
    site.seed();
    const before = changeState();
    failSuccessEntries();
    const res = await site.call();
    expect(res).toEqual({ success: false, error: CONTACT_AUDIT_NOT_SAVED_MESSAGE[site.kind] });
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([
      { action: site.action, resource_id: site.resourceId, user_id: USER, success: 0, error_message: "audit_entry_not_written" },
    ]);
  });

  test("K2 a crash between the change and its entry leaves neither", async () => {
    site.seed();
    const before = changeState();
    crashAtEntry();
    const res = await site.call();
    expect(res.success).toBe(false);
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries().filter((e) => e.success === 1)).toEqual([]);
  });

  test("K3 a failed change writes nothing and one failure entry with no raw error text", async () => {
    site.seed();
    const before = changeState();
    db.exec(site.failChange);
    const res = await site.call();
    expect(res.success).toBe(false);
    expect(res.error).toContain("forced change failure");
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([
      { action: site.action, resource_id: site.resourceId, user_id: USER, success: 0, error_message: "change_failed:SqliteError" },
    ]);
  });

  test("W every write runs inside one open transaction, the audit entry last", async () => {
    site.seed();
    const log = instrumentWrites();
    const res = await site.call();
    expect(res.success).toBe(true);
    const n = log.writes.length;
    measured[site.name] = n;
    process.stderr.write(`[3339C] ${site.name}: N=${n} writes, inTx=${JSON.stringify(log.writes.map((w) => w.inTx))}\n`);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(log.writes.map((w) => w.inTx)).toEqual(new Array(n).fill(true));
    expect(log.writes[n - 1].sql).toMatch(/INSERT INTO audit_logs/i);
  });

  test("S crash sweep: the k-th write fails, for every k in 1..N", async () => {
    const n = measured[site.name];
    expect(n).toBeGreaterThanOrEqual(2);
    for (let k = 1; k <= n; k++) {
      db.close();
      db = openAuditProbeDb();
      db.exec("PRAGMA foreign_keys = ON");
      const hasLinks = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'contact_source_links'")
        .get() as { n: number };
      if (hasLinks.n === 0) db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
      db.prepare(
        "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
      ).run(USER, "owner-3339c@example.test", "oauth-3339-c");
      resetAuditService();
      site.seed();
      const before = changeState();
      const spy = instrumentWrites(k);
      const res = await site.call();
      (db.prepare as unknown as jest.Mock).mockRestore?.();
      await settle();
      expect({ k, success: res.success }).toEqual({ k, success: false });
      expect({ k, state: changeState() }).toEqual({ k, state: before });
      expect({ k, successEntries: entries().filter((e) => e.success === 1) }).toEqual({ k, successEntries: [] });
      expect({ k, failureEntries: entries().filter((e) => e.success === 0).length }).toEqual({ k, failureEntries: 1 });
      expect(spy.writes.length).toBeGreaterThanOrEqual(k);
    }
  });

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    site.seed();
    const res = await site.call();
    await settle();
    const rid = site.resourceId ?? res.contact.id;
    expect(uploads.flat().map((e) => [e.action, e.resourceId])).toEqual([[site.action, rid]]);
  });
});

describe("G a contact that is not there", () => {
  test.each([
    ["contacts:update", () => invoke("contacts:update", GONE, { name: "Nobody" })],
    ["contacts:remove", () => invoke("contacts:remove", GONE)],
    ["contacts:restore", () => invoke("contacts:restore", GONE)],
  ])("%s is refused and writes nothing", async (_name, call) => {
    const before = changeState();
    const res = await call();
    expect(res).toEqual({ success: false, error: CONTACT_NO_LONGER_EXISTS_MESSAGE });
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([]);
  });
});

describe("restore of a contact that is already active", () => {
  test("is a successful no-op with no entry", async () => {
    seedContact();
    const res = await invoke("contacts:restore", DANA);
    expect(res).toEqual({ success: true, restored: false });
    await settle();
    expect(entries()).toEqual([]);
  });
});

describe("U phone type before the audit service is initialised", () => {
  test("is cancelled and the setting is unchanged", async () => {
    resetAuditService(false);
    const before = changeState();
    const res = await invoke("user:set-phone-type", USER, "android");
    expect(res).toEqual({ success: false, error: CONTACT_AUDIT_NOT_SAVED_MESSAGE.phoneType });
    expect(changeState()).toEqual(before);
  });
});
