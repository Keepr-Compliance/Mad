/**
 * @jest-environment node
 *
 * BACKLOG-2510 — an origin row cannot suppress an address-book record; a real
 * source link can.
 *
 * ===========================================================================
 * THE CLAIM UNDER TEST, AND WHY IT IS NOT SELF-EVIDENT
 * ===========================================================================
 * `contacts:get-available` decides whether an address-book record has already
 * been imported by asking whether any contact claims its
 * `(source_type, external_record_id)` pair:
 *
 *     linkedSourceKeys.has(sourceKey(extContact.source, extContact.external_record_id))
 *                                                      -- contactHandlers.ts:1619-1625
 *
 * and `linkedSourceKeys` is `getLinkedSourceKeys(userId)`, built from EVERY row
 * in `contact_source_links` regardless of `match_method`
 * (`contactSourceLinkDbService.ts:203-209`).
 *
 * Before this fix, importing from Clients & Contacts went through
 * `contacts:create`, whose only crosswalk write is `recordContactOrigin` — a row
 * whose `source_record_id` is the SYNTHETIC `origin:<contactId>`. The reasoning
 * on the backlog item is that such a row "can never match a real record id", so
 * the record is never suppressed and the founder sees the person twice.
 *
 * That reasoning is correct, but it was reasoning. This test executes it, in
 * both directions, against the real sqlite driver and the real schema — because
 * whether the duplicate row in BACKLOG-2511 can be fixed by a renderer refresh
 * alone depends entirely on which way it comes out.
 *
 * Run under the real driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/__tests__/contactImportSuppression-2510.test.ts
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
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

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  createLink,
  getLinkedSourceKeys,
  sourceKey,
} from "../db/contactSourceLinkDbService";
import { recordContactOrigin } from "../db/contactOriginLink";
import { getContactProvenance } from "../contactProvenance";

const USER = "user-2510";
const CONTACT_ID = "b2c4d6e8-1a3f-4c5b-8d7e-6f9a0b1c2d3e";

/**
 * The real address-book record id, as `contacts:get-available` reads it out of
 * `external_contacts.external_record_id` and hands to the picker row as
 * `externalRecordId` (`contactHandlers.ts:1741`).
 */
const RECORD_ID = "AB-RECORD-4417";
const SOURCE = "macos";

function addContact(id: string, displayName: string): void {
  mockDb!
    .prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'contacts_app', 1)",
    )
    .run(id, USER, displayName);
}

function addExternal(recordId: string, name: string, source: string): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, '[]', '[]', ?, ?, '2026-08-05T00:00:00.000Z')`,
    )
    .run(`ext-${source}-${recordId}`, USER, name, recordId, source);
}

/** Exactly what `contacts:get-available` asks before showing a record. */
function recordIsSuppressed(recordId: string, source: string): boolean {
  return getLinkedSourceKeys(USER).has(sourceKey(source as "macos", recordId));
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  addContact(CONTACT_ID, "Tam Wexford");
  addExternal(RECORD_ID, "Tam Wexford", SOURCE);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-2510 — what suppresses an address-book record", () => {
  /**
   * THE DEFECT, REPRODUCED. This is the state `contacts:create` left behind, and
   * it is the direct cause of the duplicate row the founder saw.
   */
  it("does NOT suppress the record when only an origin row was written", () => {
    expect(recordContactOrigin(USER, CONTACT_ID, "contacts_app")).toBe(true);

    // A row WAS written — this is not "nothing happened".
    const keys = [...getLinkedSourceKeys(USER)];
    expect(keys).toHaveLength(1);

    // But it points at the synthetic id, which no address-book record can equal.
    expect(keys[0]).toBe(sourceKey(SOURCE, `origin:${CONTACT_ID}`));
    expect(recordIsSuppressed(RECORD_ID, SOURCE)).toBe(false);
  });

  /**
   * THE FIX. `linkImportedContact` writes this row for every record the imported
   * picker row stood for (`contactHandlers.ts:388-398`).
   */
  it("suppresses the record once a real source link exists", () => {
    createLink({
      userId: USER,
      contactId: CONTACT_ID,
      sourceType: SOURCE,
      sourceRecordId: RECORD_ID,
      matchMethod: "source_id",
      externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
    });

    expect(recordIsSuppressed(RECORD_ID, SOURCE)).toBe(true);
  });

  /**
   * The pair is the key, not the id. A record carrying the same id in a
   * DIFFERENT address book is a different record and must still be offered —
   * otherwise importing someone from the Mac would silently hide their Outlook
   * card, which is the merge this system is supposed to make visible.
   */
  it("suppresses only the source it was linked on", () => {
    createLink({
      userId: USER,
      contactId: CONTACT_ID,
      sourceType: SOURCE,
      sourceRecordId: RECORD_ID,
      matchMethod: "source_id",
    });

    expect(recordIsSuppressed(RECORD_ID, "macos")).toBe(true);
    expect(recordIsSuppressed(RECORD_ID, "outlook")).toBe(false);
  });

  /**
   * Both rows coexist after an import, and they say different, true things.
   * Asserted as an exact SET so a future change that drops one, or writes a
   * third, is caught by identity rather than by a count that happens to match.
   */
  it("leaves exactly the origin row and the real link, and suppresses on the real one", () => {
    recordContactOrigin(USER, CONTACT_ID, "contacts_app");
    createLink({
      userId: USER,
      contactId: CONTACT_ID,
      sourceType: SOURCE,
      sourceRecordId: RECORD_ID,
      matchMethod: "source_id",
    });

    expect([...getLinkedSourceKeys(USER)].sort()).toEqual(
      [sourceKey(SOURCE, `origin:${CONTACT_ID}`), sourceKey(SOURCE, RECORD_ID)].sort(),
    );
    expect(recordIsSuppressed(RECORD_ID, SOURCE)).toBe(true);
  });

  /**
   * What the CONTACT CARD is handed for the same contact — and it is one row,
   * not two. `getContactProvenance` drops origin rows in SQL, so the panel never
   * sees the synthetic one.
   *
   * This is the input to the renderer gate: a single `source_id` row, which is
   * why an imported contact with nothing attached must show no Sources panel
   * (pinned on the renderer side in ContactPreview.sources.test.tsx).
   */
  it("hands the card exactly one row for an imported contact, and it is the real record", () => {
    recordContactOrigin(USER, CONTACT_ID, "contacts_app");
    createLink({
      userId: USER,
      contactId: CONTACT_ID,
      sourceType: SOURCE,
      sourceRecordId: RECORD_ID,
      matchMethod: "source_id",
    });

    const provenance = getContactProvenance(USER, CONTACT_ID);

    expect(provenance.map((p) => `${p.sourceType}|${p.matchMethod}`)).toEqual([
      `${SOURCE}|source_id`,
    ]);
    // The LEFT JOIN found the real record, which is what proves the link points
    // at something that exists rather than at a synthetic id.
    expect(provenance[0].sourceName).toBe("Tam Wexford");
    expect(provenance[0].sourceRecordPresent).toBe(true);
  });
});
