/**
 * @jest-environment node
 *
 * BACKLOG-3339 slice T — the deal-screen toggles write their audit entry in the
 * same database transaction as the change, through the REAL handlers:
 * hide / unhide a text from the export, restore a party to a deal, add / remove
 * a checklist.
 *
 * REAL driver (better-sqlite3-multiple-ciphers), REAL shipped schema (CHECK,
 * foreign keys, the audit immutability triggers), REAL handlers
 * (`hiddenTextHandlers`, `transactionCrudHandlers`, `checklistHandlers`), REAL
 * `databaseService`, db services, `auditService` and `auditLogDbService`.
 * Mocked: the IPC registry, Sentry, the application log, the cloud (a fake that
 * records what would be sent), the plan checks (allowed), the cloud template
 * listing, and side services the handlers register but these channels do not
 * use.
 *
 * Per site:
 *   K0  success: the change, its answer, and exactly one success entry.
 *   K1  the audit INSERT fails (a real BEFORE INSERT trigger, success rows
 *       only): the change is absent, ONE failure entry `audit_entry_not_written`,
 *       and the user gets the fixed "not ..." message.
 *   K2  a crash between the change and its entry: both absent.
 *   K3  the change itself fails (a real trigger): unchanged, one failure entry
 *       `change_failed:SqliteError`, the original error.
 *   K4  a no-op (already hidden, nothing hidden, party already on the deal,
 *       template already on the deal, checklist gone): the existing answer, the
 *       state unchanged, and NO entry. K4b: hide of a text that is not part of
 *       the deal.
 *   W   every write runs inside ONE top-level transaction, the entry last, and
 *       the number of writes is exactly the site's measured N.
 *   S   crash sweep: for each k in 1..N (N fixed per site, asserted by W), the
 *       k-th write throws. Nothing survives, no success entry, one failure entry.
 *   G   the deal is not there: today's answer, nothing written.
 *   C1  the committed entry reaches the cloud with the 60 s interval off.
 *   M   the 9 cancel messages (5 here, 4 from slice C), pinned as literals.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/__tests__/dealToggleAuditInTransaction-3339.test.ts
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
  shell: { openExternal: jest.fn() },
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
jest.mock("../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/messagesSyncTrigger", () => ({
  triggerMessagesSyncInBackground: jest.fn(),
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
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
jest.mock("../services/contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));
jest.mock("../services/supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));
// The plan allows both features here: the only thing under test is the audit.
jest.mock("../handlers/featureGateHandlers", () => ({
  isHideFromExportAllowed: jest.fn().mockResolvedValue(true),
  isChecklistsAllowed: jest.fn().mockResolvedValue(true),
  resolveOrgIdOrRefusal: jest.fn().mockResolvedValue({ status: "member", organizationId: "org-3339t" }),
}));
// Two templates: one with 2 items (N = 4 writes) and one with none (N = 2).
jest.mock("../services/checklistTemplateService", () => ({
  __esModule: true,
  default: {
    listTemplates: jest.fn().mockResolvedValue({
      source: "cloud",
      templates: [
        {
          id: "33390000-0000-4000-8000-0000000000f1", // pii-allow-uuid: invented fixture id
          name: "Purchase",
          items: [
            { title: "A", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 0 },
            { title: "B", description: null, isRequired: false, expectedDocumentType: null, sortOrder: 1 },
          ],
        },
        {
          id: "33390000-0000-4000-8000-0000000000f0", // pii-allow-uuid: invented fixture id
          name: "Empty",
          items: [],
        },
      ],
    }),
  },
}));

import { auditService, type AuditLogEntry } from "../services/auditService";
import databaseService from "../services/databaseService";
import { registerHiddenTextHandlers, HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR } from "../handlers/hiddenTextHandlers";
import { registerChecklistHandlers } from "../handlers/checklistHandlers";
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { DEAL_TOGGLE_AUDIT_NOT_SAVED_MESSAGE, type DealToggleKind } from "../services/dealToggleAudit";
import { CONTACT_AUDIT_NOT_SAVED_MESSAGE } from "../services/contactChangeAudit";
import { getRawDatabase } from "../services/db/core/dbConnection";
import { openAuditProbeDb, realAuditDb, settle } from "../services/db/__tests__/fixtures/auditTxProbe";

// Real UUIDs: the handlers' validators reject anything else. Invented.
const USER = "33390000-0000-4000-8000-0000000000a7"; // pii-allow-uuid: invented fixture id
const DEAL = "33390000-0000-4000-8000-0000000000b7"; // pii-allow-uuid: invented fixture id
const GONE = "33390000-0000-4000-8000-0000000000e7"; // pii-allow-uuid: invented fixture id
const DANA = "33390000-0000-4000-8000-0000000000d7"; // pii-allow-uuid: invented fixture id
const CL = "33390000-0000-4000-8000-0000000000c7"; // pii-allow-uuid: invented fixture id
const TEMPLATE_2 = "33390000-0000-4000-8000-0000000000f1"; // pii-allow-uuid: invented fixture id
const TEMPLATE_0 = "33390000-0000-4000-8000-0000000000f0"; // pii-allow-uuid: invented fixture id

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

function resetAuditService(): void {
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.localInsertFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  svc.kickScheduled = false;
  svc.databaseService = null;
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
}

beforeAll(() => {
  registerHiddenTextHandlers();
  registerChecklistHandlers();
  registerTransactionCrudHandlers(null as never);
});

beforeEach(() => {
  db = openAuditProbeDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner-3339t@example.test', 'google', 'oauth-3339-t')",
  ).run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Fixture Way')").run(DEAL, USER);
  // A linked text (m1) and a text that is NOT part of the deal (m2, no communications row).
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
     VALUES ('m1', ?, 'imessage', 'g1', 'inbound', 'hi', '{"from":"+15550100","to":["me"]}', 'th1', '2026-03-01T10:00:00Z')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at)
     VALUES ('m2', ?, 'imessage', 'g2', 'inbound', 'other', '{"from":"+15550101","to":["me"]}', 'th2', '2026-03-01T11:00:00Z')`,
  ).run(USER);
  db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('c1', ?, ?, 'th1')").run(USER, DEAL);
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, 'Dana Example', 'manual', 1)",
  ).run(DANA, USER);
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

const seedHidden = (): void => {
  db.prepare(
    "INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by) VALUES (?, 'm1', 'g1', ?)",
  ).run(DEAL, USER);
};
const seedParty = (removed: boolean): void => {
  db.prepare(
    "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, removed_at, removed_reason) VALUES ('tc1', ?, ?, 'buyer', ?, ?)",
  ).run(DEAL, DANA, removed ? "2026-01-01 00:00:00" : null, removed ? "user_removed" : null);
};
const seedChecklist = (templateId = TEMPLATE_2): void => {
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES (?, ?, ?, 'Purchase', 0)",
  ).run(CL, DEAL, templateId);
  db.prepare(
    "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, sort_order) VALUES ('i1', ?, 'A', 1, 0)",
  ).run(CL);
};

/** Every row the five sites can write, excluding the audit log. */
function changeState(): Record<string, unknown[]> {
  const q = (sql: string) => db.prepare(sql).all();
  return {
    hidden: q("SELECT transaction_id, message_id, message_external_id, hidden_by FROM transaction_hidden_texts ORDER BY 1, 2"),
    parties: q("SELECT id, transaction_id, contact_id, removed_at, removed_reason FROM transaction_contacts ORDER BY id"),
    checklists: q("SELECT id, transaction_id, template_id, template_name FROM transaction_checklists ORDER BY id"),
    items: q("SELECT checklist_id, title, is_required, sort_order FROM transaction_checklist_items ORDER BY checklist_id, sort_order"),
  };
}

