/**
 * @jest-environment node
 *
 * BACKLOG-3968 PR-4b — the text-link writer, through the real add-link and
 * remove-link channels over the production schema.sql.
 *
 * A text group's members are `messages.id` values. The writer must refuse a
 * text that is not THIS deal's (W3), a text that is another user's — linked
 * directly, or another user's copy of a linked thread (W3b) — any text link on
 * a locked deal, and an "Include it" for a text, which is never asked the
 * outside-the-dates question. The read path's `inTransaction` for a text member
 * is pinned here too, on a text linked only to another deal and on another
 * user's copy of a thread (SR da681add, approval gate for PR-4b).
 *
 * Wrong implementations this suite is here to catch:
 *   - the text arm not scoped to the deal, or not to the deal owner;
 *   - the lock skipped for texts;
 *   - a text member written into `email_id`, or two member rows per text;
 *   - an "Include it" stored on a text group.
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

// The plan allows checklists: the refusals under test are the writer's and the lock's.
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: jest.fn(() => Promise.resolve(true)),
  resolveOrgIdOrRefusal: jest.fn(() =>
    Promise.resolve({ status: "member", organizationId: "org-3968" }),
  ),
}));

jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: { listTemplates: jest.fn(), invalidate: jest.fn() },
}));

import { registerChecklistHandlers } from "../checklistHandlers";
import { MY_ITEMS_TEMPLATE_ID } from "../../services/db/checklistPrivacy";
import { addChecklistLink, getChecklistsForTransaction } from "../../services/db/checklistDbService";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

const USER = randomUUID();
const OTHER_USER = randomUUID();
const DEAL = randomUUID();
const DEAL_2 = randomUUID();
const CHECKLIST = randomUUID();
const ITEM = randomUUID();
const MY_CHECKLIST = randomUUID();
const MY_ITEM = randomUUID();

const THREAD_DIRECT = `thread-direct-${randomUUID()}`;
const THREAD_LINKED = `thread-linked-${randomUUID()}`;

/** USER's text, linked to DEAL by its own id. Dated before DEAL's audit dates. */
const M_DIRECT = randomUUID();
/** USER's two texts in a thread DEAL links by thread id (for USER). */
const M_THREAD_1 = randomUUID();
const M_THREAD_2 = randomUUID();
/** USER's text linked only to DEAL_2 (W3). */
const M_OTHER_DEAL = randomUUID();
/** OTHER_USER's copy of THREAD_LINKED: same thread id, another user (W3b). */
const M_OTHER_USER_THREAD = randomUUID();
/** OTHER_USER's text, named by id on a DEAL communications row (W3b, direct arm). */
const M_OTHER_USER_DIRECT = randomUUID();

/** Every value of the schema's submission_status CHECK list. */
const ALL_STATUSES = [
  "not_submitted",
  "submitted",
  "under_review",
  "needs_changes",
  "resubmitted",
  "approved",
  "rejected",
] as const;
const LOCKED = new Set(["submitted", "under_review", "resubmitted", "approved"]);

