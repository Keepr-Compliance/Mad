/**
 * @jest-environment node
 *
 * BACKLOG-2407 — per-source identity capture on the shadow table.
 *
 * The values under test are WRITTEN and read by nothing, which is exactly why
 * they need a test: a capture that silently stops capturing looks identical to
 * one that works, and the data it was supposed to preserve is gone with the
 * device before anyone notices. Nothing else in the suite would fail.
 *
 * The property that actually matters here is NON-DESTRUCTION. The parser emits
 * NULL for any identity column the backup's ABPerson lacks, so a user who
 * re-imports from an OLDER backup after a newer one hands us a sync with nothing
 * to say. Without COALESCE that erases identifiers already captured — the exact
 * values that cannot be re-read once the phone is gone. That path is reachable
 * in the field, not theoretical, so it is tested directly.
 *
 * Real in-memory better-sqlite3 with thin dbConnection delegates, so the
 * service's actual SQL — including the ON CONFLICT clauses — executes. Same
 * escape hatch as externalContactDbService.staleDeleteScope.test.ts.
 *
 * ASSERTION STYLE: exact ID SETS / exact stored values, never counts. An upsert
 * count of 2 is equally true when both rows got the WRONG identifier.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType | null = null;

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn().mockReturnValue(false),
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  upsertFromiPhone,
  upsertExternalContacts,
  serializeSourceIdentity,
  type iPhoneContact,
  type ExternalContactInput,
} from "../externalContactDbService";

const USER_ID = "user-2407";

/**
 * Post-v58 `external_contacts`. Hand-rolled rather than run through the chain,
 * so both capture columns are declared here — v57's `external_uuid` and v58's
 * `source_identity_json`.
 */
