/**
 * @jest-environment node
 */
/**
 * BACKLOG-2367 — handler tests for `contacts:restore` and `contacts:get-removed`.
 *
 * ===========================================================================
 * WHY THESE ROUTE THROUGH THE REAL SCHEMA INSTEAD OF MOCKING THE DB LAYER
 * ===========================================================================
 * The obvious way to test `contacts:restore` is to mock
 * `databaseService.getContactById` to return `{ removed_reason: 'user_deleted' }`
 * and assert the audit call. That test would pass against a BROKEN
 * implementation, because the whole defect it needs to catch lives in the layer
 * the mock replaces.
 *
 * The real `getContactById` ends in `validateResponse(ContactSchema, …)`, which
 * parses with a plain (non-strict) `z.object` and therefore STRIPS undeclared
 * keys. `ContactSchema` declared neither tombstone field, so `removed_reason`
 * arrived as `undefined` and the handler recorded `restored_from: null` on
 * every restore. It type-checked, because `models.ts` declares both fields.
 * Review of PR #2211 found it by execution; no unit test could have, and 11,000+
 * green tests did not.
 *
 * A mock returning `{ removed_reason: 'user_deleted' }` therefore describes a
 * state the real producer CANNOT EMIT — the exact fixture failure this repo
 * treats as a blocking defect. So `databaseService` here is a thin delegator
 * onto the REAL `contactDbService`, whose `dbConnection` is pointed at a REAL
 * SQLite database built from the REAL `schema.sql`. Everything between the IPC
 * boundary and the disk is production code.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range.
 */

import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../services/db/contactIdentitySchemaSql";

let db: TestDb;

// The real DB layer, pointed at a real database.
jest.mock("../services/db/core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
}));

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args) },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

const mockAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: (...args: unknown[]) => mockAuditLog(...args) },
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

/**
 * `databaseService` delegates to the REAL contactDbService. This is the line
 * that makes the suite able to see the schema-stripping defect: `getContactById`
 * is the production function, ContactSchema and all.
 */
jest.mock("../services/databaseService", () => {
  const real = jest.requireActual("../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      getContactById: (id: string) => real.getContactById(id),
      restoreContact: (id: string) => real.restoreContact(id),
      getRemovedContacts: (userId: string) => real.getRemovedContacts(userId),
      getUserById: (id: string) => Promise.resolve(id === USER ? { id } : null),
      // getValidUserId falls back to "any user in the database" when the
      // provided id is unknown — this is a single-user desktop app. Pointed at
      // the real test database so that fallback runs for real.
      getRawDatabase: () => db,
    },
  };
});

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn() },
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { deleteContact, removeContact } from "../services/db/contactDbService";

/**
 * Real UUIDs, not readable slugs. `validateContactId` in the handler requires a
 * valid UUID, and contact ids are minted with `crypto.randomUUID()` in
 * production — so a readable slug like "c-dana" describes an id the app can
 * never emit, and the first run of this suite returned a validation error from
 * every restore instead of exercising the path at all. Fixed ids rather than
 * random ones so failures are reproducible.
 */
const USER = "3f2a1c60-0000-4000-8000-000000002367";
const DANA = "3f2a1c60-0000-4000-8000-00000000da4a";
const SCHEMA_PATH = path.join(__dirname, "../database/schema.sql");

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>;