type Row = {
  action: string;
  resource_id: string | null;
  user_id: string;
  success: number;
  error_message: string | null;
  reason: string | null;
};
function entries(): Row[] {
  return db
    .prepare(
      `SELECT action, resource_id, user_id, success, error_message,
              json_extract(metadata, '$.reason') AS reason
         FROM audit_logs ORDER BY timestamp, rowid`,
    )
    .all() as Row[];
}

function failSuccessEntries(): void {
  db.exec(
    `CREATE TRIGGER k1_fail_entry BEFORE INSERT ON audit_logs WHEN NEW.success = 1
     BEGIN SELECT RAISE(ABORT, 'forced audit insert failure'); END`,
  );
}

/**
 * Instruments the real connection: every `Statement.run` is counted with the
 * transaction state at that moment. With `failAt = k`, the k-th run throws once
 * (later runs, such as the failure entry, go through).
 */
function instrumentWrites(failAt?: number): {
  writes: Array<{ sql: string; inTx: boolean }>;
  outerTransactions: number;
} {
  const log = { writes: [] as Array<{ sql: string; inTx: boolean }>, outerTransactions: 0 };
  const realTransaction = db.transaction.bind(db);
  jest.spyOn(db, "transaction").mockImplementation(((fn: (...a: unknown[]) => unknown) => {
    const wrapped = realTransaction(fn) as unknown as (...a: unknown[]) => unknown;
    return (...a: unknown[]) => {
      if (!db.inTransaction) log.outerTransactions++;
      return wrapped(...a);
    };
  }) as never);
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

function stopInstrumenting(): void {
  (db.prepare as unknown as jest.Mock).mockRestore?.();
  (db.transaction as unknown as jest.Mock).mockRestore?.();
}

// ---------------------------------------------------------------------------
// The sites, as data.
// ---------------------------------------------------------------------------

interface Site {
  name: string;
  kind: DealToggleKind;
  reason: string;
  /** Writes the handler makes on success, the audit entry included (measured). */
  n: number;
  seed: () => void;
  call: () => Promise<any>;
  /** The answer on success. */
  answer: Record<string, unknown>;
  /** A trigger that makes the change itself fail. */
  failChange: string;
  noop: { seed: () => void; answer: Record<string, unknown> };
}

const fail = (when: string, table: string): string =>
  `CREATE TRIGGER k3 BEFORE ${when} ON ${table} BEGIN SELECT RAISE(ABORT, 'forced change failure'); END`;

const SITES: Site[] = [
  {
    name: "hide",
    kind: "hide",
    reason: "text_hidden_from_export",
    n: 2,
    seed: () => undefined,
    call: () => invoke("transactions:hide-text-from-export", DEAL, "m1"),
    answer: { success: true, hidden: true },
    failChange: fail("INSERT", "transaction_hidden_texts"),
    noop: { seed: seedHidden, answer: { success: true, hidden: true } },
  },
  {
    name: "unhide",
    kind: "unhide",
    reason: "text_unhidden_from_export",
    n: 2,
    seed: seedHidden,
    call: () => invoke("transactions:unhide-text-from-export", DEAL, "m1"),
    answer: { success: true, hidden: false },
    failChange: fail("DELETE", "transaction_hidden_texts"),
    noop: { seed: () => undefined, answer: { success: true, hidden: false } },
  },
  {
    name: "restore-contact",
    kind: "restoreContact",
    reason: "contact_restore",
    n: 2,
    seed: () => seedParty(true),
    call: () => invoke("transactions:restore-contact", DEAL, DANA),
    answer: { success: true, restored: true, restoredCount: 1 },
    failChange: fail("UPDATE", "transaction_contacts"),
    noop: { seed: () => seedParty(false), answer: { success: true, restored: false, restoredCount: 0 } },
  },
  {
    name: "add-checklist (2 items)",
    kind: "addChecklist",
    reason: "checklist_selected",
    n: 4,
    seed: () => undefined,
    call: () => invoke("checklists:select-template", { transactionId: DEAL, templateId: TEMPLATE_2 }),
    answer: { success: true, result: { status: "added", checklistId: expect.any(String) } },
    // The second write fails: the checklist row written before it must go too.
    failChange: fail("INSERT", "transaction_checklist_items"),
    noop: {
      seed: () => seedChecklist(TEMPLATE_2),
      answer: { success: true, result: { status: "exists", checklistId: CL } },
    },
  },
  {
    name: "add-checklist (0 items)",
    kind: "addChecklist",
    reason: "checklist_selected",
    n: 2,
    seed: () => undefined,
    call: () => invoke("checklists:select-template", { transactionId: DEAL, templateId: TEMPLATE_0 }),
    answer: { success: true, result: { status: "added", checklistId: expect.any(String) } },
    failChange: fail("INSERT", "transaction_checklists"),
    noop: {
      seed: () => seedChecklist(TEMPLATE_0),
      answer: { success: true, result: { status: "exists", checklistId: CL } },
    },
  },
  {
    name: "remove-checklist",
    kind: "removeChecklist",
    reason: "checklist_removed",
    n: 2,
    seed: () => seedChecklist(),
    call: () => invoke("checklists:remove", { transactionId: DEAL, checklistId: CL }),
    answer: { success: true, changed: true },
    failChange: fail("DELETE", "transaction_checklists"),
    noop: { seed: () => undefined, answer: { success: true, changed: false } },
  },
];

const successEntry = (s: Site): Row => ({
  action: "TRANSACTION_UPDATE",
  resource_id: DEAL,
  user_id: USER,
  success: 1,
  error_message: null,
  reason: s.reason,
});
const failureEntry = (s: Site, code: string): Row => ({
  action: "TRANSACTION_UPDATE",
  resource_id: DEAL,
  user_id: USER,
  success: 0,
  error_message: code,
  reason: s.reason,
});

test("R0 the real driver, the shipped schema and every handler are under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get(),
  ).toEqual({ n: 1 });
  for (const ch of [
    "transactions:hide-text-from-export",
    "transactions:unhide-text-from-export",
    "transactions:restore-contact",
    "checklists:select-template",
    "checklists:remove",
  ]) {
    expect(registeredHandlers.has(ch)).toBe(true);
  }
});