function insertText(id: string, userId: string, threadId: string, sentAt: string): void {
  mockDb!
    .prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, thread_id, sent_at)
       VALUES (?, ?, 'imessage', ?, 'inbound', 'x', ?, ?)`,
    )
    .run(id, userId, `guid-${id}`, threadId, sentAt);
}

function buildDb(status: string): TestDb {
  const db = openTestDb();
  mockDb = db;
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const [id, email] of [
    [USER, "owner-3968@example.com"],
    [OTHER_USER, "other-3968@example.com"],
  ]) {
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
    ).run(id, email, `oauth-${id}`);
  }
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, submission_status, started_at, closed_at)
     VALUES (?, ?, '7 Text Street', ?, '2026-03-02', '2026-03-20')`,
  ).run(DEAL, USER, status);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '9 Other Street')",
  ).run(DEAL_2, USER);

  insertText(M_DIRECT, USER, THREAD_DIRECT, "2026-03-01T10:00:00Z");
  insertText(M_THREAD_1, USER, THREAD_LINKED, "2026-03-05T10:00:00Z");
  insertText(M_THREAD_2, USER, THREAD_LINKED, "2026-03-06T10:00:00Z");
  insertText(M_OTHER_DEAL, USER, `thread-other-deal-${randomUUID()}`, "2026-03-05T10:00:00Z");
  insertText(M_OTHER_USER_THREAD, OTHER_USER, THREAD_LINKED, "2026-03-05T11:00:00Z");
  insertText(M_OTHER_USER_DIRECT, OTHER_USER, `thread-other-user-${randomUUID()}`, "2026-03-05T12:00:00Z");

  const link = (transactionId: string, col: "message_id" | "thread_id", value: string) =>
    db
      .prepare(`INSERT INTO communications (id, user_id, transaction_id, ${col}) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), USER, transactionId, value);
  link(DEAL, "message_id", M_DIRECT);
  link(DEAL, "thread_id", THREAD_LINKED);
  link(DEAL_2, "message_id", M_OTHER_DEAL);
  link(DEAL, "message_id", M_OTHER_USER_DIRECT);

  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, ?, 'Standard purchase')",
  ).run(CHECKLIST, DEAL, randomUUID());
  db.prepare(
    "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Seller texts', 1)",
  ).run(ITEM, CHECKLIST);
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES (?, ?, ?, 'My items', 1)",
  ).run(MY_CHECKLIST, DEAL, MY_ITEMS_TEMPLATE_ID);
  db.prepare(
    "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Call the lender', 1)",
  ).run(MY_ITEM, MY_CHECKLIST);
  return db;
}

const all = (q: string, ...p: unknown[]) =>
  mockDb!.prepare(q).all(...(p as never[])) as Array<Record<string, unknown>>;
const linkRows = () =>
  all(
    "SELECT id, item_id, kind, label, include_outside_dates FROM transaction_checklist_links ORDER BY sort_order",
  );
const memberRows = () =>
  all(
    "SELECT link_id, kind, attachment_id, email_id, message_id FROM transaction_checklist_link_members ORDER BY message_id",
  );

const evt = {} as IpcMainInvokeEvent;
async function invoke(channel: string, payload: unknown): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, payload);
}
const linkText = (itemId: string, targetIds: string[], extra: Record<string, unknown> = {}) =>
  invoke("checklists:add-link", { itemId, kind: "text", targetIds, ...extra });

beforeAll(() => {
  registerChecklistHandlers();
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-3968 PR-4b — linking texts to a checklist item", () => {
  it("a text on this deal becomes ONE text group whose only member names it by messages.id", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_DIRECT]);

    expect(response).toEqual({
      success: true,
      result: { status: "added", linkId: expect.any(String), memberCount: 1 },
    });
    expect(linkRows()).toEqual([
      {
        id: response.result.linkId,
        item_id: ITEM,
        kind: "text",
        label: "Text · March 1, 2026",
        // Dated before the deal's audit dates, and still never asked: a text
        // has no outside-the-dates arm.
        include_outside_dates: 0,
      },
    ]);
    expect(memberRows()).toEqual([
      {
        link_id: response.result.linkId,
        kind: "text",
        attachment_id: null,
        email_id: null,
        message_id: M_DIRECT,
      },
    ]);
  });

  it("texts of a thread the deal links are accepted as one group of two; the same text twice is one member", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_THREAD_2, M_THREAD_1, M_THREAD_2]);

    expect(response.result).toEqual({ status: "added", linkId: expect.any(String), memberCount: 2 });
    // Labelled by the EARLIEST member.
    expect(linkRows().map((l) => l.label)).toEqual(["Text · March 5, 2026"]);
    expect(memberRows()).toEqual(
      [M_THREAD_1, M_THREAD_2].sort().map((id) => ({
        link_id: response.result.linkId,
        kind: "text",
        attachment_id: null,
        email_id: null,
        message_id: id,
      })),
    );
  });

  it("W3: a text linked only to ANOTHER deal is refused, and nothing is written — not even the valid text", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_DIRECT, M_OTHER_DEAL]);

    expect(response).toEqual({
      success: true,
      result: { status: "targets_not_in_transaction", rejectedIds: [M_OTHER_DEAL] },
    });
    expect(linkRows()).toEqual([]);
    expect(memberRows()).toEqual([]);
  });

  it("W3b: another user's copy of a thread this deal links is refused", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_OTHER_USER_THREAD]);

    expect(response.result).toEqual({
      status: "targets_not_in_transaction",
      rejectedIds: [M_OTHER_USER_THREAD],
    });
    expect(linkRows()).toEqual([]);
  });

  it("W3b: another user's text is refused even when a row of this deal names it by id", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_OTHER_USER_DIRECT]);

    expect(response.result).toEqual({
      status: "targets_not_in_transaction",
      rejectedIds: [M_OTHER_USER_DIRECT],
    });
    expect(linkRows()).toEqual([]);
  });

  it("an id that is not a message at all is refused", async () => {
    buildDb("not_submitted");
    const missing = randomUUID();
    expect((await linkText(ITEM, [missing])).result).toEqual({
      status: "targets_not_in_transaction",
      rejectedIds: [missing],
    });
  });

  it.each(ALL_STATUSES)(
    "submission status %s: a text link is refused exactly when the deal is locked",
    async (status) => {
      buildDb(status);
      const response = await linkText(ITEM, [M_DIRECT]);
      if (LOCKED.has(status)) {
        expect(response).toEqual({
          success: false,
          error: expect.any(String),
          dealLocked: expect.any(String),
          refusedEdit: "link-checklist-item",
        });
        expect(linkRows()).toEqual([]);
        expect(memberRows()).toEqual([]);
      } else {
        expect(response.result.status).toBe("added");
        expect(memberRows().map((m) => m.message_id)).toEqual([M_DIRECT]);
      }
    },
  );

  it("an 'Include it' for a text is refused at the boundary, and nothing is written", async () => {
    buildDb("not_submitted");
    const response = await linkText(ITEM, [M_DIRECT], { includeOutsideDates: true });

    expect(response.success).toBe(false);
    expect(linkRows()).toEqual([]);
    // The same request for an email-shaped kind still parses (positive control:
    // the refusal is about texts, not about the flag).
    const email = await invoke("checklists:add-link", {
      itemId: ITEM,
      kind: "email",
      targetIds: [randomUUID()],
      includeOutsideDates: true,
    });
    expect(email.success).toBe(true);
  });

  it("an in-process caller passing 'Include it' for a text still gets a group that is never flagged", async () => {
    buildDb("not_submitted");
    const result = await addChecklistLink({
      itemId: ITEM,
      kind: "text",
      targetIds: [M_DIRECT],
      includeOutsideDates: true,
    });
    expect(result.status).toBe("added");
    expect(linkRows().map((l) => l.include_outside_dates)).toEqual([0]);
  });

  it("a text can be linked to one of the agent's own items, never flagged", async () => {
    buildDb("not_submitted");
    const response = await linkText(MY_ITEM, [M_DIRECT]);
    expect(response.result.status).toBe("added");
    expect(linkRows()).toEqual([
      expect.objectContaining({ item_id: MY_ITEM, kind: "text", include_outside_dates: 0 }),
    ]);
  });

  it("remove-link takes a text group off with its members", async () => {
    buildDb("not_submitted");
    const added = await linkText(ITEM, [M_THREAD_1, M_THREAD_2]);
    const removed = await invoke("checklists:remove-link", { linkId: added.result.linkId });
    expect(removed).toEqual({ success: true, changed: true });
    expect(linkRows()).toEqual([]);
    expect(memberRows()).toEqual([]);
  });
});

describe("BACKLOG-3968 — a text member's inTransaction (SR da681add approval gate)", () => {
  /** Members written straight into the table: the writer would refuse two of them. */
  function seedMembers(): Record<string, string> {
    const ids: Record<string, string> = {};
    for (const [name, messageId] of [
      ["direct", M_DIRECT],
      ["thread", M_THREAD_1],
      ["otherDeal", M_OTHER_DEAL],
      ["otherUserThread", M_OTHER_USER_THREAD],
    ] as const) {
      const linkId = randomUUID();
      ids[name] = linkId;
      mockDb!
        .prepare(
          "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'text', 'Text')",
        )
        .run(linkId, ITEM);
      mockDb!
        .prepare(
          "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES (?, ?, 'text', ?)",
        )
        .run(randomUUID(), linkId, messageId);
    }
    return ids;
  }

  it("true for this deal's texts; false for a text only on another deal and for another user's copy of a thread", async () => {
    buildDb("not_submitted");
    const ids = seedMembers();
    const read = await getChecklistsForTransaction(DEAL, "agent");
    const template = read.checklists.find((c) => c.checklist.id === CHECKLIST)!;
    const byLink = new Map(
      template.linksByItemId[ITEM].map((l) => [l.id, l.members.map((m) => [m.messageId, m.inTransaction])]),
    );
    expect(byLink.get(ids.direct)).toEqual([[M_DIRECT, true]]);
    expect(byLink.get(ids.thread)).toEqual([[M_THREAD_1, true]]);
    expect(byLink.get(ids.otherDeal)).toEqual([[M_OTHER_DEAL, false]]);
    expect(byLink.get(ids.otherUserThread)).toEqual([[M_OTHER_USER_THREAD, false]]);
  });
});
