/**
 * @jest-environment node
 *
 * BACKLOG-3475 C6 / C9 / C12 — the nine checklist channels, over the real
 * `schema.sql` on a real SQLite engine.
 *
 * ===========================================================================
 * C9 — THE GATE, PER CHANNEL
 * ===========================================================================
 * `isChecklistsAllowed` is wrapped so each test can choose, and by DEFAULT it
 * runs the REAL, SHIPPED gate. `jest.requireActual` reaches
 * `featureGateHandlers.isChecklistsAllowed`, not a copy of it.
 *
 * Which means this file has to say what the real gate may talk to.
 * `requireActual` bypasses the mock for the module it names, NOT for that
 * module's dependencies — so the real gate runs its real chain down to
 * `supabaseService.getClient().auth.getSession()`. Left unmocked that is a live
 * outbound connection: the net guard (BACKLOG-3284) would red this suite in
 * `afterEach` naming a HOST rather than this line, or the call would throw
 * before any socket, the gate's own `catch` would answer "unknown", and every
 * C9 assertion would still pass while meaning nothing at all. So
 * `supabaseService` is mocked to a signed-OUT session, and the default means
 * something stronger than "a stub said no": THE REAL GATE REFUSES EVERY WRITE
 * WHEN THE PLAN CANNOT BE READ.
 *
 * **A wrapper does not stop one handler from forgetting to call it**, which is
 * why every gated channel is asserted separately and the three ungated ones are
 * asserted to keep working in the same state.
 *
 * The SPLIT itself is asserted too, by execution rather than by prose: "the
 * gated and ungated sets, by execution" enumerates every registered
 * `checklists:` channel, invokes each one with the plan unreadable, and
 * partitions them by what they answer. Six refuse, three work. A tenth channel
 * nobody classified, a gate dropped, or a gate added to `get` all red it —
 * which is what makes the module header's count something other than a
 * sentence to be trusted.
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH
 * ===========================================================================
 *   one handler that forgets the gate
 *       Five channels refuse, the sixth writes. Nothing else in the repo can
 *       see this: the strict READER is guarded by the 3349 and 3365 suites, but
 *       no existing test knows a handler is supposed to call it.
 *   a fail-OPEN gate (`featureGateService.checkFeature`)
 *       Answers ALLOWED for a key that is not in the cache and for no cache
 *       at all, so a user offline or on a cache that lacks the key would read
 *       allowed whatever the plan says. The `transaction_checklists` row is
 *       live in production (BACKLOG-3473, pm_comments cd873ca3) and on only
 *       for some plans; fail-open would hand it to the rest.
 *   `get` or `remove` gated by mistake
 *       A user whose plan lapses can neither see what is on his transaction nor
 *       take it off. The rows are stranded.
 *   the org resolved through `submissionService.getUserOrganizationId()`
 *       It excludes personal organizations (so every solo user reads as having
 *       none) and does not filter `license_status`. The gate would say yes about
 *       one organization while the read asked about another. C12.
 *   items read through `template_id` instead of copied
 *       The broker edits or deletes a template and every checklist already in
 *       use is silently rewritten under the agent. C6.
 *   remove-then-instantiate as two database transactions
 *       Guarded structurally by `writeAtomicity.guard`, and asserted here too:
 *       the handler must not be able to leave a transaction with no checklist.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";

import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";

const USER: string = randomUUID();
const TRANSACTION: string = randomUUID();
const OTHER_TRANSACTION: string = randomUUID();
const ORG_A = "00000000-0000-4000-8000-00003475f0a1"; // pii-allow-uuid: invented fixture id
const ORG_B = "00000000-0000-4000-8000-00003475f0b2"; // pii-allow-uuid: invented fixture id

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

/**
 * The boundary the REAL gate bottoms out at. Signed out, so `resolveOrgOutcome`
 * answers `no_session`, the strict reader answers `unknown`, and the gate
 * answers false — offline, with no socket opened.
 *
 * `from("organization_members")` answers ORG_B, and that is for C12. The two
 * resolvers this codebase has genuinely disagree: `resolveOrgIdOrRefusal` goes
 * through `getActiveOrganizationMembershipOutcome` (filters `license_status =
 * 'active'`,
 * accepts a personal organization), while `submissionService`'s private
 * `getUserOrganizationId` reads `organization_members` directly, EXCLUDES
 * personal organizations and applies no status filter. Wiring the raw read to a
 * DIFFERENT organization is what makes C12 able to tell them apart at all — with
 * both answering ORG_A the control would pass against either resolver and prove
 * nothing. Nothing reaches this branch in a correct build.
 */
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
      from: (_table: string) => {
        const qb: Record<string, any> = {};
        for (const m of ["select", "eq", "limit"]) qb[m] = (..._a: unknown[]) => qb;
        qb.order = (..._a: unknown[]) =>
          Promise.resolve({
            data: [
              {
                organization_id: "00000000-0000-4000-8000-00003475f0b2", // pii-allow-uuid: invented fixture id (ORG_B)
                organizations: { id: "00000000-0000-4000-8000-00003475f0b2" }, // pii-allow-uuid: invented fixture id (ORG_B)
              },
            ],
            error: null,
          });
        return qb;
      },
    }),
    getAuthSession: async () => ({ userId: "u-3475", accessToken: "t" }),
  },
}));