describe.each(SITES)("$name", (site) => {
  test("K0 the change, its answer, and exactly one success entry", async () => {
    site.seed();
    const before = changeState();
    const res = await site.call();
    expect(res).toEqual(site.answer);
    expect(changeState()).not.toEqual(before);
    await settle();
    expect(entries()).toEqual([successEntry(site)]);
  });

  test("K1 a failed entry cancels the change, records the attempt, and says so", async () => {
    site.seed();
    const before = changeState();
    failSuccessEntries();
    const res = await site.call();
    expect(res).toEqual({ success: false, error: DEAL_TOGGLE_AUDIT_NOT_SAVED_MESSAGE[site.kind] });
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([failureEntry(site, "audit_entry_not_written")]);
  });

  test("K2 a crash between the change and its entry leaves neither", async () => {
    site.seed();
    const before = changeState();
    const spy = jest.spyOn(auditService, "recordInTransaction").mockImplementation(() => {
      throw new Error("simulated crash between change and audit entry");
    });
    const res = await site.call();
    expect(spy).toHaveBeenCalledTimes(1);
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
    expect(entries()).toEqual([failureEntry(site, "change_failed:SqliteError")]);
  });

  test("K4 a no-op gives the existing answer, changes nothing and writes no entry", async () => {
    site.noop.seed();
    const before = changeState();
    const res = await site.call();
    expect(res).toEqual(site.noop.answer);
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([]);
  });

  test(`W every write is inside ONE top-level transaction, the entry last, N = ${site.n}`, async () => {
    site.seed();
    const log = instrumentWrites();
    const res = await site.call();
    // Before settle(): the after-commit cloud send marks the row synced, which
    // is a write of its own and not part of the change.
    const writes = log.writes.slice();
    const outer = log.outerTransactions;
    stopInstrumenting();
    await settle();
    expect(res).toEqual(site.answer);
    expect(writes.map((w) => w.inTx)).toEqual(new Array(writes.length).fill(true));
    expect(outer).toBe(1);
    expect(writes[writes.length - 1].sql).toMatch(/INSERT INTO audit_logs/i);
    // The sweep below runs k = 1..site.n. A write added or lost reds HERE
    // instead of silently widening or shrinking the sweep.
    expect(writes.length).toBe(site.n);
  });

  test.each(Array.from({ length: site.n }, (_, i) => i + 1))(
    "S crash sweep: write %i of N fails, nothing survives",
    async (k) => {
      site.seed();
      const before = changeState();
      const spy = instrumentWrites(k);
      const res = await site.call();
      const fired = spy.writes.length >= k;
      stopInstrumenting();
      await settle();
      expect(fired).toBe(true);
      expect(res.success).toBe(false);
      expect(changeState()).toEqual(before);
      expect(entries().filter((e) => e.success === 1)).toEqual([]);
      expect(entries().filter((e) => e.success === 0)).toHaveLength(1);
    },
  );

  test("C1 the committed entry reaches the cloud with no interval running", async () => {
    site.seed();
    await site.call();
    await settle();
    expect(
      uploads.flat().map((e) => [e.action, e.resourceId, (e.metadata as Record<string, unknown>)?.reason]),
    ).toEqual([["TRANSACTION_UPDATE", DEAL, site.reason]]);
  });
});

