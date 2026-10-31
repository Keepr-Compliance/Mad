/**
 * @jest-environment node
 *
 * BACKLOG-3910 (slice d, founder 2026-10-12): a locked deal (submitted,
 * under_review, resubmitted, approved) is fully read-only, checklists
 * included. Every checklist channel that writes is refused in the MAIN
 * PROCESS on a locked deal and goes through on an open one.
 *
 * Runs over the real `schema.sql` on a real SQLite engine, with the real
 * checklist db service and the real lock resolvers (item -> checklist -> deal,
 * group -> item -> checklist -> deal). So a resolver with a wrong join answers
 * "no deal", the guard does not run, the write lands, and the locked rows here
 * go red. The outcome is read back from the database, not from a mock.
 *
 * The locked set is written out as a literal on purpose; the mapping itself is
 * pinned by `src/utils/__tests__/dealLock.parity.test.ts`.
 *
 * needs_changes is in the open set: the broker-checklist pull
 * (submissionChecklistPull.ts) runs at that status and must keep working. It
 * never goes through these handlers (it imports `applyReviewChecklistPull`
 * from the db service directly), and the needs_changes rows below prove the
 * handlers themselves stay open there too.
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
  // BACKLOG-3339 slice T: add / remove read the deal's owner (the audit
  // entry's user) before their transaction. The real read, over this database.
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

// The plan allows checklists here: the only refusal under test is the lock.
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: jest.fn(() => Promise.resolve(true)),
  resolveOrgIdOrRefusal: jest.fn(() =>
    Promise.resolve({ status: "member", organizationId: "org-3910d" }),
  ),
}));

const mockTemplateNew = randomUUID();
jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: {
    listTemplates: jest.fn(() =>
      Promise.resolve({
        source: "live",
        templates: [
          {
            id: mockTemplateNew,
            name: "Second checklist",
            description: null,
            sortOrder: 20,
            updatedAt: null,
            items: [
              {
                id: "tpl-item-1",
                title: "Inspection report",
                description: null,
                isRequired: true,
                expectedDocumentType: null,
                sortOrder: 10,
              },
            ],
          },
        ],
      }),
    ),
    invalidate: jest.fn(),
  },
}));

import { registerChecklistHandlers } from "../checklistHandlers";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

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
/** The founder's ruling, written out: these are read-only. */
const LOCKED = new Set(["submitted", "under_review", "resubmitted", "approved"]);

const USER = randomUUID();
const DEAL = randomUUID();
const CHECKLIST = randomUUID();
const ITEM = randomUUID();
const LINK = randomUUID();
const EMAIL_LINKED = randomUUID();
const EMAIL_FREE = randomUUID();

function buildDb(status: string): TestDb {
  const db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-3910d@example.com", "oauth-3910d");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, submission_status) VALUES (?, ?, ?, ?)",
  ).run(DEAL, USER, "5 Control Street", status);
  for (const [id, subject] of [
    [EMAIL_LINKED, "Offer"],
    [EMAIL_FREE, "Inspection"],
  ]) {
    db.prepare(
      "INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, ?, 'body', '2026-03-01T10:00:00Z')",
    ).run(id, USER, subject);
    db.prepare(
      "INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), USER, DEAL, id);
  }
  db.prepare(
    "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, ?, 'Standard purchase')",
  ).run(CHECKLIST, DEAL, randomUUID());
  db.prepare(
    "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES (?, ?, 'Signed purchase agreement', 1)",
  ).run(ITEM, CHECKLIST);
  db.prepare(
    "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'email', 'Offer')",
  ).run(LINK, ITEM);
  db.prepare(
    "INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)",
  ).run(randomUUID(), LINK, EMAIL_LINKED);
  return db;
}

const one = (q: string, ...p: unknown[]) =>
  mockDb!.prepare(q).get(...(p as never[])) as Record<string, unknown>;
const count = (table: string): number =>
  (mockDb!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const evt = {} as IpcMainInvokeEvent;
async function invoke(channel: string, payload: unknown): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, payload);
}

interface Edit {
  name: string;
  channel: string;
  payload: () => unknown;
  refusedEdit: string;
  /** Reads the row the edit changes, so "unchanged" and "changed" are observed. */
  observe: () => unknown;
  before: unknown;
  after: unknown;
}