const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: (...args: unknown[]) => mockAudit(...args) },
}));

const mockGate = jest.fn();
const mockResolveOrg = jest.fn();
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: (...args: unknown[]) => mockGate(...args),
  resolveOrgIdOrRefusal: (...args: unknown[]) => mockResolveOrg(...args),
}));

const mockListTemplates = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: {
    listTemplates: (...args: unknown[]) => mockListTemplates(...args),
    invalidate: (...args: unknown[]) => mockInvalidate(...args),
  },
}));

import {
  CHECKLISTS_NOT_ALLOWED_ERROR,
  CHECKLISTS_NO_ORGANIZATION_ERROR,
  CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR,
  CHECKLIST_TEMPLATE_NOT_FOUND_ERROR,
  registerChecklistHandlers,
} from "../checklistHandlers";

const SHIPPED_GATE = jest.requireActual("../featureGateHandlers") as {
  isChecklistsAllowed: () => Promise<boolean>;
};

const SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

const TEMPLATE_ID = "<fixture:template-p1-active>";
const TEMPLATE_ID_2 = "<fixture:template-p2-active>";

/**
 * The listing the template service returns. Its shape is the one
 * `checklistTemplateService-3475.test.ts` derives from the committed
 * BACKLOG-3473 capture; the titles here are the ones the copy is asserted on.
 */
function templateListing(overrides: Partial<{ name: string; items: any[] }> = {}) {
  return {
    source: "live" as const,
    templates: [
      {
        id: TEMPLATE_ID,
        name: overrides.name ?? "Standard purchase",
        description: null,
        sortOrder: 10,
        updatedAt: "<timestamp>",
        items: overrides.items ?? [
          {
            id: "<fixture:item-p1-1>",
            title: "Signed purchase agreement",
            description: "the desktop tooltip",
            isRequired: true,
            expectedDocumentType: "contract",
            sortOrder: 10,
          },
          {
            id: "<fixture:item-p1-2>",
            title: "Inspection report",
            description: null,
            isRequired: false,
            expectedDocumentType: null,
            sortOrder: 20,
          },
        ],
      },
    ],
  };
}

/** BACKLOG-3476: the listing plus a second template, so two checklists can be added. */
function twoTemplateListing() {
  const listing = templateListing();
  return {
    ...listing,
    templates: [
      ...listing.templates,
      {
        id: TEMPLATE_ID_2,
        name: "Disclosures",
        description: null,
        sortOrder: 20,
        updatedAt: "<timestamp>",
        items: [
          {
            id: "<fixture:item-p2-1>",
            title: "Lead paint disclosure",
            description: null,
            isRequired: true,
            expectedDocumentType: "disclosure",
            sortOrder: 10,
          },
        ],
      },
    ],
  };
}