/** Pull a registered handler out of the ipcMain.handle mock by channel name. */
function handlerFor(channel: string): Handler {
  const entry = mockIpcHandle.mock.calls.find((c) => c[0] === channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry[1] as Handler;
}

const EVENT = {} as IpcMainInvokeEvent;

/** The metadata object of the single audit entry written. */
function auditMetadata(): Record<string, unknown> {
  expect(mockAuditLog).toHaveBeenCalledTimes(1);
  return mockAuditLog.mock.calls[0][0].metadata as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();

  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // BACKLOG-2993: the v56 tombstone columns (and every other chain-added
  // column) now come from the baseline schema.sql exec'd above — the
  // per-migration DDL bolt-ons this fixture used to apply are gone with
  // the chain.
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2367-handler')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
     VALUES (?, ?, 'Dana Example', 'manual', 1)`,
  ).run(DANA, USER);
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('em-dana', ?, 'dana@example.com', 1)",
  ).run(DANA);

  registerContactHandlers({} as never);
});

afterEach(() => {
  db.close();
});

describe("contacts:restore", () => {
  it("records what the contact was removed FOR — the field zod was stripping", async () => {
    await deleteContact(DANA);

    const result = (await handlerFor("contacts:restore")(EVENT, DANA as never)) as {
      success: boolean;
      restored?: boolean;
    };

    expect(result).toEqual({ success: true, restored: true });

    // THE ASSERTION THIS SUITE EXISTS FOR. Before ContactSchema declared the
    // tombstone columns this was `null` on every single restore, and nothing
    // anywhere reported a problem.
    expect(auditMetadata()).toMatchObject({
      name: "Dana Example",
      reason: "restore",
      restored_from: "user_deleted",
    });
  });

  it("distinguishes an un-import from a delete in the trail", async () => {
    await removeContact(DANA);

    await handlerFor("contacts:restore")(EVENT, DANA as never);

    // The two removal paths differ ONLY by this value. Collapsing both to null
    // — which is what the stripped schema did — erases the distinction.
    expect(auditMetadata().restored_from).toBe("user_unimported");
  });

  it("logs the restore under a verb the audit_logs CHECK constraint permits", async () => {
    await deleteContact(DANA);

    await handlerFor("contacts:restore")(EVENT, DANA as never);

    const entry = mockAuditLog.mock.calls[0][0];
    // A verb outside the permitted set would be swallowed by auditService.log's
    // catch and write no row at all, while still reporting success.
    expect(entry.action).toBe("CONTACT_UPDATE");
    expect(entry.resourceType).toBe("CONTACT");
    expect(entry.resourceId).toBe(DANA);
    expect(entry.userId).toBe(USER);

    const permitted = readFileSync(SCHEMA_PATH, "utf8")
      .split("action TEXT NOT NULL CHECK (action IN (")[1]
      .split("))")[0];
    expect(permitted).toContain(`'${entry.action}'`);
  });

  it("actually clears the tombstone", async () => {
    await deleteContact(DANA);

    await handlerFor("contacts:restore")(EVENT, DANA as never);

    const row = db
      .prepare("SELECT removed_at, removed_reason FROM contacts WHERE id = ?")
      .get(DANA) as { removed_at: string | null; removed_reason: string | null };
    expect(row.removed_at).toBeNull();
    expect(row.removed_reason).toBeNull();
  });

  it("reports a stale click as a successful no-op, and writes NO audit entry", async () => {
    // The contact is already active. Restoring is not an error — but it also
    // did not happen, so it must not appear in the trail.
    const result = await handlerFor("contacts:restore")(EVENT, DANA as never);

    expect(result).toEqual({ success: true, restored: false });
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("rejects an invalid contact id without touching the database", async () => {
    const result = (await handlerFor("contacts:restore")(EVENT, "" as never)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/[Vv]alidation/);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});

describe("contacts:get-removed", () => {
  it("returns the removed contacts with their reason and surviving-role count", async () => {
    await deleteContact(DANA);

    const result = (await handlerFor("contacts:get-removed")(EVENT, USER as never)) as {
      success: boolean;
      contacts?: Array<Record<string, unknown>>;
    };

    expect(result.success).toBe(true);
    expect(result.contacts?.map((c) => c.id)).toEqual([DANA]);
    expect(result.contacts?.[0]).toMatchObject({
      display_name: "Dana Example",
      email: "dana@example.com",
      removed_reason: "user_deleted",
      active_role_count: 0,
    });
  });

  it("returns an empty list — not an error — for a user with nothing removed", async () => {
    const result = (await handlerFor("contacts:get-removed")(EVENT, USER as never)) as {
      success: boolean;
      contacts?: unknown[];
    };

    expect(result).toEqual({ success: true, contacts: [] });
  });

  it("falls back to the local user when the renderer sends an unknown id", async () => {
    // Documents REAL behaviour, not the behaviour this test first assumed.
    // `getValidUserId` resolves an unrecognised id to "any user in the
    // database" (userIdHelper.ts) because this is a single-user desktop app —
    // it is a deliberate recovery path for a stale renderer id, not a leak.
    // The first version of this test asserted an empty list and failed, which
    // is the test being wrong rather than the handler.
    await deleteContact(DANA);

    const result = (await handlerFor("contacts:get-removed")(
      EVENT,
      "11111111-2222-4333-8444-555555555555" as never,
    )) as { success: boolean; contacts?: Array<{ id: string }> };

    expect(result.success).toBe(true);
    expect(result.contacts?.map((c) => c.id)).toEqual([DANA]);
  });
});
