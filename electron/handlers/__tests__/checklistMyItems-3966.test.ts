/**
 * @jest-environment node
 *
 * BACKLOG-3966 PR-2 — THE AGENT'S OWN CHECKLIST ("My items"): its write
 * channels, the per-checklist plan rule, and what may never touch the row.
 *
 * Real handlers, real Zod schemas, real db service and SQL, over the real
 * schema.sql on the REAL driver — required by absolute path, so jest.config's
 * moduleNameMapper mock (which does not enforce UNIQUE) cannot stand in (SR
 * R9); the first test asserts `sqlite_version()`. Every private row and item
 * here is made THROUGH `checklists:add-my-item`, never INSERTed by hand, so a
 * writer that broke its own guarantees is what the assertions see. Template
 * checklists are INSERTed with the schema.sql columns (a template copy is not
 * what this suite tests). Only the plan gate and the cloud are mocks.
 *
 * Wrong implementations this suite exists to catch:
 *   - a second private row for the same deal (the insert without its
 *     ON CONFLICT clause throws UNIQUE on the second add);
 *   - a My item written `is_required = 0` (every agent count would drop it);
 *   - a My-items write that is not scoped to the private checklist (rename,
 *     remove or reorder reaching a template item);
 *   - a reorder that accepts a list that is not exactly the section's items;
 *   - the plan rule ignoring privacy (My items refused on a plan without
 *     checklists) or ignoring the plan (template items writable without it);
 *   - `checklists:get` hiding My items, the Todo list showing template items
 *     on a plan without checklists, or leaving My items out of it;
 *   - "Include it" accepted for a private group, or the outside-dates
 *     question asked of a private item;
 *   - `checklists:remove` or a review pull deleting the private row, or a
 *     pull writing into it;
 *   - a private item's title (or the reserved id) in an audit entry, which
 *     uploads (SR R4).
 *
 * RUNNER (real sqlite -> Electron ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/handlers/__tests__/checklistMyItems-3966.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import * as nodePath from "path";
import type { IpcMainInvokeEvent } from "electron";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;
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

/** Every audit call, from any of the three entry points, lands here. */
const mockAuditCalls: unknown[][] = [];
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: {
    log: (...a: unknown[]) => {
      mockAuditCalls.push(a);
      return Promise.resolve(undefined);
    },
    recordInTransaction: (...a: unknown[]) => {
      mockAuditCalls.push(a);
    },
    recordFailure: (...a: unknown[]) => {
      mockAuditCalls.push(a);
    },
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));

const mockGate = jest.fn(() => Promise.resolve(false));
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: () => mockGate(),
  resolveOrgIdOrRefusal: jest.fn(() =>
    Promise.resolve({ status: "member", organizationId: "org-3966" }),
  ),
}));

jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: { listTemplates: jest.fn(), invalidate: jest.fn() },
}));

import {
  CHECKLISTS_NOT_ALLOWED_ERROR,
  MY_ITEMS_NOT_SENT_ERROR,
  registerChecklistHandlers,
} from "../checklistHandlers";
import { applyReviewChecklistPull } from "../../services/db/checklistDbService";
import { MY_ITEMS_TEMPLATE_ID } from "../../services/db/checklistPrivacy";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = randomUUID();
const DEAL = randomUUID();
const OTHER_DEAL = randomUUID();
const TEMPLATE_CHECKLIST = randomUUID();
const TEMPLATE_ITEM = randomUUID();
const TEMPLATE_ID = randomUUID();
const EMAIL_IN = randomUUID();
const EMAIL_OUT = randomUUID();

/** Titles only the agent's own items carry; looked for in every audit call. */
const PRIVATE_TITLE_1 = "Call the lender about the rate lock";
const PRIVATE_TITLE_2 = "Ask the seller for the HOA binder";

const evt = {} as IpcMainInvokeEvent;
async function invoke(channel: string, payload?: unknown): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, payload);
}

const rows = (q: string, ...p: unknown[]) =>
  mockDb!.prepare(q).all(...(p as never[])) as Array<Record<string, any>>;
const one = (q: string, ...p: unknown[]) =>
  mockDb!.prepare(q).get(...(p as never[])) as Record<string, any> | undefined;

function buildDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner-3966@example.com', 'google', 'oauth-3966')",
  ).run(USER);
  for (const deal of [DEAL, OTHER_DEAL]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, closed_at)
       VALUES (?, ?, '7 Control Street', 'active', '2026-03-01', '2026-03-31')`,
    ).run(deal, USER);
  }
  // One template checklist with one required, unticked item.
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES (?, ?, ?, 'Standard purchase', 0)",
  ).run(TEMPLATE_CHECKLIST, DEAL, TEMPLATE_ID);
  db.prepare(
    "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Signed purchase agreement', 1)",
  ).run(TEMPLATE_ITEM, TEMPLATE_CHECKLIST);
  // Two emails on the deal: one inside the audit dates, one outside them.
  for (const [id, sentAt] of [
    [EMAIL_IN, "2026-03-10T10:00:00Z"],
    [EMAIL_OUT, "2026-05-10T10:00:00Z"],
  ]) {
    db.prepare(
      "INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, 'Rate lock', 'body', ?)",
    ).run(id, USER, sentAt);
    db.prepare(
      "INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), USER, DEAL, id);
  }
  return db;
}

/** Add one of the agent's own items through the channel; returns its ids. */
async function addMine(title: string, deal = DEAL): Promise<{ checklistId: string; itemId: string }> {
  const res = await invoke("checklists:add-my-item", { transactionId: deal, title });
  expect(res.success).toBe(true);
  expect(res.result.status).toBe("added");
  return { checklistId: res.result.checklistId, itemId: res.result.itemId };
}

const privateRows = (deal = DEAL) =>
  rows("SELECT id, template_name FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?", deal, MY_ITEMS_TEMPLATE_ID);

beforeAll(() => {
  registerChecklistHandlers();
});

beforeEach(() => {
  mockDb = buildDb();
  mockAuditCalls.length = 0;
  // Default: a plan WITHOUT checklists — the case My items exists for.
  mockGate.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-3966 — the private row: made once, by the writer", () => {
  it("runs on the real SQLite engine (not the moduleNameMapper stub)", () => {
    const v = one("SELECT sqlite_version() AS v")!.v as string;
    expect(v).toMatch(/^3\.\d+\.\d+$/);
  });

  it("two adds on a new deal make ONE private row with TWO items, both required", async () => {
    expect(privateRows()).toHaveLength(0);
    const a = await addMine(PRIVATE_TITLE_1);
    const b = await addMine(PRIVATE_TITLE_2);
    expect(a.checklistId).toBe(b.checklistId);
    expect(privateRows()).toEqual([{ id: a.checklistId, template_name: "My items" }]);
    expect(
      rows("SELECT title, is_required, sort_order FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order", a.checklistId),
    ).toEqual([
      { title: PRIVATE_TITLE_1, is_required: 1, sort_order: 0 },
      { title: PRIVATE_TITLE_2, is_required: 1, sort_order: 1 },
    ]);
  });

  it("the agent's numbers count My items: 1 of 3 required done = template 0/1 + private 1/2", async () => {
    const a = await addMine(PRIVATE_TITLE_1);
    await addMine(PRIVATE_TITLE_2);
    expect(await invoke("checklists:set-item-checked", { itemId: a.itemId, checked: true })).toEqual({
      success: true,
      changed: true,
    });
    const got = await invoke("checklists:get", { transactionId: DEAL });
    expect([got.checklists.requiredDone, got.checklists.requiredTotal]).toEqual([1, 3]);
  });

  it("a title is trimmed, and an empty or over-long one is refused with nothing written", async () => {
    const { itemId } = await addMine("  Call the lender  ");
    expect(one("SELECT title FROM transaction_checklist_items WHERE id = ?", itemId)!.title).toBe("Call the lender");
    for (const title of ["   ", "x".repeat(301)]) {
      const res = await invoke("checklists:add-my-item", { transactionId: DEAL, title });
      expect(res.success).toBe(false);
    }
    expect(rows("SELECT id FROM transaction_checklist_items WHERE checklist_id IN (SELECT id FROM transaction_checklists WHERE template_id = ?)", MY_ITEMS_TEMPLATE_ID)).toHaveLength(1);
  });

  it("a deal that does not exist is its own answer, and nothing is written", async () => {
    const res = await invoke("checklists:add-my-item", { transactionId: randomUUID(), title: PRIVATE_TITLE_1 });
    expect(res).toEqual({ success: true, result: { status: "no_transaction" } });
    expect(rows("SELECT id FROM transaction_checklists WHERE template_id = ?", MY_ITEMS_TEMPLATE_ID)).toHaveLength(0);
  });
});

describe("BACKLOG-3966 — every My-items write is scoped to the deal's private checklist", () => {
  it("rename, remove and reorder aimed at a TEMPLATE item change nothing", async () => {
    await addMine(PRIVATE_TITLE_1);
    expect(
      await invoke("checklists:rename-my-item", { transactionId: DEAL, itemId: TEMPLATE_ITEM, title: "Hijacked" }),
    ).toEqual({ success: true, changed: false });
    expect(await invoke("checklists:remove-my-item", { transactionId: DEAL, itemId: TEMPLATE_ITEM })).toEqual({
      success: true,
      changed: false,
    });
    const reorder = await invoke("checklists:reorder-my-items", { transactionId: DEAL, itemIds: [TEMPLATE_ITEM] });
    expect(reorder).toEqual({ success: true, result: { status: "not_the_items" } });
    expect(one("SELECT title, sort_order FROM transaction_checklist_items WHERE id = ?", TEMPLATE_ITEM)).toEqual({
      title: "Signed purchase agreement",
      sort_order: 0,
    });
  });

  it("rename, remove and reorder naming ANOTHER deal change nothing on this one", async () => {
    const { itemId } = await addMine(PRIVATE_TITLE_1);
    await addMine(PRIVATE_TITLE_2, OTHER_DEAL);
    expect(
      await invoke("checklists:rename-my-item", { transactionId: OTHER_DEAL, itemId, title: "Hijacked" }),
    ).toEqual({ success: true, changed: false });
    expect(await invoke("checklists:remove-my-item", { transactionId: OTHER_DEAL, itemId })).toEqual({
      success: true,
      changed: false,
    });
    expect(one("SELECT title FROM transaction_checklist_items WHERE id = ?", itemId)!.title).toBe(PRIVATE_TITLE_1);
  });

  it("rename and remove act on a My item", async () => {
    const a = await addMine(PRIVATE_TITLE_1);
    const b = await addMine(PRIVATE_TITLE_2);
    expect(
      await invoke("checklists:rename-my-item", { transactionId: DEAL, itemId: a.itemId, title: "Renamed" }),
    ).toEqual({ success: true, changed: true });
    expect(one("SELECT title FROM transaction_checklist_items WHERE id = ?", a.itemId)!.title).toBe("Renamed");
    expect(await invoke("checklists:remove-my-item", { transactionId: DEAL, itemId: b.itemId })).toEqual({
      success: true,
      changed: true,
    });
    expect(one("SELECT id FROM transaction_checklist_items WHERE id = ?", b.itemId)).toBeUndefined();
    // The private row stays, even when it ends up empty.
    expect(await invoke("checklists:remove-my-item", { transactionId: DEAL, itemId: a.itemId })).toEqual({
      success: true,
      changed: true,
    });
    expect(privateRows()).toHaveLength(1);
  });

  it("reorder takes exactly the section's items: a subset, a duplicate or an extra id moves nothing", async () => {
    const a = await addMine(PRIVATE_TITLE_1);
    const b = await addMine(PRIVATE_TITLE_2);
    const order = () =>
      rows("SELECT id FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order", a.checklistId).map(
        (r) => r.id,
      );
    for (const itemIds of [[b.itemId], [b.itemId, b.itemId], [b.itemId, a.itemId, TEMPLATE_ITEM]]) {
      const res = await invoke("checklists:reorder-my-items", { transactionId: DEAL, itemIds });
      expect([itemIds.length, res.result.status]).toEqual([itemIds.length, "not_the_items"]);
      expect(order()).toEqual([a.itemId, b.itemId]);
    }
    const res = await invoke("checklists:reorder-my-items", { transactionId: DEAL, itemIds: [b.itemId, a.itemId] });
    expect(res).toEqual({ success: true, result: { status: "reordered" } });
    expect(order()).toEqual([b.itemId, a.itemId]);
  });
});

describe("BACKLOG-3966 — the plan rule is per checklist", () => {
  it("on a plan WITHOUT checklists: every My-items write and every item channel on a My item answers", async () => {
    const a = await addMine(PRIVATE_TITLE_1);
    const b = await addMine(PRIVATE_TITLE_2);
    expect(await invoke("checklists:rename-my-item", { transactionId: DEAL, itemId: a.itemId, title: "Renamed" })).toEqual({ success: true, changed: true });
    expect((await invoke("checklists:reorder-my-items", { transactionId: DEAL, itemIds: [b.itemId, a.itemId] })).result.status).toBe("reordered");
    expect(await invoke("checklists:set-item-checked", { itemId: a.itemId, checked: true })).toEqual({ success: true, changed: true });
    expect(await invoke("checklists:set-item-note", { itemId: a.itemId, note: "Locked at 6.1" })).toEqual({ success: true, changed: true });
    const linked = await invoke("checklists:add-link", { itemId: a.itemId, kind: "email", targetIds: [EMAIL_IN] });
    expect(linked.success).toBe(true);
    expect(linked.result.status).toBe("added");
    expect(await invoke("checklists:remove-link", { linkId: linked.result.linkId })).toEqual({ success: true, changed: true });
    expect(await invoke("checklists:remove-my-item", { transactionId: DEAL, itemId: b.itemId })).toEqual({ success: true, changed: true });
  });

  it("on a plan WITHOUT checklists: the same item channels on a TEMPLATE item are refused, nothing written", async () => {
    mockDb!
      .prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-tpl', ?, 'email', 'Rate lock')")
      .run(TEMPLATE_ITEM);
    const refused = { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
    expect(await invoke("checklists:set-item-checked", { itemId: TEMPLATE_ITEM, checked: true })).toEqual(refused);
    expect(await invoke("checklists:set-item-note", { itemId: TEMPLATE_ITEM, note: "x" })).toEqual(refused);
    expect(await invoke("checklists:add-link", { itemId: TEMPLATE_ITEM, kind: "email", targetIds: [EMAIL_IN] })).toEqual(refused);
    expect(await invoke("checklists:remove-link", { linkId: "l-tpl" })).toEqual(refused);
    expect(one("SELECT is_checked, note FROM transaction_checklist_items WHERE id = ?", TEMPLATE_ITEM)).toEqual({ is_checked: 0, note: null });
    expect(rows("SELECT id FROM transaction_checklist_links")).toEqual([{ id: "l-tpl" }]);
  });

  it("checklists:get serves My items on a plan WITHOUT checklists, marked private", async () => {
    const { checklistId } = await addMine(PRIVATE_TITLE_1);
    const got = await invoke("checklists:get", { transactionId: DEAL });
    expect(got.success).toBe(true);
    const mine = got.checklists.checklists.find((d: any) => d.checklist.id === checklistId);
    expect(mine.checklist.isPrivate).toBe(true);
    expect(mine.items.map((i: any) => i.title)).toEqual([PRIVATE_TITLE_1]);
    const template = got.checklists.checklists.find((d: any) => d.checklist.id === TEMPLATE_CHECKLIST);
    expect(template.checklist.isPrivate).toBe(false);
  });

  it("Todo on a plan WITHOUT checklists: answers, with My items only — template items absent", async () => {
    const { itemId } = await addMine(PRIVATE_TITLE_1);
    const res = await invoke("checklists:list-open-required", { userId: USER });
    expect(res.success).toBe(true);
    expect(res.result.items.map((i: any) => i.itemId)).toEqual([itemId]);
    expect(res.result.totalCount).toBe(1);
    // The deal ring stays the deal's whole total (template 0/1 + private 0/1).
    expect([res.result.items[0].dealRequiredDone, res.result.items[0].dealRequiredTotal]).toEqual([0, 2]);
  });

  it("Todo on a plan WITH checklists: both the template item and My item are listed", async () => {
    mockGate.mockImplementation(() => Promise.resolve(true));
    const { itemId } = await addMine(PRIVATE_TITLE_1);
    const res = await invoke("checklists:list-open-required", { userId: USER });
    expect(res.success).toBe(true);
    expect(res.result.items.map((i: any) => i.itemId).sort()).toEqual([TEMPLATE_ITEM, itemId].sort());
    expect(res.result.totalCount).toBe(2);
  });
});

describe("BACKLOG-3966 — nothing private is ever flagged to be sent", () => {
  it("'Include it' for a private group is refused on every plan, and the flag stays 0", async () => {
    const { itemId } = await addMine(PRIVATE_TITLE_1);
    const linked = await invoke("checklists:add-link", { itemId, kind: "email", targetIds: [EMAIL_IN] });
    const linkId = linked.result.linkId;
    for (const allowed of [false, true]) {
      mockGate.mockImplementation(() => Promise.resolve(allowed));
      expect(await invoke("checklists:include-link-outside-dates", { transactionId: DEAL, linkId })).toEqual({
        success: false,
        error: MY_ITEMS_NOT_SENT_ERROR,
      });
    }
    expect(one("SELECT include_outside_dates FROM transaction_checklist_links WHERE id = ?", linkId)!.include_outside_dates).toBe(0);
  });

  it("linking evidence dated outside the audit dates to a My item is never asked about, and never flagged", async () => {
    const { itemId } = await addMine(PRIVATE_TITLE_1);
    const plain = await invoke("checklists:add-link", { itemId, kind: "email", targetIds: [EMAIL_OUT] });
    expect(plain.result.status).toBe("added");
    const asked = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: [EMAIL_OUT, EMAIL_IN],
      includeOutsideDates: true,
    });
    expect(asked.result.status).toBe("added");
    expect(rows("SELECT include_outside_dates FROM transaction_checklist_links ORDER BY sort_order")).toEqual([
      { include_outside_dates: 0 },
      { include_outside_dates: 0 },
    ]);
  });

  it("the same evidence on a TEMPLATE item is still asked about (the rule is unchanged there)", async () => {
    mockGate.mockImplementation(() => Promise.resolve(true));
    const res = await invoke("checklists:add-link", { itemId: TEMPLATE_ITEM, kind: "email", targetIds: [EMAIL_OUT] });
    expect(res.result.status).toBe("outside_dates");
  });
});

describe("BACKLOG-3966 — nothing that handles template checklists touches the private row", () => {
  it("checklists:remove on the private row removes nothing and records nothing", async () => {
    const { checklistId } = await addMine(PRIVATE_TITLE_1);
    mockAuditCalls.length = 0;
    expect(await invoke("checklists:remove", { transactionId: DEAL, checklistId })).toEqual({
      success: true,
      changed: false,
    });
    expect(privateRows()).toHaveLength(1);
    expect(mockAuditCalls).toEqual([]);
    // The template checklist still comes off as before.
    expect(await invoke("checklists:remove", { transactionId: DEAL, checklistId: TEMPLATE_CHECKLIST })).toEqual({
      success: true,
      changed: true,
    });
  });

  it("a review pull naming the reserved id removes nothing and adds nothing into the private row", async () => {
    const { checklistId } = await addMine(PRIVATE_TITLE_1);
    const removed = await applyReviewChecklistPull(DEAL, [MY_ITEMS_TEMPLATE_ID], []);
    expect(removed.removedTemplateIds).toEqual([]);
    expect(privateRows()).toHaveLength(1);
    const added = await applyReviewChecklistPull(OTHER_DEAL, [], [
      {
        transactionId: OTHER_DEAL,
        templateId: MY_ITEMS_TEMPLATE_ID,
        templateName: "My items",
        items: [{ title: "Broker-written", isRequired: true, sortOrder: 0 }],
      },
    ]);
    expect(added.addedTemplateIds).toEqual([]);
    expect(privateRows(OTHER_DEAL)).toHaveLength(0);
    expect(rows("SELECT title FROM transaction_checklist_items WHERE checklist_id = ?", checklistId)).toEqual([
      { title: PRIVATE_TITLE_1 },
    ]);
  });
});

describe("BACKLOG-3966 — audit egress (SR R4): no private title, no reserved id", () => {
  it("every My-items write records no audit entry, and no entry anywhere carries a private title", async () => {
    const a = await addMine(PRIVATE_TITLE_1);
    const b = await addMine(PRIVATE_TITLE_2);
    await invoke("checklists:rename-my-item", { transactionId: DEAL, itemId: a.itemId, title: "Renamed lender call" });
    await invoke("checklists:reorder-my-items", { transactionId: DEAL, itemIds: [b.itemId, a.itemId] });
    await invoke("checklists:set-item-checked", { itemId: a.itemId, checked: true });
    await invoke("checklists:set-item-note", { itemId: a.itemId, note: "Locked at 6.1" });
    const linked = await invoke("checklists:add-link", { itemId: a.itemId, kind: "email", targetIds: [EMAIL_IN] });
    await invoke("checklists:remove-link", { linkId: linked.result.linkId });
    await invoke("checklists:remove-my-item", { transactionId: DEAL, itemId: b.itemId });
    await invoke("checklists:remove", { transactionId: DEAL, checklistId: a.checklistId });
    const payload = JSON.stringify(mockAuditCalls);
    for (const secret of [PRIVATE_TITLE_1, PRIVATE_TITLE_2, "Renamed lender call", "Locked at 6.1", MY_ITEMS_TEMPLATE_ID]) {
      expect([secret, payload.includes(secret)]).toEqual([secret, false]);
    }
    expect(mockAuditCalls).toEqual([]);
  });
});
