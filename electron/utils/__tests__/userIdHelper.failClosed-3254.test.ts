/**
 * @jest-environment node
 */
/**
 * BACKLOG-3254 — the user-id resolver answers only for an id it can confirm.
 *
 * ===========================================================================
 * WHAT THIS SUITE PINS
 * ===========================================================================
 * `getValidUserId` / `getValidUserIdSync` answer the question "which user is
 * this call for?". Given an id, they confirm it against `users_local` and
 * return it. Given an id that is not there, they return `null` — they do not
 * substitute a different id.
 *
 * Both halves are load-bearing and they pull in opposite directions:
 *
 *   - "returns null for an id absent from users_local" is the change.
 *   - "returns the supplied id when it is present" and "resolves each of two
 *     local users to its own id and its own rows" are the guard against
 *     OVER-closing. A resolver that refused ids it should accept would satisfy
 *     the first test and break the app.
 *
 * The over-closing guard is why this file seeds TWO rows. A one-row fixture
 * cannot tell "returns the id you asked for" from "returns the only id there
 * is", so every assertion below would still pass against a resolver that had
 * simply gone back to answering from the table.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS A DELEGATOR AND NOT A HAND-WRITTEN ANSWER
 * ===========================================================================
 * `databaseService.getUserById` here reads the SAME seeded table the resolver's
 * own fallback statement reads, rather than returning a hard-coded object for
 * one known id. A hand-written mock can describe a state the database cannot
 * emit — an id that `getUserById` accepts but `users_local` does not hold, or
 * the reverse — and a control built on one of those proves nothing about the
 * code it is pointed at.
 *
 * Fixture values are reserved-for-documentation only (`example.com`).
 */

import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../../services/db/contactIdentitySchemaSql";
import { LOCAL_USER_BY_ID_SQL } from "../../services/db/localUserSql";

let db: TestDb;

// The real DB layer, pointed at a real database.
jest.mock("../../services/db/core/dbConnection", () => ({
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

jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
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

jest.mock("../../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn() },
}));

/**
 * `getUserById` answers from the seeded `users_local`, not from a list written
 * here. `isInitialized` must be present and true or `getValidUserIdSync`
 * returns at its uninitialised-database branch (`userIdHelper.ts`) without ever
 * reaching the code under test — a green that would mean nothing.
 */
jest.mock("../../services/databaseService", () => {
  const real = jest.requireActual("../../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      getUserById: async (id: string) =>
        (db.prepare(LOCAL_USER_BY_ID_SQL).get(id) as { id: string } | undefined) ?? null,
      getRawDatabase: () => db,
      isInitialized: () => true,
      getRemovedContacts: (userId: string) => real.getRemovedContacts(userId),
      getContactById: (id: string) => real.getContactById(id),
    },
  };
});

import { getValidUserId, getValidUserIdSync } from "../userIdHelper";
import { registerContactHandlers } from "../../handlers/contactHandlers";
import { deleteContact } from "../../services/db/contactDbService";

/**
 * Real UUIDs, not readable slugs — contact ids are minted with
 * `crypto.randomUUID()` in production and the handlers validate the shape, so a
 * readable slug describes an id the app can never emit. Fixed rather than
 * random so a failure is reproducible.
 */
const USER_A = "3f2a1c60-0000-4000-8000-00000000325a";  // pii-allow-uuid: invented, not from any live row
const USER_B = "3f2a1c60-0000-4000-8000-00000000325b";  // pii-allow-uuid: invented, not from any live row
/** Well-formed, and deliberately not seeded. */
const NOT_A_LOCAL_USER = "3f2a1c60-0000-4000-8000-0000000032ff";  // pii-allow-uuid: invented, not from any live row

const CONTACT_A = "3f2a1c60-0000-4000-8000-0000000c0f7a";  // pii-allow-uuid: invented, not from any live row
const CONTACT_B = "3f2a1c60-0000-4000-8000-0000000c0f7b";  // pii-allow-uuid: invented, not from any live row

