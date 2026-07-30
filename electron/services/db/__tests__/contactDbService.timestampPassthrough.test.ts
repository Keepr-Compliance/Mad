/**
 * @jest-environment node
 *
 * BACKLOG-1745 Part 2: verify createContact persists last_inbound_at /
 * last_outbound_at when caller supplies them (e.g. importing a contact from a
 * message-derived external row). Without this passthrough, the new contact row
 * gets NULL timestamps and the unified sort in getContactsSortedByActivity
 * (Part 1) sinks it to the bottom of the picker list, producing the observed
 * "list reorders after import" bug.
 *
 * Uses mock-based testing (same pattern as contactDbService.unifiedSort.test.ts)
 * to bypass the local native-module rebuild requirement. Asserts directly on
 * the SQL + params passed to dbRun, which is the production code path.
 */

import { jest } from "@jest/globals";

// Mock core/dbConnection (paths relative to test file location)
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockDbRun = jest.fn();
const mockDbTransaction = jest.fn((fn: () => unknown) => fn());

jest.mock("../core/dbConnection", () => ({
  dbGet: mockDbGet,
  dbAll: mockDbAll,
  dbRun: mockDbRun,
  dbTransaction: mockDbTransaction,
  setDb: jest.fn(),
}));

// Mock logService
jest.mock("../../logService", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

// Mock contactsService (macOS bridge — referenced at top of contactDbService module)
jest.mock("../../contactsService", () => ({ getContactNames: jest.fn() }));

// Mock contactWorkerPool
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

// Mock schemas (validateResponse is a pass-through for these tests)
jest.mock("../../../schemas", () => ({
  ContactSchema: {},
  validateResponse: (_schema: unknown, data: unknown) => data,
}));

import { createContact } from "../contactDbService";

const USER_ID = "user-1";

/**
 * After dbRun is called for the INSERT INTO contacts row, the test inspects
 * mockDbRun.mock.calls[0] which is [sql, params]. We assert the params array
 * matches the expected column order (id, user_id, display_name, company,
 * title, source, is_imported, last_inbound_at, last_outbound_at).
 *
 * The implementation also issues a final getContactById SELECT — we mock
 * dbGet to return a stub row so createContact resolves successfully.
 */
beforeEach(() => {
  jest.clearAllMocks();
  // getContactById returns a stub so createContact doesn't throw at the tail.
  mockDbGet.mockReturnValue({ id: "stub-id", user_id: USER_ID, display_name: "Stub", source: "manual" });
});

/**
 * Extract the params of the dbRun call that targets `INSERT INTO contacts`.
 * createContact also issues INSERT calls into contact_phones / contact_emails;
 * we want the contacts-table insert specifically.
 */
function getContactInsertParams(): unknown[] | undefined {
  const call = mockDbRun.mock.calls.find((c) => {
    const sql = c[0] as string;
    return typeof sql === "string"
      && sql.includes("INSERT INTO contacts")
      && !sql.includes("contact_phones")
      && !sql.includes("contact_emails");
  });
  return call ? (call[1] as unknown[]) : undefined;
}

describe("BACKLOG-1745 Part 2: createContact persists engagement timestamps", () => {
  it("includes last_inbound_at and last_outbound_at columns in the INSERT SQL", async () => {
    await createContact({
      user_id: USER_ID,
      display_name: "Eliya",
      source: "contacts_app",
      is_imported: true,
      last_inbound_at: "2026-05-15T08:30:00Z",
    } as Parameters<typeof createContact>[0]);

    const insertCall = mockDbRun.mock.calls.find((c) => {
      const sql = c[0] as string;
      return typeof sql === "string"
        && sql.includes("INSERT INTO contacts")
        && !sql.includes("contact_phones")
        && !sql.includes("contact_emails");
    });
    expect(insertCall).toBeDefined();
    const sql = insertCall![0] as string;
    expect(sql).toMatch(/last_inbound_at/);
    expect(sql).toMatch(/last_outbound_at/);
  });

  it("passes last_inbound_at as INSERT param when caller supplies it (external-to-imported transition)", async () => {
    const externalRecency = "2026-05-15T08:30:00Z";
    await createContact({
      user_id: USER_ID,
      display_name: "Eliya",
      source: "contacts_app",
      is_imported: true,
      last_inbound_at: externalRecency,
    } as Parameters<typeof createContact>[0]);

    const params = getContactInsertParams();
    expect(params).toBeDefined();
    // Column order: id, user_id, display_name, company, title, source, is_imported, last_inbound_at, last_outbound_at
    expect(params![7]).toBe(externalRecency);
    expect(params![8]).toBeNull();
  });

  it("passes last_outbound_at as INSERT param when caller supplies it", async () => {
    const ts = "2026-04-01T12:00:00Z";
    await createContact({
      user_id: USER_ID,
      display_name: "Outbound Only",
      source: "manual",
      is_imported: true,
      last_outbound_at: ts,
    } as Parameters<typeof createContact>[0]);

    const params = getContactInsertParams();
    expect(params![7]).toBeNull();
    expect(params![8]).toBe(ts);
  });

  it("passes BOTH timestamps when caller supplies both", async () => {
    const inbound = "2026-06-01T10:00:00Z";
    const outbound = "2026-06-02T11:00:00Z";
    await createContact({
      user_id: USER_ID,
      display_name: "Both",
      source: "contacts_app",
      is_imported: true,
      last_inbound_at: inbound,
      last_outbound_at: outbound,
    } as Parameters<typeof createContact>[0]);

    const params = getContactInsertParams();
    expect(params![7]).toBe(inbound);
    expect(params![8]).toBe(outbound);
  });

  it("passes NULL for both timestamps when caller omits them (existing behavior preserved)", async () => {
    await createContact({
      user_id: USER_ID,
      display_name: "Manual Add",
      source: "manual",
      is_imported: true,
    } as Parameters<typeof createContact>[0]);

    const params = getContactInsertParams();
    expect(params![7]).toBeNull();
    expect(params![8]).toBeNull();
  });
});