function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE external_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phones_json TEXT,
      phones_normalized_json TEXT,
      emails_json TEXT,
      company TEXT,
      last_message_at DATETIME,
      external_record_id TEXT,
      source TEXT DEFAULT 'macos',
      synced_at DATETIME,
      sync_session_id TEXT,
      external_uuid TEXT,
      source_identity_json TEXT,
      UNIQUE(user_id, source, external_record_id)
    );
  `);
}

interface StoredRow {
  external_record_id: string;
  external_uuid: string | null;
  source_identity_json: string | null;
}

function readAll(source: string): Map<string, StoredRow> {
  const rows = mockDb!
    .prepare(
      `SELECT external_record_id, external_uuid, source_identity_json
         FROM external_contacts WHERE user_id = ? AND source = ?`
    )
    .all(USER_ID, source) as StoredRow[];
  return new Map(rows.map((r) => [r.external_record_id, r]));
}

function identityOf(row: StoredRow | undefined): Record<string, unknown> | null {
  if (!row?.source_identity_json) return null;
  return JSON.parse(row.source_identity_json) as Record<string, unknown>;
}

/** A contact from a MODERN backup — every identity column populated. */
function modernContact(): iPhoneContact {
  return {
    name: "Ada Lovelace",
    phones: ["+15555550104"],
    emails: ["ada@example.com"],
    recordId: "1",
    externalUuid: "11111111-1111-4111-8111-111111111111",
    sourceIdentity: {
      externalIdentifier: "ext-ada-001",
      externalModificationTag: "etag-ada-v3",
      modifiedAt: "2023-03-08T20:26:40.000Z",
      createdAt: "2021-01-01T00:00:00.000Z",
      storeId: 2,
    },
  };
}

/**
 * The SAME contact as read from an OLDER backup whose ABPerson lacks the
 * identity columns — the parser emits null for all of them.
 */
function legacyContact(): iPhoneContact {
  return {
    name: "Ada Lovelace",
    phones: ["+15555550104"],
    emails: ["ada@example.com"],
    recordId: "1",
    externalUuid: null,
    sourceIdentity: {
      externalIdentifier: null,
      externalModificationTag: null,
      modifiedAt: null,
      createdAt: null,
      storeId: null,
    },
  };
}

beforeEach(() => {
  mockDb = new Database(":memory:");
  createSchema(mockDb);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("serializeSourceIdentity", () => {
  it("drops absent values so a missing column is not stored as a null key", () => {
    // "The source did not have this column" must not be recorded as "the value
    // is null" — the distinction the population measurement rests on.
    expect(
      serializeSourceIdentity({
        externalIdentifier: "ext-1",
        externalModificationTag: null,
        modifiedAt: undefined,
        storeId: 2,
      })
    ).toBe(JSON.stringify({ externalIdentifier: "ext-1", storeId: 2 }));
  });

  it("returns null when nothing at all was captured", () => {
    // This is what lets COALESCE read "I have nothing to say" as "leave what is
    // stored alone" — the whole non-destruction mechanism depends on it.
    expect(serializeSourceIdentity(null)).toBeNull();
    expect(serializeSourceIdentity(undefined)).toBeNull();
    expect(serializeSourceIdentity({})).toBeNull();
    expect(serializeSourceIdentity({ lookupKey: null, storeId: null })).toBeNull();
    expect(serializeSourceIdentity({ lookupKey: "" })).toBeNull();
  });

  it("keeps storeId 0 — a falsy value that is a real store id", () => {
    // `if (!value)` would drop this. Store 0 is a legitimate store.
    expect(serializeSourceIdentity({ storeId: 0 })).toBe(JSON.stringify({ storeId: 0 }));
  });
});

describe("upsertFromiPhone — identity capture (BACKLOG-2407)", () => {
  it("stores ExternalUUID and the remaining identity beside an UNCHANGED key", () => {
    upsertFromiPhone(USER_ID, [modernContact()]);

    const rows = readAll("iphone");

    // The key is still ABPerson.ROWID. This task captures; it does not re-key.
    expect(new Set(rows.keys())).toEqual(new Set(["1"]));

    expect(rows.get("1")!.external_uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(identityOf(rows.get("1"))).toEqual({
      externalIdentifier: "ext-ada-001",
      externalModificationTag: "etag-ada-v3",
      modifiedAt: "2023-03-08T20:26:40.000Z",
      createdAt: "2021-01-01T00:00:00.000Z",
      storeId: 2,
    });
  });

  it("keeps each contact's own identifiers — exact set across several contacts", () => {
    upsertFromiPhone(USER_ID, [
      modernContact(),
      {
        name: "Grace Hopper",
        phones: ["+15555550107"],
        emails: ["grace@example.com"],
        recordId: "2",
        externalUuid: "22222222-2222-4222-8222-222222222222",
        sourceIdentity: { externalIdentifier: "ext-grace-002", storeId: 2 },
      },
      // A local-store contact: no server identity at all. Must still be stored.
      {
        name: "Local Only",
        phones: ["+15555550108"],
        emails: [],
        recordId: "3",
        externalUuid: null,
        sourceIdentity: { modifiedAt: "2023-03-08T20:26:40.000Z", storeId: 1 },
      },
    ]);

    const rows = readAll("iphone");
    expect(new Set(rows.keys())).toEqual(new Set(["1", "2", "3"]));

    // Asserted as the full id -> uuid mapping. A count would pass while two
    // contacts had swapped identifiers.
    expect(new Map([...rows].map(([k, v]) => [k, v.external_uuid]))).toEqual(
      new Map([
        ["1", "11111111-1111-4111-8111-111111111111"],
        ["2", "22222222-2222-4222-8222-222222222222"],
        ["3", null],
      ])
    );
    expect(identityOf(rows.get("3"))).toEqual({
      modifiedAt: "2023-03-08T20:26:40.000Z",
      storeId: 1,
    });
  });

  it("survives a re-import of the same backup unchanged", () => {
    upsertFromiPhone(USER_ID, [modernContact()]);
    const first = readAll("iphone").get("1")!;

    upsertFromiPhone(USER_ID, [modernContact()]);
    const second = readAll("iphone").get("1")!;

    expect(second.external_uuid).toBe(first.external_uuid);
    expect(second.source_identity_json).toBe(first.source_identity_json);
    // Still exactly one row — the upsert conflicted rather than inserting.
    expect(new Set(readAll("iphone").keys())).toEqual(new Set(["1"]));
  });

  // -------------------------------------------------------------------------
  // THE PROBE-NARROWED PATH — the reason COALESCE is there
  // -------------------------------------------------------------------------

  it("a later sync from an OLDER backup does NOT erase captured identifiers", () => {
    // Sync 1: modern backup, everything captured.
    upsertFromiPhone(USER_ID, [modernContact()]);

    // Sync 2: the user restores/imports an older backup whose ABPerson lacks the
    // identity columns. The parser's probe emits NULL for all of them. Without
    // COALESCE this write would destroy values that CANNOT be re-read once the
    // device is gone — which is the entire premise of capturing them now.
    upsertFromiPhone(USER_ID, [legacyContact()]);

    const row = readAll("iphone").get("1")!;
    expect(row.external_uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(identityOf(row)).toEqual({
      externalIdentifier: "ext-ada-001",
      externalModificationTag: "etag-ada-v3",
      modifiedAt: "2023-03-08T20:26:40.000Z",
      createdAt: "2021-01-01T00:00:00.000Z",
      storeId: 2,
    });
  });

  it("still updates the ordinary fields on that same older-backup sync", () => {
    // Non-destruction must not become non-updating: the contact's name and
    // numbers still have to track the source.
    upsertFromiPhone(USER_ID, [modernContact()]);
    upsertFromiPhone(USER_ID, [{ ...legacyContact(), name: "Ada L. (renamed)" }]);

    const name = mockDb!
      .prepare(
        `SELECT name FROM external_contacts WHERE user_id = ? AND source = 'iphone' AND external_record_id = '1'`
      )
      .get(USER_ID) as { name: string };
    expect(name.name).toBe("Ada L. (renamed)");
    expect(readAll("iphone").get("1")!.external_uuid).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
  });

  it("upgrades a row captured before this shipped, without a backfill", () => {
    // A contact imported by the pre-2407 code has both columns null. The next
    // ordinary sync fills them in — which is why no migration backfill exists
    // (there is nothing in the database to backfill FROM; the values live on the
    // device).
    upsertFromiPhone(USER_ID, [legacyContact()]);
    expect(readAll("iphone").get("1")!.external_uuid).toBeNull();

    upsertFromiPhone(USER_ID, [modernContact()]);
    expect(readAll("iphone").get("1")!.external_uuid).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
  });
});

describe("upsertExternalContacts — android_sync lookupKey (BACKLOG-2407)", () => {
  const androidContact = (
    recordId: string,
    lookupKey: string | null
  ): ExternalContactInput => ({
    external_record_id: recordId,
    name: `Contact ${recordId}`,
    emails: [],
    phones: ["+15555550130"],
    company: null,
    source_identity: { lookupKey },
  });

  it("captures lookupKey beside the device-scoped key, which is unchanged", () => {
    upsertExternalContacts(USER_ID, "android_sync", [
      androidContact("android-dev-1-101", "0r1-4A3B2C"),
      androidContact("android-dev-1-102", "0r2-9F8E7D"),
    ]);

    const rows = readAll("android_sync");
    expect(new Set(rows.keys())).toEqual(
      new Set(["android-dev-1-101", "android-dev-1-102"])
    );
    expect(identityOf(rows.get("android-dev-1-101"))).toEqual({ lookupKey: "0r1-4A3B2C" });
    expect(identityOf(rows.get("android-dev-1-102"))).toEqual({ lookupKey: "0r2-9F8E7D" });
  });

  it("stores a contact whose lookupKey is null rather than dropping it", () => {
    // Structural, not an edge case: a contact with no structured-name row has no
    // lookup key. Losing the contact over a missing capture would be a far worse
    // trade than losing the capture.
    upsertExternalContacts(USER_ID, "android_sync", [
      androidContact("android-dev-1-101", "0r1-4A3B2C"),
      androidContact("android-dev-1-201", null),
    ]);

    const rows = readAll("android_sync");
    expect(new Set(rows.keys())).toEqual(
      new Set(["android-dev-1-101", "android-dev-1-201"])
    );
    expect(rows.get("android-dev-1-201")!.source_identity_json).toBeNull();
  });

  it("leaves outlook/google rows untouched — they supply no identity", () => {
    // The generic upsert is shared. Sources that pass nothing must keep working
    // exactly as before, with a null column rather than an empty object.
    upsertExternalContacts(USER_ID, "outlook", [
      {
        external_record_id: "graph-abc",
        name: "Outlook Person",
        emails: ["o@example.com"],
        phones: [],
        company: null,
      },
    ]);

    const row = readAll("outlook").get("graph-abc")!;
    expect(row.source_identity_json).toBeNull();
  });

  it("does not erase a captured lookupKey on a sync that omits it", () => {
    upsertExternalContacts(USER_ID, "android_sync", [
      androidContact("android-dev-1-101", "0r1-4A3B2C"),
    ]);
    upsertExternalContacts(USER_ID, "android_sync", [
      androidContact("android-dev-1-101", null),
    ]);

    expect(identityOf(readAll("android_sync").get("android-dev-1-101"))).toEqual({
      lookupKey: "0r1-4A3B2C",
    });
  });
});
