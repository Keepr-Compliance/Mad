/**
 * @jest-environment node
 *
 * BACKLOG-2419 + BACKLOG-2426 (WORK GROUP A) — WHEN MAY A LINK'S RECORDED
 * REASON BE REPLACED?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT SIMPLY "STRONGER WINS"
 * ---------------------------------------------------------------------------
 * Both item bodies asked for an implicit ranking inside `createLink`: whenever
 * an incoming `match_method` outranks the stored one, overwrite it. Implemented
 * literally that ships a live regression, because ONE CALLER PASSES A METHOD
 * THAT DESCRIBES THE CALL RATHER THAN THE LINK — `contactSourceLinker`
 * STEP 1 passes a hard-coded `source_id` purely to capture an `external_uuid`
 * on an already-linked pair, under a comment promising it "does not change the
 * link or how it was made".
 *
 * So the upgrade is OPT-IN (`assertMethod`), and the suite below pins both
 * halves: that an asserted upgrade happens, and that an unasserted one does not.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT VALUES, NEVER "NOT NULL"
 * ---------------------------------------------------------------------------
 * `expect(row.match_method).toBeTruthy()` is equally satisfied by every wrong
 * answer this suite exists to catch. Every assertion names the exact method.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES
 * ---------------------------------------------------------------------------
 * RFC 2606 reserved domains and `+1 <area> 555-01xx` numbers only — the
 * reserved slot is the EXCHANGE, so `555` in the area code would fail
 * `scripts/ci/check-fixture-pii.mjs`.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

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

import {
  canUpgradeMethod,
  createLink,
  type ContactMatchMethod,
} from "../contactSourceLinkDbService";

const USER = "user-2419";
const CONTACT = "contact-ada";
const OTHER_CONTACT = "contact-grace";
const RECORD = "macos-record-1";

function addContact(id: string, displayName: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
}

/** The stored row, read back straight from SQLite — never from a return value. */
function linkRow(): { match_method: string; external_uuid: string | null; contact_id: string } {
  return mockDb!
    .prepare(
      `SELECT match_method, external_uuid, contact_id FROM contact_source_links
        WHERE user_id = ? AND source_type = 'macos' AND source_record_id = ?`,
    )
    .get(USER, RECORD) as { match_method: string; external_uuid: string | null; contact_id: string };
}

