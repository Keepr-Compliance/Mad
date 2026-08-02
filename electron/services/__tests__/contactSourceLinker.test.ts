/**
 * @jest-environment node
 *
 * BACKLOG-2401 — the identity crosswalk and its matching order.
 *
 * Covers section C of the TEST SCENARIO CATALOGUE (BACKLOG-2378) plus the
 * frozen-audit constraints D5/D9, against a REAL in-memory SQLite database via
 * the node_modules require() bypass — not a mock of the thing under test.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT ID SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(links).toHaveLength(1)` is equally satisfied by linking the WRONG
 * person, which is the entire failure mode this feature exists to prevent. Every
 * assertion below names the exact ids it expects. Six times in this workstream a
 * test has passed for the wrong reason, twice inside a fix for that very problem.
 *
 * Each block states the negative control that was run to prove it can fail. The
 * controls were executed and their observed failure counts are recorded in the
 * PR; re-run them when changing the rules they pin.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// REAL DRIVER + dbConnection MOCK (pattern from
// externalContactDbService.funnelCounts.test.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
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
  const m = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { __esModule: true, default: m, logService: m };
});

import {
  resolveSourceRecord,
  linkExternalContactsForUser,
  isContactOnFrozenTransaction,
  type LinkResolution,
} from "../contactSourceLinker";
import {
  createLink,
  getLinksForContact,
  getLinkedSourceKeys,
  deleteLinkBySourceRecord,
  deleteLinkById,
  sourceKey,
} from "../db/contactSourceLinkDbService";
import { CONTACT_SOURCE_RECORDS_SQL } from "../db/contactSourceLinkSql";

const USER = "user-2401";
const OTHER_USER = "user-other";

// ---------------------------------------------------------------------------
// SCHEMA — production shapes for the tables this feature touches, including the
// v57 crosswalk and the v57 external_contacts.external_uuid column.
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    source TEXT DEFAULT 'manual',
    is_imported INTEGER DEFAULT 1,
    removed_at DATETIME,
    removed_reason TEXT
  );

  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    UNIQUE(contact_id, email)
  );

  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_normalized TEXT,
    is_primary INTEGER DEFAULT 0,
    UNIQUE(contact_id, phone_e164)
  );

  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    phones_normalized_json TEXT,
    emails_json TEXT,
    company TEXT,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    external_uuid TEXT,
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    first_exported_at DATETIME,
    buyer_agent_id TEXT,
    seller_agent_id TEXT,
    escrow_officer_id TEXT,
    inspector_id TEXT,
    other_contacts TEXT
  );

  CREATE TABLE transaction_contacts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT,
    UNIQUE(transaction_id, contact_id)
  );

  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    external_uuid TEXT,
    match_method TEXT NOT NULL CHECK (
      match_method IN ('source_id', 'email', 'phone', 'manual', 'scored')
    ),
    confidence REAL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_source_links_contact ON contact_source_links(contact_id);
`;

// ---------------------------------------------------------------------------
// SEED HELPERS
// ---------------------------------------------------------------------------

/** Last 10 digits — the same lookup key `toLookupKey` produces. */
function lookupKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function addContact(
  id: string,
  displayName: string,
  opts: { emails?: string[]; phones?: string[]; userId?: string } = {},
): string {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, opts.userId ?? USER, displayName);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)")
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    mockDb!
      .prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`${id}-p${i}`, id, p, lookupKey(p), i === 0 ? 1 : 0);
  });
  return id;
}

function addExternal(
  recordId: string,
  name: string,
  opts: {
    source?: string;
    emails?: string[];
    phones?: string[];
    userId?: string;
    externalUuid?: string | null;
  } = {},
): void {
  const phones = opts.phones ?? [];
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    )
    .run(
      `ext-${opts.source ?? "macos"}-${recordId}`,
      opts.userId ?? USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(lookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      opts.externalUuid ?? null,
    );
}

/** Rename the shadow row, exactly as a sync does after a rename in Contacts.app. */
function renameExternal(recordId: string, newName: string, source = "macos"): void {
  mockDb!
    .prepare(
      "UPDATE external_contacts SET name = ? WHERE user_id = ? AND source = ? AND external_record_id = ?",
    )
    .run(newName, USER, source, recordId);
}

function removeExternal(recordId: string, source = "macos"): void {
  mockDb!
    .prepare(
      "DELETE FROM external_contacts WHERE user_id = ? AND source = ? AND external_record_id = ?",
    )
    .run(USER, source, recordId);
}

/** `${source_type} ${source_record_id} -> ${contact_id} (${match_method})` */
function linkTriples(contactId: string): string[] {
  return getLinksForContact(contactId).map(
    (l) => `${l.source_type} ${l.source_record_id} -> ${l.contact_id} (${l.match_method})`,
  );
}

