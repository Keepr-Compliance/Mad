/**
 * BACKLOG-1831: verifies the store/dedup path surfaces cache HITS via the exported
 * storeParsedEmailsForAccount wrapper (used by the shadow delta engine).
 *
 * `duplicates` = exact duplicates (external_id already stored) + resurrection
 * remaps (same Message-ID re-delivered under a new provider id). `stored` = cache
 * MISSES (rows genuinely inserted). We mock the DB layer so no native modules run.
 */

const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockGetRawDatabase = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...a: unknown[]) => mockDbAll(...a),
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a),
}));

const mockGetOAuthToken = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a) },
}));

import { storeParsedEmailsForAccount, type StoreableEmail } from "../emailSyncService";

/** A fake prepared-statement DB whose INSERTs always succeed. */
function makeFakeDb() {
  const insertRuns: unknown[][] = [];
  const remapRuns: unknown[][] = [];
  const stmt = (sink: unknown[][]) => ({ run: (...args: unknown[]) => sink.push(args) });
  const db = {
    prepare: jest.fn((sql: string) => {
      if (sql.includes("UPDATE emails SET external_id")) return stmt(remapRuns);
      if (sql.includes("INSERT INTO emails")) return stmt(insertRuns);
      return stmt([]); // participants
    }),
    transaction: (fn: () => void) => () => fn(),
  };
  return { db, insertRuns, remapRuns };
}

function mkEmail(id: string, messageIdHeader?: string): StoreableEmail {
  return {
    id,
    threadId: `t-${id}`,
    from: "sender@example.com",
    to: "me@example.com",
    cc: null,
    bcc: null,
    messageIdHeader: messageIdHeader ?? null,
    subject: `Subject ${id}`,
    body: "body",
    bodyPlain: "body",
    date: new Date("2026-02-15T10:00:00Z"),
    hasAttachments: false,
    attachmentCount: 0,
    participants: [],
    ingestSource: "filter",
  };
}

describe("storeParsedEmailsForAccount cache hit/miss (BACKLOG-1831)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOAuthToken.mockResolvedValue({ id: "acct-1", connected_email_address: "me@example.com" });
  });

  it("counts already-stored external_ids as duplicates (hits) and inserts the rest (misses)", async () => {
    // e1 + e2 already stored; e3 is new.
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("external_id IN")) return [{ external_id: "e1" }, { external_id: "e2" }];
      return [];
    });
    const { db } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const result = await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkEmail("e1"), mkEmail("e2"), mkEmail("e3")],
    });

    expect(result.fetched).toBe(3);
    expect(result.stored).toBe(1); // misses (e3)
    expect(result.duplicates).toBe(2); // hits (e1, e2)
    expect(result.errors).toBe(0);
  });

  it("counts a resurrection remap (same Message-ID, new provider id) as a hit, not a miss", async () => {
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("external_id IN")) return []; // provider id is new
      if (sql.includes("message_id_header IN")) {
        return [{ id: "local-x", external_id: "old-provider-id", message_id_header: "MID-1" }];
      }
      return [];
    });
    const { db, insertRuns, remapRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const result = await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkEmail("new-provider-id", "MID-1")],
    });

    expect(result.stored).toBe(0); // remap-in-place, no new row
    expect(result.duplicates).toBe(1); // resurrection counted as a hit
    expect(insertRuns).toHaveLength(0);
    expect(remapRuns).toHaveLength(1); // external_id updated in place
  });

  it("all-new batch → all misses, zero hits", async () => {
    mockDbAll.mockReturnValue([]);
    const { db } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const result = await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkEmail("a"), mkEmail("b")],
    });

    expect(result.stored).toBe(2);
    expect(result.duplicates).toBe(0);
  });
});
