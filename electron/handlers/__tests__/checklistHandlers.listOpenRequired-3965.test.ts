/**
 * @jest-environment node
 *
 * BACKLOG-3965 PR-3 — `checklists:list-open-required` end to end in main: the
 * real handler, the real Zod schema, the real db service and SQL, the real
 * `LOCKED_SUBMISSION_STATUSES`, over the real schema.sql (`openTestDb`).
 * Only the plan gate is a mock, so each test can say allowed or not.
 *
 * Harness transcribed from checklistDealLock-3910d.test.ts.
 *
 * Wrong builds this suite catches:
 *   - the handler binding the lock map's KEYS instead of the derived locked
 *     list -> every deal drops -> "lists open deals, leaves out locked" red.
 *   - BACKLOG-3966: the plan rule is per checklist. Template items listed on
 *     a plan without checklists, or the agent's own items left out there, or
 *     the read refused outright -> "plan does not include checklists" red.
 *   - a second write path, or the tick channel not refusing a locked deal ->
 *     "ticking ... through set-item-checked" red.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";

import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;
const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
  shell: { openExternal: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbExec: (sql: string) => mockDb!.exec(sql),
  dbTransaction: <T,>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
  isInitialized: () => true,
}));

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getTransactionById: (id: string) =>
      jest.requireActual("../../services/db/transactionDbService").getTransactionById(id),
  },
}));

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    }),
  },
}));

jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn(),
    recordFailure: jest.fn(),
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));

const mockGate = jest.fn(() => Promise.resolve(true));
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: () => mockGate(),
  resolveOrgIdOrRefusal: jest.fn(() =>
    Promise.resolve({ status: "member", organizationId: "org-3965" }),
  ),
}));

jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: { listTemplates: jest.fn(), invalidate: jest.fn() },
}));

import { registerChecklistHandlers } from "../checklistHandlers";
import { MY_ITEMS_TEMPLATE_ID } from "../../services/db/checklistPrivacy";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const USER = randomUUID();
const OTHER_USER = randomUUID();
const evt = {} as IpcMainInvokeEvent;

/** Every value of the schema's submission_status CHECK list, and NULL. */
const OPEN = ["not_submitted", "needs_changes", "rejected", null] as const;
const LOCKED = ["submitted", "under_review", "resubmitted", "approved"] as const;

/** deal id -> its one required, unticked item id */
const itemOf = new Map<string, string>();

function seedDeal(user: string, submission: string | null): string {
  const deal = randomUUID();
  const checklist = randomUUID();
  const item = randomUUID();
  mockDb!
    .prepare("INSERT INTO transactions (id, user_id, property_address, status) VALUES (?, ?, ?, 'active')")
    .run(deal, user, `${String(submission)} Street`);
  mockDb!.prepare("UPDATE transactions SET submission_status = ? WHERE id = ?").run(submission, deal);
  mockDb!
    .prepare(
      "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, ?, 'Standard purchase')",
    )
    .run(checklist, deal, randomUUID());
  mockDb!
    .prepare(
      "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Signed purchase agreement', 1)",
    )
    .run(item, checklist);
  itemOf.set(deal, item);
  return deal;
}

async function invoke(channel: string, payload?: unknown): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, payload);
}

let openDeals: string[];
let lockedDeals: string[];

beforeAll(() => {
  registerChecklistHandlers();
});

beforeEach(() => {
  mockGate.mockImplementation(() => Promise.resolve(true));
  mockDb = openTestDb();
  mockDb.exec("PRAGMA foreign_keys = ON");
  mockDb.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const [id, email] of [
    [USER, "owner-3965@example.com"],
    [OTHER_USER, "other-3965@example.com"],
  ]) {
    mockDb
      .prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)")
      .run(id, email, `oauth-${email}`);
  }
  openDeals = OPEN.map((s) => seedDeal(USER, s));
  lockedDeals = LOCKED.map((s) => seedDeal(USER, s));
  seedDeal(OTHER_USER, "not_submitted");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-3965 checklists:list-open-required", () => {
  it("lists open deals of every open status (NULL included), leaves out every locked one and other users'", async () => {
    const res = await invoke("checklists:list-open-required", { userId: USER });
    expect(res.success).toBe(true);
    expect(res.result.totalCount).toBe(OPEN.length);
    expect(res.result.items.map((i: any) => i.transactionId).sort()).toEqual([...openDeals].sort());
    for (const deal of lockedDeals) {
      expect(res.result.items.map((i: any) => i.transactionId)).not.toContain(deal);
    }
  });

  it("BACKLOG-3966: on a plan without checklists, answers with the agent's own items only", async () => {
    // One of the agent's own items on the first open deal, through the writer.
    const added = await invoke("checklists:add-my-item", {
      transactionId: openDeals[0],
      title: "Call the lender",
    });
    expect(added.result.status).toBe("added");
    const mine = added.result.itemId;
    expect(
      mockDb!
        .prepare("SELECT c.template_id FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id WHERE i.id = ?")
        .get(mine),
    ).toEqual({ template_id: MY_ITEMS_TEMPLATE_ID });

    mockGate.mockImplementation(() => Promise.resolve(false));
    const res = await invoke("checklists:list-open-required", { userId: USER });
    expect(res.success).toBe(true);
    // Every template item (one on each open deal) is left out; the private one stays.
    expect(res.result.items.map((i: any) => i.itemId)).toEqual([mine]);
    expect(res.result.totalCount).toBe(1);

    // The same read with the plan allowed lists both kinds.
    mockGate.mockImplementation(() => Promise.resolve(true));
    const all = await invoke("checklists:list-open-required", { userId: USER });
    expect(all.result.totalCount).toBe(OPEN.length + 1);
    expect(all.result.items.map((i: any) => i.itemId)).toContain(mine);
  });

  it("a payload without a user id is refused, not read", async () => {
    const res = await invoke("checklists:list-open-required", {});
    expect(res.success).toBe(false);
    expect(res.result).toBeUndefined();
  });

  it("honours the limit and keeps the uncapped total", async () => {
    const res = await invoke("checklists:list-open-required", { userId: USER, limit: 1 });
    expect(res.result.items).toHaveLength(1);
    expect(res.result.totalCount).toBe(OPEN.length);
  });

  it("ticking a listed item through checklists:set-item-checked takes it off; a locked deal's tick is refused", async () => {
    const before = await invoke("checklists:list-open-required", { userId: USER });
    const first = before.result.items[0];
    const tick = await invoke("checklists:set-item-checked", { itemId: first.itemId, checked: true });
    expect(tick).toEqual({ success: true, changed: true });
    const after = await invoke("checklists:list-open-required", { userId: USER });
    expect(after.result.items.map((i: any) => i.itemId)).not.toContain(first.itemId);
    expect(after.result.totalCount).toBe(before.result.totalCount - 1);

    const lockedItem = itemOf.get(lockedDeals[0])!;
    const refused = await invoke("checklists:set-item-checked", { itemId: lockedItem, checked: true });
    expect(refused.success).toBe(false);
    expect(refused.dealLocked).toBe("submitted");
  });
});