const EDITS: Edit[] = [
  {
    name: "add a checklist (select-template)",
    channel: "checklists:select-template",
    payload: () => ({ transactionId: DEAL, templateId: mockTemplateNew }),
    refusedEdit: "add-checklist",
    observe: () => count("transaction_checklists"),
    before: 1,
    after: 2,
  },
  {
    name: "tick an item (set-item-checked)",
    channel: "checklists:set-item-checked",
    payload: () => ({ itemId: ITEM, checked: true }),
    refusedEdit: "tick-checklist-item",
    observe: () => one("SELECT is_checked FROM transaction_checklist_items WHERE id = ?", ITEM).is_checked,
    before: 0,
    after: 1,
  },
  {
    name: "write a note (set-item-note)",
    channel: "checklists:set-item-note",
    payload: () => ({ itemId: ITEM, note: "Received" }),
    refusedEdit: "edit-checklist-note",
    observe: () => one("SELECT note FROM transaction_checklist_items WHERE id = ?", ITEM).note,
    before: null,
    after: "Received",
  },
  {
    name: "link evidence to an item (add-link)",
    channel: "checklists:add-link",
    payload: () => ({ itemId: ITEM, kind: "email", targetIds: [EMAIL_FREE] }),
    refusedEdit: "link-checklist-item",
    observe: () => count("transaction_checklist_links"),
    before: 1,
    after: 2,
  },
  {
    name: "include a group outside the dates (include-link-outside-dates)",
    channel: "checklists:include-link-outside-dates",
    payload: () => ({ transactionId: DEAL, linkId: LINK }),
    refusedEdit: "include-outside-dates",
    observe: () =>
      one("SELECT include_outside_dates FROM transaction_checklist_links WHERE id = ?", LINK)
        .include_outside_dates,
    before: 0,
    after: 1,
  },
  {
    name: "unlink a group (the take-off-link channel)",
    channel: "checklists:remove-link",
    payload: () => ({ linkId: LINK }),
    refusedEdit: "unlink-checklist-item",
    observe: () => count("transaction_checklist_links"),
    before: 1,
    after: 0,
  },
  {
    name: "take a checklist off the deal (the take-off-checklist channel)",
    channel: "checklists:remove",
    payload: () => ({ transactionId: DEAL, checklistId: CHECKLIST }),
    refusedEdit: "take-off-checklist",
    observe: () => count("transaction_checklists"),
    before: 1,
    after: 0,
  },
];

beforeAll(() => {
  registerChecklistHandlers();
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-3910 slice d: a locked deal refuses every checklist write", () => {
  it("the sweep covers all seven schema statuses, four of them locked", () => {
    expect(ALL_STATUSES).toHaveLength(7);
    expect(ALL_STATUSES.filter((s) => LOCKED.has(s))).toEqual([
      "submitted",
      "under_review",
      "resubmitted",
      "approved",
    ]);
  });

  it("every registered checklist channel that writes is in the sweep", () => {
    const readOnlyChannels = new Set([
      "checklists:get",
      "checklists:list-templates",
      "checklists:can-edit-templates",
      "checklists:open-templates-portal",
      "checklists:invalidate-templates",
      // BACKLOG-3965: the Todo read writes nothing; ticking goes through set-item-checked.
      "checklists:list-open-required",
    ]);
    const writers = [...registeredHandlers.keys()]
      .filter((c) => c.startsWith("checklists:") && !readOnlyChannels.has(c))
      .sort();
    expect(writers).toEqual(EDITS.map((e) => e.channel).sort());
  });

  for (const edit of EDITS) {
    describe(edit.name, () => {
      for (const status of ALL_STATUSES) {
        if (LOCKED.has(status)) {
          it(`${status}: refused, nothing written`, async () => {
            mockDb = buildDb(status);
            expect(edit.observe()).toEqual(edit.before);
            const res = await invoke(edit.channel, edit.payload());
            expect(res.success).toBe(false);
            expect(res.dealLocked).toBe(status === "approved" ? "sealed" : "submitted");
            expect(res.refusedEdit).toBe(edit.refusedEdit);
            expect(res.error).toMatch(/can't be changed/);
            expect(edit.observe()).toEqual(edit.before);
          });
        } else {
          it(`${status}: goes through`, async () => {
            mockDb = buildDb(status);
            expect(edit.observe()).toEqual(edit.before);
            const res = await invoke(edit.channel, edit.payload());
            expect(res.success).toBe(true);
            expect(res.dealLocked).toBeUndefined();
            expect(edit.observe()).toEqual(edit.after);
          });
        }
      }
    });
  }

  it("an item or group id with no row writes nothing (no deal to check, no row to change)", async () => {
    mockDb = buildDb("submitted");
    const tick = await invoke("checklists:set-item-checked", { itemId: randomUUID(), checked: true });
    expect(tick).toEqual({ success: true, changed: false });
    const unlink = await invoke("checklists:remove-link", { linkId: randomUUID() });
    expect(unlink).toEqual({ success: true, changed: false });
    expect(count("transaction_checklist_links")).toBe(1);
  });
});