function seedLink(method: ContactMatchMethod, externalUuid: string | null = null): void {
  mockDb!
    .prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, external_uuid, match_method)
       VALUES ('link-seed', ?, ?, 'macos', ?, ?, ?)`,
    )
    .run(USER, CONTACT, RECORD, externalUuid, method);
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  addContact(CONTACT, "Ada Lovelace");
  addContact(OTHER_CONTACT, "Grace Hopper");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. THE ORDERING ITSELF
// ===========================================================================
describe("the ladder", () => {
  /**
   * CONTROL: change `>` to `>=` in `canUpgradeMethod`.
   * OBSERVED: 2 failed / 8 passed (this test and "never downgrades").
   */
  it("treats email, phone and unique_name as EQUAL, not ordered", () => {
    expect(canUpgradeMethod("email", "phone")).toBe(false);
    expect(canUpgradeMethod("phone", "email")).toBe(false);
    expect(canUpgradeMethod("unique_name", "email")).toBe(false);
    expect(canUpgradeMethod("email", "unique_name")).toBe(false);
  });

  it("lets an ASSERTED method outrank an inferred one", () => {
    expect(canUpgradeMethod("email", "source_id")).toBe(true);
    expect(canUpgradeMethod("email", "manual")).toBe(true);
    expect(canUpgradeMethod("unique_name", "manual")).toBe(true);
    expect(canUpgradeMethod("source_id", "manual")).toBe(true);
    expect(canUpgradeMethod("scored", "email")).toBe(true);
  });

  /**
   * CONTROL: use `>=` instead of `>`.
   * OBSERVED: 2 failed / 8 passed — red on the first assertion, `manual` ->
   * `manual`, which `>=` wrongly permits.
   */
  it("never downgrades, and never re-writes an equal method", () => {
    expect(canUpgradeMethod("manual", "manual")).toBe(false);
    expect(canUpgradeMethod("manual", "source_id")).toBe(false);
    expect(canUpgradeMethod("manual", "email")).toBe(false);
    expect(canUpgradeMethod("source_id", "email")).toBe(false);
  });

  /**
   * `origin` is not a match at all — it records where a CONTACT came from and
   * points at a synthetic record id that JOINs nothing.
   *
   * CONTROL: widen METHOD_RANK to `Record<ContactMatchMethod, number>` with
   * `origin: 0` and delete the origin short-circuit.
   * OBSERVED: 1 failed / 9 passed — `origin -> manual` becomes true.
   */
  it("keeps origin off the ladder in BOTH directions", () => {
    expect(canUpgradeMethod("origin", "manual")).toBe(false);
    expect(canUpgradeMethod("origin", "source_id")).toBe(false);
    expect(canUpgradeMethod("email", "origin")).toBe(false);
    expect(canUpgradeMethod("manual", "origin")).toBe(false);
  });
});

// ===========================================================================
// 2. THE OPT-IN — the half that stops a regression rather than causing one
// ===========================================================================
describe("createLink upgrades ONLY when the caller asserts the method", () => {
  /**
   * THE REGRESSION GUARD. `contactSourceLinker` STEP 1 calls createLink with a
   * hard-coded `source_id` just to capture a uuid on an already-linked pair.
   *
   * CONTROL: default `assertMethod` to `true` in `createLink`.
   * OBSERVED: 1 failed / 9 passed — `match_method` becomes "source_id".
   * (The same control also reddens the affordance twin in
   * contactManualLink.test.ts, which is the layer the USER experiences.)
   */
  it("leaves match_method alone when assertMethod is not set", () => {
    seedLink("email");

    createLink({
      userId: USER,
      contactId: CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "source_id",
      externalUuid: "uuid-from-the-address-book",
    });

    const row = linkRow();
    expect(row.match_method).toBe("email");
    // ...and the uuid it was actually called for still lands.
    expect(row.external_uuid).toBe("uuid-from-the-address-book");
  });

  it("upgrades when the caller asserts a strictly stronger method", () => {
    seedLink("email");

    createLink({
      userId: USER,
      contactId: CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "manual",
      assertMethod: true,
    });

    expect(linkRow().match_method).toBe("manual");
  });

  /**
   * The old `AND external_uuid IS NULL` guard could not survive as a WHERE
   * clause: it would also veto the METHOD upgrade on any row that already
   * carries a uuid. COALESCE replaces it.
   *
   * CONTROL: restore `AND external_uuid IS NULL` to the UPDATE's WHERE.
   * OBSERVED: 1 failed / 9 passed — match_method stays "email".
   */
  it("upgrades a row that ALREADY has an external_uuid, without changing it", () => {
    seedLink("email", "uuid-captured-earlier");

    createLink({
      userId: USER,
      contactId: CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "manual",
      externalUuid: "a-different-uuid",
      assertMethod: true,
    });

    const row = linkRow();
    expect(row.match_method).toBe("manual");
    expect(row.external_uuid).toBe("uuid-captured-earlier");
  });

  it("does not downgrade an asserted manual link on a later inferred write", () => {
    seedLink("manual");

    createLink({
      userId: USER,
      contactId: CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "email",
      assertMethod: true,
    });

    expect(linkRow().match_method).toBe("manual");
  });

  /**
   * AN UPGRADE NEVER CROSSES CONTACTS. Relabelling a link another contact holds
   * is a merge by another name, and this function's contract is that a claimed
   * record is RETURNED, never re-pointed.
   *
   * CONTROL: drop `existing.contact_id === contactId` from the upgrade
   * predicate. OBSERVED: 1 failed / 9 passed — the incumbent's method becomes
   * "manual", i.e. one contact's assertion rewrites another contact's link.
   */
  it("refuses to relabel a link another contact holds, and never re-points it", () => {
    seedLink("email");

    const result = createLink({
      userId: USER,
      contactId: OTHER_CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "manual",
      assertMethod: true,
    });

    const row = linkRow();
    expect(row.match_method).toBe("email");
    expect(row.contact_id).toBe(CONTACT);
    expect(result.created).toBe(false);
    expect(result.contactId).toBe(CONTACT);
  });

  it("inserts a fresh manual link when nothing claims the record", () => {
    const result = createLink({
      userId: USER,
      contactId: CONTACT,
      sourceType: "macos",
      sourceRecordId: RECORD,
      matchMethod: "manual",
      assertMethod: true,
    });

    expect(result.created).toBe(true);
    expect(linkRow().match_method).toBe("manual");
  });
});
