/**
 * @jest-environment node
 */

/**
 * Unit tests for getContactsSortedByActivity unified sort
 * BACKLOG-1745 Part 1: ensure imported + message-derived contacts are sorted
 * together by last_communication_at DESC (NULLS-LAST) with display_name tie-break.
 */

import { jest } from "@jest/globals";

// Mock core/dbConnection
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

// Mock logService
jest.mock("../../logService", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

// Mock contactsService (macOS bridge — unused here but referenced at top of module)
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(),
}));

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

import { getContactsSortedByActivity } from "../contactDbService";

const USER_ID = "user-1";

beforeEach(() => {
  jest.clearAllMocks();
  // hasBackfilled query returns a truthy count so the backfill is skipped
  mockDbGet.mockReturnValue({ count: 5 });
});

/**
 * The implementation issues these dbAll calls in order:
 *   1) imported contacts SELECT — SQL contains "FROM contacts c" + "WHERE c.user_id = ? AND c.is_imported = 1" + "COALESCE(c.last_inbound_at"
 *   2) importedEmails exclusion (inside getMessageDerivedContacts) — "FROM contact_emails ce"
 *   3) importedPhones exclusion — "FROM contact_phones cp"
 *   4) importedNames exclusion — "SELECT LOWER(display_name) as name"
 *   5) main message-derived query — "FROM messages" + "json_extract(participants"
 *
 * Match by SQL substring so test stays robust to ordering changes.
 */
function mockDbAllSequence(imported: unknown[], messageDerived: unknown[]) {
  mockDbAll.mockImplementation((sql: string) => {
    if (sql.includes("FROM messages") && sql.includes("json_extract(participants")) {
      return messageDerived;
    }
    if (sql.includes("COALESCE(c.last_inbound_at")) {
      return imported;
    }
    // exclusion lookups (imported emails/phones/names) — return empty so no rows are filtered
    return [];
  });
}

describe("getContactsSortedByActivity — unified sort (BACKLOG-1745 Part 1)", () => {
  it("interleaves imported and message-derived contacts by last_communication_at DESC", async () => {
    const imported = [
      { id: "imp-old", user_id: USER_ID, display_name: "Alice", source: "manual", is_imported: 1,
        last_inbound_at: "2024-01-01T00:00:00Z", last_outbound_at: null,
        last_communication_at: "2024-01-01T00:00:00Z" },
      { id: "imp-new", user_id: USER_ID, display_name: "Bob", source: "manual", is_imported: 1,
        last_inbound_at: "2026-06-01T00:00:00Z", last_outbound_at: null,
        last_communication_at: "2026-06-01T00:00:00Z" },
    ];
    const messageDerived = [
      { id: "md-mid", display_name: "Carol", name: "Carol", email: "c@x.com", phone: null,
        company: null, source: "messages", is_imported: 0, is_message_derived: 1,
        last_communication_at: "2025-03-15T00:00:00Z", communication_count: 3 },
    ];
    mockDbAllSequence(imported, messageDerived);

    const result = await getContactsSortedByActivity(USER_ID);

    expect(result.map(c => c.id)).toEqual(["imp-new", "md-mid", "imp-old"]);
  });

  it("places NULL/undefined last_communication_at at the end (NULLS-LAST)", async () => {
    const imported = [
      { id: "imp-null", user_id: USER_ID, display_name: "Zach", source: "manual", is_imported: 1,
        last_inbound_at: null, last_outbound_at: null, last_communication_at: null },
      { id: "imp-dated", user_id: USER_ID, display_name: "Yara", source: "manual", is_imported: 1,
        last_inbound_at: "2026-01-01T00:00:00Z", last_outbound_at: null,
        last_communication_at: "2026-01-01T00:00:00Z" },
    ];
    const messageDerived = [
      { id: "md-null", display_name: "Aaron", name: "Aaron", email: null, phone: "+15551234567",
        company: null, source: "messages", is_imported: 0, is_message_derived: 1,
        last_communication_at: null, communication_count: 0 },
    ];
    mockDbAllSequence(imported, messageDerived);

    const result = await getContactsSortedByActivity(USER_ID);

    // Dated record first; the two nulls last, tie-broken by display_name ASC ("Aaron" before "Zach")
    expect(result.map(c => c.id)).toEqual(["imp-dated", "md-null", "imp-null"]);
  });

  it("breaks ties by display_name ASC when timestamps are equal", async () => {
    const sameTs = "2026-05-01T12:00:00Z";
    const imported = [
      { id: "imp-charlie", user_id: USER_ID, display_name: "Charlie", source: "manual", is_imported: 1,
        last_inbound_at: sameTs, last_outbound_at: null, last_communication_at: sameTs },
      { id: "imp-alice", user_id: USER_ID, display_name: "alice", source: "manual", is_imported: 1,
        last_inbound_at: sameTs, last_outbound_at: null, last_communication_at: sameTs },
    ];
    const messageDerived = [
      { id: "md-bob", display_name: "Bob", name: "Bob", email: "b@x.com", phone: null,
        company: null, source: "messages", is_imported: 0, is_message_derived: 1,
        last_communication_at: sameTs, communication_count: 1 },
    ];
    mockDbAllSequence(imported, messageDerived);

    const result = await getContactsSortedByActivity(USER_ID);

    // Case-insensitive ASC: alice, Bob, Charlie
    expect(result.map(c => c.id)).toEqual(["imp-alice", "md-bob", "imp-charlie"]);
  });

  it("falls back entirely to display_name ASC when all timestamps are null", async () => {
    const imported = [
      { id: "imp-zoe", user_id: USER_ID, display_name: "Zoe", source: "manual", is_imported: 1,
        last_inbound_at: null, last_outbound_at: null, last_communication_at: null },
      { id: "imp-amy", user_id: USER_ID, display_name: "Amy", source: "manual", is_imported: 1,
        last_inbound_at: null, last_outbound_at: null, last_communication_at: null },
    ];
    const messageDerived = [
      { id: "md-mike", display_name: "Mike", name: "Mike", email: "m@x.com", phone: null,
        company: null, source: "messages", is_imported: 0, is_message_derived: 1,
        last_communication_at: null, communication_count: 0 },
    ];
    mockDbAllSequence(imported, messageDerived);

    const result = await getContactsSortedByActivity(USER_ID);

    expect(result.map(c => c.id)).toEqual(["imp-amy", "md-mike", "imp-zoe"]);
  });

  it("places a freshly-imported contact with NULL last_communication_at at the bottom (Part 2 motivation)", async () => {
    // This test documents the bug Part 2 fixes: when handleImportContact creates
    // a new row without copying the external's timestamps, the new row ends up
    // at the bottom regardless of where its external counterpart appeared.
    const imported = [
      { id: "imp-old-existing", user_id: USER_ID, display_name: "Bob", source: "manual", is_imported: 1,
        last_inbound_at: "2025-01-01T00:00:00Z", last_outbound_at: null,
        last_communication_at: "2025-01-01T00:00:00Z" },
      { id: "imp-just-created", user_id: USER_ID, display_name: "Eliya", source: "manual", is_imported: 1,
        last_inbound_at: null, last_outbound_at: null, last_communication_at: null },
    ];
    mockDbAllSequence(imported, []);

    const result = await getContactsSortedByActivity(USER_ID);

    // Without Part 2's timestamp passthrough, Eliya falls to the bottom.
    expect(result.map(c => c.id)).toEqual(["imp-old-existing", "imp-just-created"]);
  });
});
