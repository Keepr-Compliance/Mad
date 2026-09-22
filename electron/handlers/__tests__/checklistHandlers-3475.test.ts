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
 * why every gated channel is asserted separately and the two ungated ones are
 * asserted to keep working in the same state.
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH
 * ===========================================================================
 *   one handler that forgets the gate
 *       Five channels refuse, the sixth writes. Nothing else in the repo can
 *       see this: the strict READER is guarded by the 3349 and 3365 suites, but
 *       no existing test knows a handler is supposed to call it.
 *   a fail-OPEN gate (`featureGateService.checkFeature`)
 *       Answers ALLOWED for a key that is not in the cache — and the
 *       `transaction_checklists` row is not applied to production, so every
 *       organization on earth would read allowed.
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

// The boundary the REAL gate bottoms out at. Signed out, so `resolveOrgOutcome`
// answers `no_session`, the strict reader answers `unknown`, and the gate
// answers false — offline, with no socket opened.
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    }),
  },
}));

const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: (...args: unknown[]) => mockAudit(...args) },
}));

const mockGate = jest.fn();
const mockResolveOrgId = jest.fn();
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: (...args: unknown[]) => mockGate(...args),
  resolveOrgId: (...args: unknown[]) => mockResolveOrgId(...args),
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
  mockResolveOrgId.mockResolvedValue(ORG_A);
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
  mockResolveOrgId.mockReset();
  mockListTemplates.mockReset();
  mockInvalidate.mockClear();
  mockAudit.mockClear();
  // Default: the REAL, SHIPPED gate decides, against a signed-out session.
  mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());
  mockResolveOrgId.mockResolvedValue(ORG_A);
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

describe("BACKLOG-3475 C9 — the two ungated channels keep working in the same state", () => {
  it("get returns the checklist while the plan cannot be read", async () => {
    await seedChecklist();
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:get", { transactionId: TRANSACTION });

    expect(result.success).toBe(true);
    expect(result.checklist.checklist.templateName).toBe("Standard purchase");
    expect(result.checklist.items.map((i: any) => i.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
    ]);
    expect(result.checklist.requiredTotal).toBe(1);
    expect(result.checklist.requiredDone).toBe(0);
  });

  it("remove clears the checklist while the plan cannot be read, and audits it", async () => {
    await seedChecklist();
    mockAudit.mockClear();
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    const result = await invoke("checklists:remove", { transactionId: TRANSACTION });

    expect(result).toEqual({ success: true, changed: true });
    expect(count("transaction_checklists")).toBe(0);
    expect(count("transaction_checklist_items")).toBe(0);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      action: "TRANSACTION_UPDATE",
      resourceType: "TRANSACTION",
      resourceId: TRANSACTION,
      userId: USER,
      metadata: { reason: "checklist_removed" },
    });
  });

  it("invalidate-templates works while the plan cannot be read", async () => {
    mockGate.mockImplementation(() => SHIPPED_GATE.isChecklistsAllowed());

    expect(await invoke("checklists:invalidate-templates")).toEqual({ success: true });
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
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
    expect(selected.result.status).toBe("selected");
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

  it("a tick writes checked_at and NO audit row; select and replace do", async () => {
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

    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
      replaceExisting: true,
    });
    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit.mock.calls[1][0].metadata.reason).toBe("checklist_replaced");
  });

  it("a second pick without replaceExisting is declined and the original is untouched", async () => {
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

  it("list-templates asks for the organization resolveOrgId returned", async () => {
    // The two resolvers genuinely disagree: `resolveOrgId` filters on
    // `license_status = 'active'` and accepts a personal organization, while
    // `submissionService.getUserOrganizationId()` excludes personal
    // organizations and applies no status filter. ORG_A is what the GATE just
    // used; anything else means the gate answered about one brokerage and the
    // read asked about another.
    mockResolveOrgId.mockResolvedValue(ORG_A);

    await invoke("checklists:list-templates");

    expect(mockListTemplates).toHaveBeenCalledTimes(1);
    expect(mockListTemplates).toHaveBeenCalledWith(ORG_A);
    expect(mockListTemplates).not.toHaveBeenCalledWith(ORG_B);
  });

  it("select-template asks for the same organization, not a second opinion", async () => {
    mockResolveOrgId.mockResolvedValue(ORG_A);

    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });

    expect(mockListTemplates.mock.calls.map((c) => c[0])).toEqual([ORG_A]);
  });

  it("no organization is its own refusal, distinct from the plan's", async () => {
    mockResolveOrgId.mockResolvedValue(null);

    const result = await invoke("checklists:list-templates");

    expect(result).toEqual({ success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR });
    expect(result.error).not.toBe(CHECKLISTS_NOT_ALLOWED_ERROR);
    expect(mockListTemplates).not.toHaveBeenCalled();
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
    mockResolveOrgId.mockResolvedValue(ORG_A);
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
    expect(got.checklist.items.map((i: any) => i.title)).toEqual([
      "Signed purchase agreement",
      "Inspection report",
    ]);
    expect(got.checklist.items.map((i: any) => i.isRequired)).toEqual([true, false]);
    expect(got.checklist.items.map((i: any) => i.expectedDocumentType)).toEqual([
      "contract",
      null,
    ]);
    expect(got.checklist.requiredTotal).toBe(1);
    // The NAME is a copy too — the row still says what the user picked.
    expect(got.checklist.checklist.templateName).toBe("Standard purchase");
    expect(got.checklist.checklist.templateId).toBe(TEMPLATE_ID);
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
    expect(got.checklist.items).toHaveLength(2);
    const [first] = got.checklist.items;
    expect(first.isChecked).toBe(true);
    expect(first.checkedAt).not.toBeNull();
    expect(first.note).toBe("signed 3 Mar");
    expect(got.checklist.linksByItemId[itemId]).toHaveLength(1);
    expect(got.checklist.linksByItemId[itemId][0].label).toBe("Offer");
    expect(got.checklist.linksByItemId[itemId][0].members.map((m: any) => m.emailId)).toEqual([
      "e-mine",
    ]);
  });

  it("only an explicit replace rewrites the checklist, and it does so in one step", async () => {
    await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
    });
    const original = itemIds();

    mockListTemplates.mockResolvedValue(
      templateListing({
        name: "Standard purchase (v2)",
        items: [
          {
            id: "<fixture:item-p1-1>",
            title: "RENAMED IN THE PORTAL",
            description: null,
            isRequired: true,
            expectedDocumentType: "offer",
            sortOrder: 10,
          },
        ],
      }),
    );

    const replaced = await invoke("checklists:select-template", {
      transactionId: TRANSACTION,
      templateId: TEMPLATE_ID,
      replaceExisting: true,
    });

    expect(replaced.result.status).toBe("replaced");
    // A transaction is never left with no checklist: the old rows are gone and
    // the new ones are present in the same read.
    expect(count("transaction_checklists")).toBe(1);
    const now = itemIds();
    expect(now).toHaveLength(1);
    expect(original).not.toContain(now[0]);
    expect(
      rows("SELECT title, template_name FROM transaction_checklist_items JOIN transaction_checklists ON transaction_checklists.id = transaction_checklist_items.checklist_id"),
    ).toEqual([{ title: "RENAMED IN THE PORTAL", template_name: "Standard purchase (v2)" }]);
  });
});