const SCHEMA_PATH = path.join(__dirname, "../../database/schema.sql");

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>;

/** Pull a registered handler out of the ipcMain.handle mock by channel name. */
function handlerFor(channel: string): Handler {
  const entry = mockIpcHandle.mock.calls.find((c) => c[0] === channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry[1] as Handler;
}

const EVENT = {} as IpcMainInvokeEvent;

beforeEach(() => {
  jest.clearAllMocks();

  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  const insertUser = db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', ?)`,
  );
  insertUser.run(USER_A, "a@example.com", "oauth-3254-a");
  insertUser.run(USER_B, "b@example.com", "oauth-3254-b");

  const insertContact = db.prepare(
    `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
     VALUES (?, ?, ?, 'manual', 1)`,
  );
  insertContact.run(CONTACT_A, USER_A, "Ada Example");
  insertContact.run(CONTACT_B, USER_B, "Bo Example");

  registerContactHandlers({} as never);
});

afterEach(() => {
  db.close();
});

describe("getValidUserId", () => {
  /**
   * C1 — the over-closing guard. Passes before and after the fail-closed
   * change; its job is to go RED if the resolver is ever made to refuse ids it
   * should accept.
   */
  it("returns the supplied id when it is present, with two rows in users_local", async () => {
    await expect(getValidUserId(USER_A, "Test")).resolves.toBe(USER_A);
    await expect(getValidUserId(USER_B, "Test")).resolves.toBe(USER_B);
  });

  it("returns the supplied id synchronously when it is present, with two rows in users_local", () => {
    expect(getValidUserIdSync(USER_A, "Test")).toBe(USER_A);
    expect(getValidUserIdSync(USER_B, "Test")).toBe(USER_B);
  });

  /**
   * C2 — the change itself, and the revert target for the control run. The id
   * below is well-formed and simply not in the table; the answer is that there
   * is no answer, not a different id.
   */
  it("returns null for an id absent from users_local", async () => {
    await expect(getValidUserId(NOT_A_LOCAL_USER, "Test")).resolves.toBeNull();
  });

  it("returns null synchronously for an id absent from users_local", () => {
    expect(getValidUserIdSync(NOT_A_LOCAL_USER, "Test")).toBeNull();
  });
});

describe("two local users", () => {
  /**
   * C4 — the second half of the over-closing guard, and the one that reaches
   * past the resolver into a handler. Each id must resolve to itself AND to its
   * own rows; asserted as ID SETS rather than counts, because two rows of the
   * wrong provenance count the same as two of the right one.
   *
   * `contacts:get-removed` is the handler leg because its query is hard-scoped
   * in SQL (`WHERE c.user_id = ? AND c.removed_at IS NOT NULL`) rather than
   * optionally scoped, so what it returns measures the resolver's answer and
   * not a filter the service applied on its own.
   *
   * No sign-in code is exercised or changed by BACKLOG-3254, so sign-in itself
   * is inherited here rather than re-tested.
   */
  it("resolves each of two local users to its own id and its own rows", async () => {
    await deleteContact(CONTACT_A);
    await deleteContact(CONTACT_B);

    await expect(getValidUserId(USER_A, "Test")).resolves.toBe(USER_A);
    await expect(getValidUserId(USER_B, "Test")).resolves.toBe(USER_B);

    const forA = (await handlerFor("contacts:get-removed")(EVENT, USER_A as never)) as {
      success: boolean;
      contacts?: Array<{ id: string }>;
    };
    const forB = (await handlerFor("contacts:get-removed")(EVENT, USER_B as never)) as {
      success: boolean;
      contacts?: Array<{ id: string }>;
    };

    expect(forA.success).toBe(true);
    expect(forB.success).toBe(true);
    expect(forA.contacts?.map((c) => c.id).sort()).toEqual([CONTACT_A]);
    expect(forB.contacts?.map((c) => c.id).sort()).toEqual([CONTACT_B]);
  });
});