function buildDb(): TestDb {
  const db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner-3475@example.com", "oauth-3475");
  for (const t of [TRANSACTION, OTHER_TRANSACTION]) {
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)").run(
      t,
      USER,
      "5 Control Street",
    );
  }
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, body_plain, sent_at)
     VALUES ('e-mine', ?, 'Offer', 'body', '2026-03-01T10:00:00Z'),
            ('e-theirs', ?, 'Other deal', 'body', '2026-03-02T10:00:00Z')`,
  ).run(USER, USER);
  db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES ('c-mine', ?, ?, 'e-mine')",
  ).run(USER, TRANSACTION);
  db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, email_id) VALUES ('c-theirs', ?, ?, 'e-theirs')",
  ).run(USER, OTHER_TRANSACTION);
  return db;
}

const rows = (q: string, ...p: unknown[]) =>
  mockDb!.prepare(q).all(...(p as never[])) as Array<Record<string, unknown>>;
const count = (table: string): number =>
  (mockDb!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const evt = {} as IpcMainInvokeEvent;
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};

/** Put a checklist on TRANSACTION with the gate open, and return its id. */
async function seedChecklist(): Promise<string> {
  mockGate.mockResolvedValue(true);
  mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });
  mockListTemplates.mockResolvedValue(templateListing());
  const result = await invoke("checklists:select-template", {
    transactionId: TRANSACTION,
    templateId: TEMPLATE_ID,
  });
  expect(result.success).toBe(true);
  return result.result.checklistId;
}

const itemIds = (): string[] =>
  rows("SELECT id FROM transaction_checklist_items ORDER BY sort_order").map(
    (r) => r.id as string,
  );

beforeAll(() => {
  registerChecklistHandlers();
});

beforeEach(() => {
  mockDb = buildDb();
  mockGate.mockReset();
  mockResolveOrg.mockReset();
  mockListTemplates.mockReset();
  mockInvalidate.mockClear();
  mockAudit.mockClear();
  // Default: the REAL, SHIPPED gate decides, against a signed-out session.
  mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());
  mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });
  mockListTemplates.mockResolvedValue(templateListing());
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ---------------------------------------------------------------------------
// C9 — the gate, per channel
// ---------------------------------------------------------------------------

describe("BACKLOG-3475 C9 — every gated channel refuses when the plan cannot be read", () => {
  it("the real gate answers false here (the premise the six cases below rest on)", async () => {
    await expect(SHIPPED_GATE.isChecklistsAllowed()).resolves.toBe(false);
  });

  it("list-templates: refused, and the template service is never asked", async () => {
    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(result.templates).toBeUndefined();
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("select-template: refused, no checklist row, no audit row", async () => {
    const result = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(count("transaction_checklists")).toBe(0);
    expect(count("transaction_checklist_items")).toBe(0);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("set-item-checked: refused, and the item is untouched", async () => {
    const itemId = await (async () => {
      await seedChecklist();
      return itemIds()[0];
    })();
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:set-item-checked", { itemId, checked: true });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(
      rows("SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = ?", itemId),
    ).toEqual([{ is_checked: 0, checked_at: null }]);
  });

  it("set-item-note: refused, and the note is untouched", async () => {
    await seedChecklist();
    const itemId = itemIds()[0];
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:set-item-note", { itemId, note: "signed 3 Mar" });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(rows("SELECT note FROM transaction_checklist_items WHERE id = ?", itemId)).toEqual([
      { note: null },
    ]);
  });

  it("add-link: refused, and no group or member is written", async () => {
    await seedChecklist();
    const itemId = itemIds()[0];
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: ["e-mine"],
    });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(count("transaction_checklist_links")).toBe(0);
    expect(count("transaction_checklist_link_members")).toBe(0);
  });

  it("remove-link: refused, and the group survives", async () => {
    await seedChecklist();
    const itemId = itemIds()[0];
    const added = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: ["e-mine"],
    });
    const linkId = added.result.linkId;
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:remove-link", { linkId });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR });
    expect(count("transaction_checklist_links")).toBe(1);
    expect(count("transaction_checklist_link_members")).toBe(1);
  });
});

describe("BACKLOG-3475 C9 — the three ungated channels keep working in the same state", () => {
  it("get returns the checklist while the plan cannot be read", async () => {
    await seedChecklist();
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:get", { transactionId: TRANSACTION });

    expect(result.success).toBe(true);
    expect(result.checklists.checklists).toHaveLength(1);
    const [only] = result.checklists.checklists;
    expect(only.checklist.templateName).toBe("Standard purchase");
    expect(only.items.map((i: any) => i.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
    ]);
    expect(only.requiredTotal).toBe(1);
    expect(only.requiredDone).toBe(0);
    expect([result.checklists.requiredDone, result.checklists.requiredTotal]).toEqual([0, 1]);
  });

  it("remove clears the checklist while the plan cannot be read, and audits it", async () => {
    const checklistId = await seedChecklist();
    mockAudit.mockClear();
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:remove", { transactionId: TRANSACTION, checklistId });

    expect(result).toEqual({ success: true, changed: true });
    expect(count("transaction_checklists")).toBe(0);
    expect(count("transaction_checklist_items")).toBe(0);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      action: "TRANSACTION_UPDATE",
      resourceType: "TRANSACTION",
      resourceId: TRANSACTION,
      userId: USER,
      metadata: { reason: "checklist_removed", checklistId, templateId: TEMPLATE_ID },
    });
  });

  it("invalidate-templates works while the plan cannot be read", async () => {
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    expect(await invoke("checklists:invalidate-templates")).toEqual({ success: true });
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3475 C9 — the gated and ungated sets, by execution", () => {
  /**
   * The count in the module header, derived rather than described.
   *
   * Every registered `checklists:` channel is invoked with a VALID payload and
   * the plan unreadable, then sorted by what it answered. Nothing here greps
   * for `isChecklistsAllowed`: a handler that called the gate and ignored its
   * answer would be indistinguishable from a gated one by grep, and a channel
   * registered under a name nobody thought to search for would be invisible.
   *
   * The enumeration comes from `registeredHandlers`, so a tenth channel that
   * this list does not classify fails the first assertion instead of quietly
   * escaping the sweep.
   */
  it("exactly six channels refuse when the plan cannot be read, and three answer", async () => {
    const checklistId = await seedChecklist();
    const itemId = itemIds()[0];
    const added = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: ["e-mine"],
    });
    expect(added.success).toBe(true);
    const linkId = added.result.linkId;

    // From here the REAL gate decides, against a signed-out session: false.
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    // Valid payloads throughout. A channel that refused because its arguments
    // were malformed would look exactly like a gated one.
    const CHANNELS: Array<[string, unknown]> = [
      ["checklists:list-templates", undefined],
      [
        "checklists:select-template",
        { transactionId: OTHER_TRANSACTION, templateId: TEMPLATE_ID },
      ],
      ["checklists:set-item-checked", { itemId, checked: true }],
      ["checklists:set-item-note", { itemId, note: "signed 3 Mar" }],
      ["checklists:add-link", { itemId, kind: "email", targetIds: ["e-mine"] }],
      ["checklists:remove-link", { linkId }],
      // The ungated three last, and `remove` after `get`: it clears the rows
      // `get` is asked to return.
      ["checklists:get", { transactionId: TRANSACTION }],
      ["checklists:remove", { transactionId: TRANSACTION, checklistId }],
      ["checklists:invalidate-templates", undefined],
    ];

    // The sweep covers every channel this module registers — not a list
    // somebody remembered to keep up to date.
    expect([...registeredHandlers.keys()].filter((c) => c.startsWith("checklists:")).sort()).toEqual(
      CHANNELS.map(([channel]) => channel).sort(),
    );

    const refused: string[] = [];
    const answered: string[] = [];
    for (const [channel, args] of CHANNELS) {
      const result = args === undefined ? await invoke(channel) : await invoke(channel, args);
      if (result.error === CHECKLISTS_NOT_ALLOWED_ERROR) {
        refused.push(channel);
      } else {
        // Named in the failure output, so a surprise says WHICH channel.
        expect([channel, result.success]).toEqual([channel, true]);
        answered.push(channel);
      }
    }

    expect(refused).toEqual([
      "checklists:list-templates",
      "checklists:select-template",
      "checklists:set-item-checked",
      "checklists:set-item-note",
      "checklists:add-link",
      "checklists:remove-link",
    ]);
    expect(answered).toEqual([
      "checklists:get",
      "checklists:remove",
      "checklists:invalidate-templates",
    ]);
  });
});

describe("BACKLOG-3475 C9 — the ALLOWED side, so the refusals above are not vacuous", () => {
  beforeEach(() => {
    mockGate.mockResolvedValue(true);
  });

  it("every gated channel writes when the plan allows it", async () => {
    const listed = await invoke("checklists:list-templates");
    expect(listed.success).toBe(true);
    expect(listed.templates.map((t: any) => t.name)).toEqual(["Standard purchase"]);
    expect(listed.source).toBe("live");

    const selected = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    expect(selected.result.status).toBe("added");
    expect(count("transaction_checklist_items")).toBe(2);

    const itemId = itemIds()[0];
    expect(await invoke("checklists:set-item-checked", { itemId, checked: true })).toEqual({
      success: true,
      changed: true,
    });
    expect(await invoke("checklists:set-item-note", { itemId, note: "signed 3 Mar" })).toEqual({
      success: true,
      changed: true,
    });

    const added = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: ["e-mine"],
    });
    expect(added.result.status).toBe("added");
    expect(count("transaction_checklist_link_members")).toBe(1);

    expect(await invoke("checklists:remove-link", { linkId: added.result.linkId })).toEqual({
      success: true,
      changed: true,
    });
    expect(count("transaction_checklist_link_members")).toBe(0);
  });

  it("a tick writes checked_at and NO audit row; select does", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0].metadata.reason).toBe("checklist_selected");

    const itemId = itemIds()[0];
    await invoke("checklists:set-item-checked", { itemId, checked: true });
    const [ticked] = rows(
      "SELECT is_checked, checked_at FROM transaction_checklist_items WHERE id = ?",
      itemId,
    );
    expect(ticked.is_checked).toBe(1);
    expect(ticked.checked_at).not.toBeNull();
    expect(mockAudit).toHaveBeenCalledTimes(1); // still one: the tick audited nothing

    await invoke("checklists:set-item-checked", { itemId, checked: false });
    expect(
      rows("SELECT checked_at FROM transaction_checklist_items WHERE id = ?", itemId),
    ).toEqual([{ checked_at: null }]);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it("the same template added again is declined as exists and the original is untouched", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const before = itemIds();
    mockAudit.mockClear();

    const again = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    // The call RAN and answered; `success` is about whether it ran.
    expect(again.success).toBe(true);
    expect(again.result.status).toBe("exists");
    expect(itemIds()).toEqual(before);
    expect(count("transaction_checklists")).toBe(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("evidence belonging to ANOTHER transaction is refused, and nothing is written", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const itemId = itemIds()[0];

    const result = await invoke("checklists:add-link", {
      itemId,
      kind: "email",
      targetIds: ["e-mine", "e-theirs"],
    });

    expect(result.result.status).toBe("targets_not_in_transaction");
    expect(result.result.rejectedIds).toEqual(["e-theirs"]);
    expect(count("transaction_checklist_links")).toBe(0);
    expect(count("transaction_checklist_link_members")).toBe(0);
  });

  it("an empty targetIds list is refused at the boundary, before the db layer sees it", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const itemId = itemIds()[0];

    const result = await invoke("checklists:add-link", { itemId, kind: "email", targetIds: [] });

    // Not `targets_not_in_transaction` with an empty `rejectedIds`, which is the
    // wrong sentence for the cause. The db layer keeps its own guard for any
    // future caller; this channel never reaches it.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Validation error/);
    expect(result.result).toBeUndefined();
  });

  it("a malformed payload is refused rather than written", async () => {
    expect(await invoke("checklists:set-item-note", { itemId: "", note: "x" })).toMatchObject({
      success: false,
    });
    expect(
      await invoke("checklists:add-link", { itemId: "i", kind: "carrier-pigeon", targetIds: ["e-mine"] }),
    ).toMatchObject({ success: false });
    expect(count("transaction_checklist_links")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C12 — which organization the read asks about
// ---------------------------------------------------------------------------

describe("BACKLOG-3475 C12 — the org comes from the feature gate's resolver", () => {
  beforeEach(() => {
    mockGate.mockResolvedValue(true);
  });

  it("list-templates asks for the organization resolveOrgIdOrRefusal returned", async () => {
    // The two resolvers genuinely disagree: `resolveOrgIdOrRefusal` filters on
    // `license_status = 'active'` and accepts a personal organization, while
    // `submissionService.getUserOrganizationId()` excludes personal
    // organizations and applies no status filter. ORG_A is what the GATE just
    // used; anything else means the gate answered about one brokerage and the
    // read asked about another.
    mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });

    await invoke("checklists:list-templates");

    expect(mockListTemplates).toHaveBeenCalledTimes(1);
    expect(mockListTemplates).toHaveBeenCalledWith(ORG_A);
    expect(mockListTemplates).not.toHaveBeenCalledWith(ORG_B);
  });

  it("select-template asks for the same organization, not a second opinion", async () => {
    mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });

    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(mockListTemplates.mock.calls.map((c) => c[0])).toEqual([ORG_A]);
  });

  it("no organization is its own refusal, distinct from the plan's", async () => {
    mockResolveOrg.mockResolvedValue({ status: "none" });

    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR });
    expect(result.error).not.toBe(CHECKLISTS_NOT_ALLOWED_ERROR);
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("select-template also answers no-organization for a confirmed none, not unavailable", async () => {
    mockResolveOrg.mockResolvedValue({ status: "none" });

    const result = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(result).toEqual({ success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR });
    expect(mockListTemplates).not.toHaveBeenCalled();
    expect(count("transaction_checklists")).toBe(0);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-3539 — a failed org lookup must read as unavailable, not as
  // no-organization. The gate answered "allowed" from its own cached
  // membership read; the handler's OWN (uncached) lookup then fails — a
  // network blip, not a confirmed absence of any organization.
  // -------------------------------------------------------------------------

  it("BACKLOG-3539: list-templates reads a failed org lookup as unavailable, not no-organization", async () => {
    mockResolveOrg.mockResolvedValue({ status: "unavailable" });

    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR });
    expect(result.error).not.toBe(CHECKLISTS_NO_ORGANIZATION_ERROR);
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("BACKLOG-3539: select-template reads a failed org lookup as unavailable, and writes nothing", async () => {
    mockResolveOrg.mockResolvedValue({ status: "unavailable" });

    const result = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(result).toEqual({ success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR });
    expect(result.error).not.toBe(CHECKLISTS_NO_ORGANIZATION_ERROR);
    expect(mockListTemplates).not.toHaveBeenCalled();
    expect(count("transaction_checklists")).toBe(0);
  });

  it("templates that could not be READ are their own refusal, not an empty list", async () => {
    mockListTemplates.mockResolvedValue(null);

    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR });
    expect(result.templates).toBeUndefined();
  });

  it("an organization with no templates is a SUCCESSFUL empty listing", async () => {
    mockListTemplates.mockResolvedValue({ source: "live", templates: [] });

    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: true, templates: [], source: "live" });
  });

  it("select-template refuses when the templates could not be read, and writes nothing", async () => {
    mockListTemplates.mockResolvedValue(null);

    const result = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(result).toEqual({ success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR });
    expect(count("transaction_checklists")).toBe(0);
  });

  it("a template id that is not in the listing is refused, and writes nothing", async () => {
    const result = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: "<fixture:template-archived>",
    });

    expect(result).toEqual({ success: false, error: CHECKLIST_TEMPLATE_NOT_FOUND_ERROR });
    expect(count("transaction_checklists")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C6 — the copy is a copy
// ---------------------------------------------------------------------------

describe("BACKLOG-3475 C6 — editing the broker template never rewrites a checklist in use", () => {
  beforeEach(() => {
    mockGate.mockResolvedValue(true);
    mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });
  });

  it("renaming and deleting template items leaves the selected checklist exactly as it was", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const before = rows(
      `SELECT id, title, description, is_required, expected_document_type, sort_order
         FROM transaction_checklist_items ORDER BY sort_order`,
    );
    expect(before.map((r) => r.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
    ]);

    // The broker edits the template in the portal: the first item is renamed,
    // its required flag and document type change, and the second is deleted.
    // Then the desktop refreshes its cache.
    mockListTemplates.mockResolvedValue(
      templateListing({
        name: "Standard purchase (v2)",
        items: [
          {
            id: "<fixture:item-p1-1>",
            title: "RENAMED IN THE PORTAL",
            description: "rewritten",
            isRequired: false,
            expectedDocumentType: "offer",
            sortOrder: 10,
          },
        ],
      }),
    );
    await invoke("checklists:invalidate-templates");

    // Everything the checklist shows must be unchanged: it is a copy taken at
    // selection time, and `template_id` is provenance with nothing reading
    // through it.
    const after = rows(
      `SELECT id, title, description, is_required, expected_document_type, sort_order
         FROM transaction_checklist_items ORDER BY sort_order`,
    );
    expect(after).toEqual(before);

    const got = await invoke("checklists:get", { transactionId: TRANSACTION });
    const [detail] = got.checklists.checklists;
    expect(detail.items.map((i: any) => i.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
    ]);
    expect(detail.items.map((i: any) => i.isRequired)).toEqual([true, false]);
    expect(detail.items.map((i: any) => i.expectedDocumentType)).toEqual([
      "contract",
      null,
    ]);
    expect(detail.requiredTotal).toBe(1);
    // The NAME is a copy too — the row still says what the user picked.
    expect(detail.checklist.templateName).toBe("Standard purchase");
    expect(detail.checklist.templateId).toBe(TEMPLATE_ID);
  });

  it("a ticked item survives the template being edited, with its note and evidence", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const itemId = itemIds()[0];
    await invoke("checklists:set-item-checked", { itemId, checked: true });
    await invoke("checklists:set-item-note", { itemId, note: "signed 3 Mar" });
    await invoke("checklists:add-link", { itemId, kind: "email", targetIds: ["e-mine"] });

    mockListTemplates.mockResolvedValue(templateListing({ items: [] }));
    await invoke("checklists:invalidate-templates");

    const got = await invoke("checklists:get", { transactionId: TRANSACTION });
    const [detail] = got.checklists.checklists;
    expect(detail.items).toHaveLength(2);
    const [first] = detail.items;
    expect(first.isChecked).toBe(true);
    expect(first.checkedAt).not.toBeNull();
    expect(first.note).toBe("signed 3 Mar");
    expect(detail.linksByItemId[itemId]).toHaveLength(1);
    expect(detail.linksByItemId[itemId][0].label).toBe("Offer");
    expect(detail.linksByItemId[itemId][0].members.map((m: any) => m.emailId)).toEqual([
      "e-mine",
    ]);
  });

});

// ---------------------------------------------------------------------------
// BACKLOG-3476 — several checklists per transaction, through the channels
// ---------------------------------------------------------------------------

describe("BACKLOG-3476 — several checklists, through IPC", () => {
  beforeEach(() => {
    mockGate.mockResolvedValue(true);
    mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG_A });
    mockListTemplates.mockResolvedValue(twoTemplateListing());
  });

  const add = async (templateId: string): Promise<string> => {
    const result = await invoke("checklists:select-template", { transactionId: TRANSACTION, templateId });
    expect(result.result.status).toBe("added");
    return result.result.checklistId;
  };

  it("A-1: adding a second template leaves the first checklist's tick, note and link rows intact", async () => {
    const first = await add(TEMPLATE_ID);
    const itemId = itemIds()[0];
    await invoke("checklists:set-item-checked", { itemId, checked: true });
    await invoke("checklists:set-item-note", { itemId, note: "signed 3 Mar" });
    await invoke("checklists:add-link", { itemId, kind: "email", targetIds: ["e-mine"] });
    const snapshot = () => ({
      items: rows("SELECT * FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY id", first),
      links: rows("SELECT * FROM transaction_checklist_links ORDER BY id"),
      members: rows("SELECT * FROM transaction_checklist_link_members ORDER BY id"),
    });
    const before = snapshot();

    await add(TEMPLATE_ID_2);

    expect(count("transaction_checklists")).toBe(2);
    expect(snapshot()).toEqual(before);
    const got = await invoke("checklists:get", { transactionId: TRANSACTION });
    expect(got.checklists.checklists.map((d: any) => d.checklist.templateName)).toEqual([
      "Standard purchase",
      "Disclosures",
    ]);
    expect([got.checklists.requiredDone, got.checklists.requiredTotal]).toEqual([1, 2]);
  });

  it("A-11: remove without a checklistId is refused and deletes nothing", async () => {
    await add(TEMPLATE_ID);
    await add(TEMPLATE_ID_2);

    const result = await invoke("checklists:remove", { transactionId: TRANSACTION });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Validation error/);
    expect(count("transaction_checklists")).toBe(2);
  });

  it("remove takes off ONLY the named checklist and audits which one", async () => {
    const first = await add(TEMPLATE_ID);
    const second = await add(TEMPLATE_ID_2);
    mockAudit.mockClear();

    const result = await invoke("checklists:remove", { transactionId: TRANSACTION, checklistId: second });

    expect(result).toEqual({ success: true, changed: true });
    expect(rows("SELECT id FROM transaction_checklists").map((r) => r.id)).toEqual([first]);
    expect(mockAudit.mock.calls[0][0].metadata).toEqual({
      reason: "checklist_removed",
      transactionId: TRANSACTION,
      checklistId: second,
      templateId: TEMPLATE_ID_2,
    });
  });

});