function allLinkRows(): Array<Record<string, unknown>> {
  return mockDb!
    .prepare(
      `SELECT id, user_id, contact_id, source_type, source_record_id, match_method, confidence
         FROM contact_source_links ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

function contactIdsIn(): string[] {
  return (mockDb!.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** The FULL rows of a transaction's contact set — byte-comparable, not a count. */
function frozenContactSet(txnId: string): Array<Record<string, unknown>> {
  return mockDb!
    .prepare(
      "SELECT id, transaction_id, contact_id, role FROM transaction_contacts WHERE transaction_id = ? ORDER BY id",
    )
    .all(txnId) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:") as DatabaseType;
  mockDb.pragma("foreign_keys = ON");
  mockDb.exec(SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("sanity", () => {
  it("is wired to the real better-sqlite3 driver, not the jest auto-mock", () => {
    expect(typeof RealDatabase).toBe("function");
    expect(mockDb!.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
  });
});

// ===========================================================================
describe("C4 — a contact renamed in the address book keeps its record", () => {
  /**
   * THE HEADLINE CASE. Jane Seller is imported and attached to a deal, then
   * marries and changes her name in Contacts.app.
   *
   * NEGATIVE CONTROL (run, observed): revert the backfill lookup to the old
   * `WHERE user_id = ? AND name = ?` against contacts.display_name and this
   * block goes red — the renamed contact resolves to NOTHING.
   */
  const JANE = "c-jane";
  const JANE_UID = "UUID-JANE:ABPerson";

  beforeEach(() => {
    addContact(JANE, "Jane Seller", { emails: ["jane@example.com"] });
    addExternal(JANE_UID, "Jane Seller", { emails: ["jane@example.com"] });
    createLink({
      userId: USER,
      contactId: JANE,
      sourceType: "macos",
      sourceRecordId: JANE_UID,
      matchMethod: "source_id",
    });
  });

  it("still resolves to the SAME saved contact after the rename (exact id)", () => {
    renameExternal(JANE_UID, "Jane Married");

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: JANE_UID,
      emails: ["jane@example.com"],
    });

    expect(resolution).toEqual({
      outcome: "already_linked",
      contactId: JANE,
      sourceRecordId: JANE_UID,
    });
  });

  it("keeps receiving updates after the rename — the backfill still finds her record", () => {
    renameExternal(JANE_UID, "Jane Married");
    // ...and the address book now also holds a new phone for her.
    mockDb!
      .prepare("UPDATE external_contacts SET phones_json = ? WHERE external_record_id = ?")
      .run(JSON.stringify(["+14155550111"]), JANE_UID);

    const rows = mockDb!.prepare(CONTACT_SOURCE_RECORDS_SQL).all({ userId: USER, contactId: JANE }) as Array<{
      external_record_id: string;
      matched_by: string;
      phones_json: string;
    }>;

    expect(rows.map((r) => `${r.matched_by}:${r.external_record_id}`)).toEqual([
      `source_id:${JANE_UID}`,
    ]);
    expect(JSON.parse(rows[0].phones_json)).toEqual(["+14155550111"]);
  });

  it("does NOT reappear in the picker as new — her source key is still claimed", () => {
    renameExternal(JANE_UID, "Jane Married");

    // Exactly what the already-imported filter consults.
    expect([...getLinkedSourceKeys(USER)]).toEqual([sourceKey("macos", JANE_UID)]);
  });

  it("creates NO second link and NO second contact on the rename", () => {
    renameExternal(JANE_UID, "Jane Married");
    resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: JANE_UID,
      emails: ["jane@example.com"],
    });

    expect(linkTriples(JANE)).toEqual([`macos ${JANE_UID} -> ${JANE} (source_id)`]);
    expect(contactIdsIn()).toEqual([JANE]);
  });

  it("NAME IS NEVER USED: a record whose name matches a DIFFERENT contact does not link to it", () => {
    // A genuinely different person who happens to share Jane's new display name.
    const IMPOSTER = "c-imposter";
    addContact(IMPOSTER, "Jane Married", { emails: ["someone.else@example.com"] });
    addExternal("UUID-OTHER:ABPerson", "Jane Married", {
      emails: ["someone.else2@example.com"],
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-OTHER:ABPerson",
      emails: ["someone.else2@example.com"],
    });

    // No email or phone in common -> no match at all. Name similarity is inert.
    expect(resolution).toEqual({ outcome: "no_match", sourceRecordId: "UUID-OTHER:ABPerson" });
    expect(linkTriples(IMPOSTER)).toEqual([]);
  });
});

// ===========================================================================
describe("C7 — an identifier that moved between people, both sides id-matched", () => {
  /**
   * The number was recorded against Daniel and later corrected: it is Lilly's.
   * BOTH people are still in the address book under their own record ids, so
   * both resolve at step 1 and the content fallback NEVER FIRES.
   *
   * NEGATIVE CONTROL (run, observed): remove the id-first ordering in
   * resolveSourceRecord — i.e. run the content fallback before the crosswalk
   * lookup — and the Lilly assertion goes red, binding Lilly's record to
   * DANIEL's contact.
   */
  const DANIEL = "c-daniel";
  const LILLY = "c-lilly";
  const DANIEL_UID = "UUID-DANIEL:ABPerson";
  const LILLY_UID = "UUID-LILLY:ABPerson";
  const MOVED_PHONE = "+14155559999";

  beforeEach(() => {
    // Daniel's SAVED contact still carries the number from the first import.
    addContact(DANIEL, "Daniel", { phones: [MOVED_PHONE] });
    addContact(LILLY, "Lilly", { phones: [] });

    // The address book has been corrected: the number is now on Lilly's record.
    addExternal(DANIEL_UID, "Daniel", { phones: [] });
    addExternal(LILLY_UID, "Lilly", { phones: [MOVED_PHONE] });

    createLink({
      userId: USER,
      contactId: DANIEL,
      sourceType: "macos",
      sourceRecordId: DANIEL_UID,
      matchMethod: "source_id",
    });
    createLink({
      userId: USER,
      contactId: LILLY,
      sourceType: "macos",
      sourceRecordId: LILLY_UID,
      matchMethod: "source_id",
    });
  });

  it("links each record to its OWN contact, never crossed (exact ids)", () => {
    const summary = linkExternalContactsForUser(USER);

    const byRecord = new Map(
      summary.resolutions.map((r) => [r.sourceRecordId, r] as [string, LinkResolution]),
    );
    expect(byRecord.get(DANIEL_UID)).toEqual({
      outcome: "already_linked",
      contactId: DANIEL,
      sourceRecordId: DANIEL_UID,
    });
    expect(byRecord.get(LILLY_UID)).toEqual({
      outcome: "already_linked",
      contactId: LILLY,
      sourceRecordId: LILLY_UID,
    });
  });

  it("the CONTENT FALLBACK NEVER FIRES — every record resolved by id", () => {
    const summary = linkExternalContactsForUser(USER);

    expect(summary.idMatched).toBe(2);
    expect(summary.contentMatched).toBe(0);
    expect(summary.flagged).toBe(0);
    expect(summary.unmatched).toBe(0);
    // No link was written by content: the match_method set is unchanged.
    expect(allLinkRows().map((r) => `${r.source_record_id}:${r.match_method}`).sort()).toEqual(
      [`${DANIEL_UID}:source_id`, `${LILLY_UID}:source_id`].sort(),
    );
  });

  it("Daniel's saved contact is NOT bound to Lilly's record despite still holding her number", () => {
    linkExternalContactsForUser(USER);

    expect(linkTriples(DANIEL)).toEqual([`macos ${DANIEL_UID} -> ${DANIEL} (source_id)`]);
    expect(linkTriples(LILLY)).toEqual([`macos ${LILLY_UID} -> ${LILLY} (source_id)`]);
  });
});

// ===========================================================================
describe("C8 / C9 — a content match that would REASSIGN an identifier is flagged", () => {
  /**
   * Same correction, but Lilly's record is NEW (a device swap changed her id, or
   * she was re-created), so there is no id match for it. Her record's phone
   * content-matches DANIEL's saved contact — which is exactly backwards.
   *
   * Daniel's macOS identity is already established AND STILL LIVE, so a second
   * live macOS record claiming him is a conflict for a human, not a link.
   *
   * NEGATIVE CONTROL (run, observed): delete the `liveConflict` check in
   * resolveSourceRecord and this block goes red — the link is silently applied
   * and Daniel's contact acquires Lilly's record.
   */
  const DANIEL = "c-daniel";
  const DANIEL_UID = "UUID-DANIEL:ABPerson";
  const LILLY_NEW_UID = "UUID-LILLY-NEW:ABPerson";
  const MOVED_PHONE = "+14155559999";

  beforeEach(() => {
    addContact(DANIEL, "Daniel", { phones: [MOVED_PHONE] });
    addExternal(DANIEL_UID, "Daniel", { phones: [] });
    addExternal(LILLY_NEW_UID, "Lilly", { phones: [MOVED_PHONE] });
    createLink({
      userId: USER,
      contactId: DANIEL,
      sourceType: "macos",
      sourceRecordId: DANIEL_UID,
      matchMethod: "source_id",
    });
  });

  it("FLAGS rather than applies, naming the exact conflicting record", () => {
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: LILLY_NEW_UID,
      phones: [MOVED_PHONE],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: LILLY_NEW_UID,
      candidateContactId: DANIEL,
      conflictingSourceRecordId: DANIEL_UID,
      matchedOn: "phone",
      reason: "identifier_reassigned",
    });
  });

  it("writes NO link — Daniel keeps exactly his own record", () => {
    resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: LILLY_NEW_UID,
      phones: [MOVED_PHONE],
    });

    expect(linkTriples(DANIEL)).toEqual([`macos ${DANIEL_UID} -> ${DANIEL} (source_id)`]);
    expect(allLinkRows().map((r) => r.source_record_id)).toEqual([DANIEL_UID]);
  });

  it("is counted as flagged, separately from id- and content-matched", () => {
    const summary = linkExternalContactsForUser(USER);

    expect(summary.idMatched).toBe(1); // Daniel's own record
    expect(summary.contentMatched).toBe(0);
    expect(summary.flagged).toBe(1); // Lilly's new record
    expect(summary.unmatched).toBe(0);
  });

  it("C9 — an identifier shared by TWO saved contacts is flagged, never guessed", () => {
    const SECOND = "c-second";
    addContact(SECOND, "Someone Else", { phones: [MOVED_PHONE] });
    // A brand-new record carrying a phone that two saved contacts both hold.
    addExternal("UUID-AMBIG:ABPerson", "Ambiguous", { phones: [MOVED_PHONE] });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-AMBIG:ABPerson",
      phones: [MOVED_PHONE],
    });

    expect(resolution.outcome).toBe("flagged");
    expect(allLinkRows().map((r) => r.source_record_id)).toEqual([DANIEL_UID]);
  });
});

// ===========================================================================
describe("C9 (isolated) — an identifier held by two UNLINKED contacts", () => {
  /**
   * WHY THIS BLOCK EXISTS, SEPARATELY FROM THE ONE ABOVE.
   *
   * The C9 case above has a contact with a LIVE link, so it is caught by the
   * reassignment check and would still pass with the ambiguity guard deleted —
   * a FALSE GREEN, found by running that exact negative control. The scenario
   * here removes every live link, so the ONLY thing that can flag it is the
   * `matches.length > 1` guard.
   *
   * NEGATIVE CONTROL (run, observed): disable the ambiguity guard and this block
   * goes red — with the control above alone it did not.
   *
   * The rule: an identifier shared by several saved contacts cannot pick one of
   * them without guessing, and guessing is what this design refuses to do.
   */
  const A = "c-amb-a";
  const B = "c-amb-b";
  const SHARED = "+14155558888";

  beforeEach(() => {
    // A family or business line: two distinct people, same number, NEITHER of
    // them linked to any macOS record yet.
    addContact(A, "Person A", { phones: [SHARED] });
    addContact(B, "Person B", { phones: [SHARED] });
    addExternal("UUID-SHARED:ABPerson", "Whoever", { phones: [SHARED] });
  });

  it("flags rather than binding the alphabetically-first candidate", () => {
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-SHARED:ABPerson",
      phones: [SHARED],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: "UUID-SHARED:ABPerson",
      candidateContactId: A,
      conflictingSourceRecordId: "",
      matchedOn: "phone",
      reason: "identifier_reassigned",
    });
  });

  it("writes NO link for EITHER contact", () => {
    linkExternalContactsForUser(USER);

    expect(linkTriples(A)).toEqual([]);
    expect(linkTriples(B)).toEqual([]);
    expect(allLinkRows()).toEqual([]);
  });

  it("the same ambiguity on EMAIL is flagged too", () => {
    const C = addContact("c-amb-c", "Person C", { emails: ["shared@example.com"] });
    const D = addContact("c-amb-d", "Person D", { emails: ["shared@example.com"] });
    addExternal("UUID-SHARED-EMAIL:ABPerson", "Whoever", { emails: ["shared@example.com"] });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-SHARED-EMAIL:ABPerson",
      emails: ["shared@example.com"],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: "UUID-SHARED-EMAIL:ABPerson",
      candidateContactId: C,
      conflictingSourceRecordId: "",
      matchedOn: "email",
      reason: "identifier_reassigned",
    });
    expect(linkTriples(C)).toEqual([]);
    expect(linkTriples(D)).toEqual([]);
  });
});

// ===========================================================================
describe("C6 — device swap: every id changed, content fallback re-links", () => {
  /**
   * The distinguishing signal against C8 is LIVENESS: the contact's old link
   * points at a record that no longer exists in the source, so there is no
   * competing live claim and the content match is the intended repair.
   *
   * NEGATIVE CONTROL (run, observed): make the conflict check ignore liveness
   * (flag on ANY existing link for the source) and this block goes red — every
   * contact on a replaced device is flagged instead of re-linked.
   */
  const JON = "c-jon";
  const OLD_UID = "old-iphone-1";
  const NEW_UID = "new-iphone-9";
  const PHONE = "+14155551234";

  beforeEach(() => {
    addContact(JON, "Jon", { phones: [PHONE] });
    createLink({
      userId: USER,
      contactId: JON,
      sourceType: "iphone",
      sourceRecordId: OLD_UID,
      matchMethod: "source_id",
    });
    // New phone: the old record is GONE, a new id carries the same number.
    addExternal(NEW_UID, "Jon", { source: "iphone", phones: [PHONE] });
  });

  it("re-links by phone and records HOW (match_method = 'phone')", () => {
    const resolution = resolveSourceRecord(USER, {
      sourceType: "iphone",
      sourceRecordId: NEW_UID,
      phones: [PHONE],
    });

    expect(resolution).toEqual({
      outcome: "linked",
      contactId: JON,
      sourceRecordId: NEW_UID,
      method: "phone",
    });
    expect(linkTriples(JON).sort()).toEqual(
      [
        `iphone ${NEW_UID} -> ${JON} (phone)`,
        `iphone ${OLD_UID} -> ${JON} (source_id)`,
      ].sort(),
    );
  });

  it("is counted as content-matched, so the degradation is VISIBLE not silent", () => {
    const summary = linkExternalContactsForUser(USER);

    expect(summary.contentMatched).toBe(1);
    expect(summary.idMatched).toBe(0);
    expect(summary.flagged).toBe(0);
  });

  it("becomes an id match on the NEXT sync — convergence, asserted", () => {
    linkExternalContactsForUser(USER);
    const second = linkExternalContactsForUser(USER);

    expect(second.idMatched).toBe(1);
    expect(second.contentMatched).toBe(0);
  });
});

// ===========================================================================
describe("C10 — a contact imported before the crosswalk existed", () => {
  /**
   * This is what replaces the one-time backfill migration the founder ruled out.
   * Such a contact cannot be re-imported to acquire a link (the already-imported
   * filter skips it), so without this pass it would stop receiving updates
   * forever.
   *
   * NEGATIVE CONTROL (run, observed): make the content fallback require an
   * existing link and this block goes red — pre-crosswalk contacts never link.
   */
  const OLD = "c-legacy";

  it("links opportunistically by EMAIL, recording match_method='email'", () => {
    addContact(OLD, "Legacy Person", { emails: ["legacy@example.com"] });
    addExternal("UUID-LEGACY:ABPerson", "Completely Different Name", {
      emails: ["legacy@example.com"],
    });

    const summary = linkExternalContactsForUser(USER);

    expect(summary.contentMatched).toBe(1);
    expect(linkTriples(OLD)).toEqual([`macos UUID-LEGACY:ABPerson -> ${OLD} (email)`]);
  });

  it("prefers EMAIL over phone when both would match", () => {
    addContact(OLD, "Legacy Person", {
      emails: ["legacy@example.com"],
      phones: ["+14155550000"],
    });
    addExternal("UUID-LEGACY:ABPerson", "Legacy Person", {
      emails: ["legacy@example.com"],
      phones: ["+14155550000"],
    });

    linkExternalContactsForUser(USER);

    expect(linkTriples(OLD)).toEqual([`macos UUID-LEGACY:ABPerson -> ${OLD} (email)`]);
  });

  it("does NOT link on name alone when there is no shared email or phone", () => {
    addContact(OLD, "Legacy Person", { emails: ["legacy@example.com"] });
    addExternal("UUID-SAMENAME:ABPerson", "Legacy Person", { emails: ["different@example.com"] });

    const summary = linkExternalContactsForUser(USER);

    expect(summary.contentMatched).toBe(0);
    expect(summary.unmatched).toBe(1);
    expect(linkTriples(OLD)).toEqual([]);
  });

  it("leaves ANOTHER USER's contacts alone", () => {
    addContact("c-theirs", "Legacy Person", {
      emails: ["legacy@example.com"],
      userId: OTHER_USER,
    });
    addExternal("UUID-LEGACY:ABPerson", "Legacy Person", { emails: ["legacy@example.com"] });

    const summary = linkExternalContactsForUser(USER);

    expect(summary.unmatched).toBe(1);
    expect(allLinkRows()).toEqual([]);
  });
});

// ===========================================================================
describe("C11 / C13 — one person, three sources", () => {
  /**
   * NEGATIVE CONTROL (run, observed): drop source_type from the crosswalk's
   * UNIQUE constraint and key it on source_record_id alone — the three-row
   * assertion goes red as soon as two sources issue the same id string.
   */
  const PERSON = "c-multi";

  beforeEach(() => {
    addContact(PERSON, "Multi Source", {
      emails: ["multi@example.com"],
      phones: ["+14155557777"],
    });
    addExternal("UUID-MAC:ABPerson", "Multi Source", {
      source: "macos",
      emails: ["multi@example.com"],
    });
    addExternal("AAMkAG123", "Multi Source", {
      source: "outlook",
      emails: ["multi@example.com"],
    });
    addExternal("iphone-row-42", "Multi Source", {
      source: "iphone",
      phones: ["+14155557777"],
    });
  });

  it("C11 — produces THREE crosswalk rows and exactly ONE contact", () => {
    linkExternalContactsForUser(USER);

    expect(linkTriples(PERSON).sort()).toEqual(
      [
        `iphone iphone-row-42 -> ${PERSON} (phone)`,
        `macos UUID-MAC:ABPerson -> ${PERSON} (email)`,
        `outlook AAMkAG123 -> ${PERSON} (email)`,
      ].sort(),
    );
    expect(contactIdsIn()).toEqual([PERSON]);
  });

  it("C13 — the already-imported key set covers ALL THREE sources", () => {
    linkExternalContactsForUser(USER);

    expect([...getLinkedSourceKeys(USER)].sort()).toEqual(
      [
        sourceKey("macos", "UUID-MAC:ABPerson"),
        sourceKey("outlook", "AAMkAG123"),
        sourceKey("iphone", "iphone-row-42"),
      ].sort(),
    );
  });

  it("two sources issuing the SAME id string are distinct keys, not a collision", () => {
    // Both an Outlook and a Google record legitimately called 'shared-id-1'.
    const A = addContact("c-a", "Person A", { emails: ["a@example.com"] });
    const B = addContact("c-b", "Person B", { emails: ["b@example.com"] });
    addExternal("shared-id-1", "Person A", { source: "outlook", emails: ["a@example.com"] });
    addExternal("shared-id-1", "Person B", {
      source: "google_contacts",
      emails: ["b@example.com"],
    });

    linkExternalContactsForUser(USER);

    expect(linkTriples(A)).toEqual([`outlook shared-id-1 -> ${A} (email)`]);
    expect(linkTriples(B)).toEqual([`google_contacts shared-id-1 -> ${B} (email)`]);
  });
});

// ===========================================================================
describe("C12 — precedence between sources is explicit and total", () => {
  /**
   * "Do not let it be whichever row the query happened to return last."
   * The order is macos < iphone < outlook < google_contacts < android_sync,
   * tie-broken by external_record_id, so it is identical on every run.
   */
  const P = "c-prec";

  it("returns every linked record, id-matches first, in the declared source order", () => {
    addContact(P, "Precedence", { emails: ["p@example.com"] });
    for (const [rid, src] of [
      ["g-1", "google_contacts"],
      ["o-1", "outlook"],
      ["m-1", "macos"],
      ["i-1", "iphone"],
    ] as const) {
      addExternal(rid, "Precedence", { source: src, emails: ["p@example.com"] });
      createLink({
        userId: USER,
        contactId: P,
        sourceType: src,
        sourceRecordId: rid,
        matchMethod: "source_id",
      });
    }

    const rows = mockDb!.prepare(CONTACT_SOURCE_RECORDS_SQL).all({ userId: USER, contactId: P }) as Array<{
      external_record_id: string;
    }>;

    expect(rows.map((r) => r.external_record_id)).toEqual(["m-1", "i-1", "o-1", "g-1"]);
  });

  it("is stable across repeated runs (no last-write-wins)", () => {
    addContact(P, "Precedence", { emails: ["p@example.com"] });
    addExternal("m-1", "Precedence", { source: "macos", emails: ["p@example.com"] });
    addExternal("o-1", "Precedence", { source: "outlook", emails: ["p@example.com"] });
    linkExternalContactsForUser(USER);

    const first = (
      mockDb!.prepare(CONTACT_SOURCE_RECORDS_SQL).all({ userId: USER, contactId: P }) as Array<{
        external_record_id: string;
      }>
    ).map((r) => r.external_record_id);
    const second = (
      mockDb!.prepare(CONTACT_SOURCE_RECORDS_SQL).all({ userId: USER, contactId: P }) as Array<{
        external_record_id: string;
      }>
    ).map((r) => r.external_record_id);

    expect(first).toEqual(["m-1", "o-1"]);
    expect(second).toEqual(first);
  });
});

// ===========================================================================
describe("C14 — deleting a source record removes its link, never the contact", () => {
  const P = "c-del";

  beforeEach(() => {
    addContact(P, "Deletable", { emails: ["d@example.com"] });
    addExternal("m-1", "Deletable", { source: "macos", emails: ["d@example.com"] });
    addExternal("o-1", "Deletable", { source: "outlook", emails: ["d@example.com"] });
    linkExternalContactsForUser(USER);
  });

  it("drops only that source's row; the contact and its other links survive", () => {
    expect(deleteLinkBySourceRecord(USER, "macos", "m-1")).toBe(1);

    expect(linkTriples(P)).toEqual([`outlook o-1 -> ${P} (email)`]);
    expect(contactIdsIn()).toEqual([P]);
  });

  it("unlinking by row id is reversible without data loss (the wrong-auto-match remedy)", () => {
    const scored = createLink({
      userId: USER,
      contactId: P,
      sourceType: "android_sync",
      sourceRecordId: "android-1",
      matchMethod: "scored",
      confidence: 0.72,
    });
    expect(scored.created).toBe(true);

    expect(deleteLinkById(scored.id!)).toBe(1);

    // Contact intact, its deterministic links intact, source record untouched.
    expect(contactIdsIn()).toEqual([P]);
    expect(linkTriples(P).sort()).toEqual(
      [`macos m-1 -> ${P} (email)`, `outlook o-1 -> ${P} (email)`].sort(),
    );
  });
});

// ===========================================================================
describe("the crosswalk records HOW each link was made", () => {
  it("stores confidence for a scored link and NULL for every deterministic one", () => {
    const P = addContact("c-how", "How", { emails: ["how@example.com"] });
    addExternal("m-1", "How", { emails: ["how@example.com"] });
    linkExternalContactsForUser(USER);
    createLink({
      userId: USER,
      contactId: P,
      sourceType: "outlook",
      sourceRecordId: "o-9",
      matchMethod: "scored",
      confidence: 0.61,
    });

    const rows = allLinkRows().map((r) => `${r.match_method}:${r.confidence}`).sort();
    expect(rows).toEqual(["email:null".replace("null", String(null)), "scored:0.61"].sort());
  });

  it("one source record can never be claimed by two contacts", () => {
    const A = addContact("c-a", "A", { emails: ["a@example.com"] });
    const B = addContact("c-b", "B", { emails: ["b@example.com"] });
    createLink({
      userId: USER,
      contactId: A,
      sourceType: "macos",
      sourceRecordId: "m-1",
      matchMethod: "source_id",
    });

    const second = createLink({
      userId: USER,
      contactId: B,
      sourceType: "macos",
      sourceRecordId: "m-1",
      matchMethod: "source_id",
    });

    // Returns the INCUMBENT, and does not silently re-point.
    expect(second).toEqual({ created: false, contactId: A, id: expect.any(String) });
    expect(linkTriples(A)).toEqual([`macos m-1 -> ${A} (source_id)`]);
    expect(linkTriples(B)).toEqual([]);
  });

  it("captures ZEXTERNALUUID without ever matching on it", () => {
    const P = addContact("c-uuid", "UUID Person", { emails: ["u@example.com"] });
    addExternal("m-1", "UUID Person", {
      emails: ["u@example.com"],
      externalUuid: "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5061",
    });

    linkExternalContactsForUser(USER);

    const row = mockDb!
      .prepare("SELECT contact_id, external_uuid FROM contact_source_links")
      .get() as { contact_id: string; external_uuid: string };
    expect(row.contact_id).toBe(P);
    expect(row.external_uuid).toBe("1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5061");

    // ...and a record sharing ONLY that uuid does not link: nothing matches on it.
    const OTHER = addContact("c-other", "Other", { emails: ["o@example.com"] });
    addExternal("m-2", "Other", {
      emails: ["nomatch@example.com"],
      externalUuid: "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5061",
    });
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "m-2",
      externalUuid: "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5061",
      emails: ["nomatch@example.com"],
    });
    expect(resolution).toEqual({ outcome: "no_match", sourceRecordId: "m-2" });
    expect(linkTriples(OTHER)).toEqual([]);
  });
});

// ===========================================================================
describe("D5 / D9 — frozen audits are untouched by any linking operation", () => {
  /**
   * `transactions.first_exported_at IS NOT NULL` is the freeze boundary.
   * A contact on a frozen audit is UPDATED IN PLACE — never deleted and
   * recreated — so it always has an id match and structurally never reaches the
   * content fallback.
   *
   * NEGATIVE CONTROL (run, observed): make the linker delete-and-recreate a
   * contact and the "same row id" / "byte-identical" assertions go red.
   */
  const FROZEN_TXN = "txn-frozen";
  const LIVE_TXN = "txn-live";
  const SELLER = "c-frozen-seller";
  const BUYER = "c-frozen-buyer";
  const SELLER_UID = "UUID-SELLER:ABPerson";

  beforeEach(() => {
    addContact(SELLER, "Frozen Seller", { emails: ["seller@example.com"] });
    addContact(BUYER, "Frozen Buyer", { emails: ["buyer@example.com"] });
    addExternal(SELLER_UID, "Frozen Seller", { emails: ["seller@example.com"] });

    mockDb!
      .prepare(
        "INSERT INTO transactions (id, user_id, first_exported_at, other_contacts) VALUES (?, ?, ?, ?)",
      )
      .run(FROZEN_TXN, USER, "2024-06-01T00:00:00Z", JSON.stringify([BUYER]));
    mockDb!
      .prepare("INSERT INTO transactions (id, user_id, first_exported_at) VALUES (?, ?, NULL)")
      .run(LIVE_TXN, USER);
    mockDb!
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run("tc-1", FROZEN_TXN, SELLER, "seller");

    createLink({
      userId: USER,
      contactId: SELLER,
      sourceType: "macos",
      sourceRecordId: SELLER_UID,
      matchMethod: "source_id",
    });
  });

  it("detects a frozen reference through the junction table", () => {
    expect(isContactOnFrozenTransaction(SELLER)).toBe(true);
  });

  it("detects a frozen reference through the other_contacts JSON array", () => {
    // Under-reporting here is the failure mode: BUYER is referenced ONLY by the
    // JSON column, which a junction-only predicate would miss entirely.
    expect(isContactOnFrozenTransaction(BUYER)).toBe(true);
  });

  it("detects a frozen reference through a direct FK column", () => {
    const AGENT = addContact("c-agent", "Agent", { emails: ["agent@example.com"] });
    mockDb!.prepare("UPDATE transactions SET buyer_agent_id = ? WHERE id = ?").run(AGENT, FROZEN_TXN);
    expect(isContactOnFrozenTransaction(AGENT)).toBe(true);
  });

  it("does NOT report a contact that is only on an UNFROZEN transaction", () => {
    const LIVE_ONLY = addContact("c-live", "Live Only", { emails: ["live@example.com"] });
    mockDb!
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run("tc-live", LIVE_TXN, LIVE_ONLY, "buyer");

    expect(isContactOnFrozenTransaction(LIVE_ONLY)).toBe(false);
  });

  it("D5 — the frozen contact is updated IN PLACE: same row id, contents unchanged", () => {
    const before = mockDb!
      .prepare("SELECT id, user_id, display_name, company, source, is_imported FROM contacts WHERE id = ?")
      .get(SELLER);

    renameExternal(SELLER_UID, "Frozen Seller Renamed");
    linkExternalContactsForUser(USER);

    const after = mockDb!
      .prepare("SELECT id, user_id, display_name, company, source, is_imported FROM contacts WHERE id = ?")
      .get(SELLER);

    expect(after).toEqual(before);
    expect(contactIdsIn()).toEqual([BUYER, SELLER].sort());
  });

  it("D9 — the frozen transaction's contact set is BYTE-IDENTICAL before and after", () => {
    const before = frozenContactSet(FROZEN_TXN);
    expect(before).toEqual([
      { id: "tc-1", transaction_id: FROZEN_TXN, contact_id: SELLER, role: "seller" },
    ]);

    // A linking run that genuinely does work elsewhere: a brand-new person and
    // an opportunistic link, so this is not a no-op passing for free.
    const NEWBIE = addContact("c-newbie", "Newbie", { emails: ["new@example.com"] });
    addExternal("UUID-NEW:ABPerson", "Newbie", { emails: ["new@example.com"] });
    const summary = linkExternalContactsForUser(USER);
    expect(summary.contentMatched).toBe(1);
    expect(linkTriples(NEWBIE)).toEqual([`macos UUID-NEW:ABPerson -> ${NEWBIE} (email)`]);

    expect(frozenContactSet(FROZEN_TXN)).toEqual(before);
  });

  it("the content fallback REFUSES to bind a frozen-audit contact", () => {
    // Force the risky path: a frozen contact with NO id match, whose email a new
    // record shares. Per the in-place rule this should be unreachable in
    // production; if an assumption breaks, withhold rather than guess.
    deleteLinkBySourceRecord(USER, "macos", SELLER_UID);
    removeExternal(SELLER_UID);
    addExternal("UUID-SELLER-NEW:ABPerson", "Frozen Seller", { emails: ["seller@example.com"] });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-SELLER-NEW:ABPerson",
      emails: ["seller@example.com"],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: "UUID-SELLER-NEW:ABPerson",
      candidateContactId: SELLER,
      conflictingSourceRecordId: "",
      matchedOn: "email",
      reason: "frozen_audit_contact",
    });
    expect(linkTriples(SELLER)).toEqual([]);
  });
});