describe("K4b hide of a text that is not part of this deal", () => {
  test("is refused, changes nothing and writes no entry", async () => {
    const before = changeState();
    const res = await invoke("transactions:hide-text-from-export", DEAL, "m2");
    expect(res).toEqual({ success: false, hidden: false, error: HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR });
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([]);
  });
});

describe("G the deal is not there", () => {
  test.each([
    ["hide", () => invoke("transactions:hide-text-from-export", GONE, "m1"), { success: false, error: "Transaction not found" }],
    ["unhide", () => invoke("transactions:unhide-text-from-export", GONE, "m1"), { success: false, error: "Transaction not found" }],
    ["restore-contact", () => invoke("transactions:restore-contact", GONE, DANA), { success: false, error: "Transaction not found" }],
    [
      "add-checklist",
      () => invoke("checklists:select-template", { transactionId: GONE, templateId: TEMPLATE_2 }),
      { success: true, result: { status: "no_transaction" } },
    ],
    ["remove-checklist", () => invoke("checklists:remove", { transactionId: GONE, checklistId: CL }), { success: true, changed: false }],
  ] as const)("%s: today's answer, nothing written", async (_name, call, answer) => {
    const before = changeState();
    const res = await call();
    expect(res).toEqual(answer);
    expect(changeState()).toEqual(before);
    await settle();
    expect(entries()).toEqual([]);
  });
});

describe("M the cancel messages, as literals", () => {
  test("the 5 deal-toggle and 4 contact messages are exactly these", () => {
    expect({
      ...Object.fromEntries(Object.entries(DEAL_TOGGLE_AUDIT_NOT_SAVED_MESSAGE).map(([k, v]) => [`toggle.${k}`, v])),
      ...Object.fromEntries(Object.entries(CONTACT_AUDIT_NOT_SAVED_MESSAGE).map(([k, v]) => [`contact.${k}`, v])),
    }).toEqual({
      "toggle.hide":
        "The text was not hidden from the export because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "toggle.unhide":
        "The text was not put back into the export because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "toggle.restoreContact":
        "The contact was not restored to this deal because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "toggle.addChecklist":
        "The checklist was not added because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "toggle.removeChecklist":
        "The checklist was not removed because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "contact.save":
        "The contact was not saved because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "contact.remove":
        "The contact was not removed because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "contact.restore":
        "The contact was not restored because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
      "contact.phoneType":
        "Your phone type was not saved because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
    });
  });
});
