/**
 * @jest-environment node
 */

/**
 * BACKLOG-2354: the get-all list path (Clients & Contacts screen) must return a
 * populated `last_communication_at` per imported contact so the picker's default
 * "Recent" sort has data — instead of every contact tying on an empty timestamp
 * and the list degenerating to the invisible email tiebreaker.
 *
 * We assert (1) the imported-contacts query embeds the shared recency subquery
 * (all four channels), and (2) the timestamp the DB computes survives back out
 * through `getImportedContactsByUserId` unchanged.
 */


const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockDbRun = jest.fn();
const mockDbTransaction = jest.fn((fn: () => unknown) => fn());

jest.mock("../core/dbConnection", () => ({
  dbGet: mockDbGet,
  dbAll: mockDbAll,
  dbRun: mockDbRun,
  dbTransaction: mockDbTransaction,
}));

jest.mock("../../logService", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(),
}));

// Pool NOT ready -> getImportedContactsByUserIdAsync falls back to the sync
// getImportedContactsByUserId, which is what runs the SQL we assert on.
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

jest.mock("../../../schemas", () => ({
  ContactSchema: {},
  validateResponse: (_schema: unknown, data: unknown) => data,
}));

import {
  getImportedContactsByUserId,
  getImportedContactsByUserIdAsync,
} from "../contactDbService";
import { IMPORTED_CONTACT_LAST_COMMUNICATION_SQL } from "../contactRecencySql";

const USER_ID = "user-1";

/** SQL string passed to the imported-contacts SELECT (the one carrying recency). */
function importedQuerySql(): string {
  // Require BOTH markers so we never match the message-derived query, which also
  // aliases `... as last_communication_at` but has no `all_emails_json`.
  const call = mockDbAll.mock.calls.find(
    ([sql]) =>
      typeof sql === "string" &&
      (sql as string).includes("as last_communication_at") &&
      (sql as string).includes("all_emails_json"),
  );
  if (!call) throw new Error("imported-contacts query was never issued");
  return call[0] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbGet.mockReturnValue({ count: 5 });
  // Only the imported-contacts SELECT returns rows; every message-derived
  // exclusion/main lookup returns empty so nothing is merged or filtered out.
  mockDbAll.mockImplementation((sql: string) => {
    if (sql.includes("as last_communication_at") && sql.includes("all_emails_json")) {
      return [
        {
          id: "imp-1",
          user_id: USER_ID,
          display_name: "Alice",
          name: "Alice",
          source: "manual",
          is_imported: 1,
          is_message_derived: 0,
          email: "alice@x.com",
          phone: null,
          all_emails_json: '["alice@x.com"]',
          all_phones_json: "[]",
          last_communication_at: "2026-06-01T00:00:00Z",
        },
        {
          id: "imp-2",
          user_id: USER_ID,
          display_name: "Bob",
          name: "Bob",
          source: "manual",
          is_imported: 1,
          is_message_derived: 0,
          email: "bob@x.com",
          phone: null,
          all_emails_json: '["bob@x.com"]',
          all_phones_json: "[]",
          last_communication_at: null,
        },
      ];
    }
    return [];
  });
});

describe("get-all path returns last_communication_at (BACKLOG-2354)", () => {
  it("embeds the shared recency subquery covering all four channels", async () => {
    await getImportedContactsByUserId(USER_ID);
    const sql = importedQuerySql();
    // The fragment itself is spliced in verbatim.
    expect(sql).toContain(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL.trim());
    // ...and it references every recency channel: text, email, denormalized cols.
    expect(sql).toContain("phone_last_message");
    expect(sql).toContain("email_participants");
    expect(sql).toContain("c.last_inbound_at");
    expect(sql).toContain("c.last_outbound_at");
    expect(sql).toContain("as last_communication_at");
  });

  it("surfaces the computed timestamp on each imported contact (sync path)", async () => {
    const contacts = await getImportedContactsByUserId(USER_ID);
    const byId = new Map(contacts.map((c) => [c.id, c.last_communication_at]));
    expect(new Set(byId.keys())).toEqual(new Set(["imp-1", "imp-2"]));
    expect(byId.get("imp-1")).toBe("2026-06-01T00:00:00Z");
    expect(byId.get("imp-2")).toBeNull();
  });

  it("surfaces the computed timestamp via the async worker-fallback path too", async () => {
    // isPoolReady() === false -> delegates to the sync path above.
    const contacts = await getImportedContactsByUserIdAsync(USER_ID);
    const imp1 = contacts.find((c) => c.id === "imp-1");
    expect(imp1?.last_communication_at).toBe("2026-06-01T00:00:00Z");
  });
});

describe("IMPORTED_CONTACT_LAST_COMMUNICATION_SQL fragment contract", () => {
  it("correlates on the outer contacts alias `c` and aliases the column", () => {
    // Both consumers (contactDbService + contactQueryWorker) alias contacts AS c.
    expect(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL).toContain("c.user_id");
    expect(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL).toContain("cp_lc.contact_id = c.id");
    expect(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL).toContain("ce_lc.contact_id = c.id");
    expect(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL).toContain("NULLIF(");
    expect(IMPORTED_CONTACT_LAST_COMMUNICATION_SQL.trim().endsWith("as last_communication_at")).toBe(true);
  });
});
