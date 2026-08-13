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
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

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
import { markSourceRecordsCurrent } from "../db/externalContactDbService";

const USER = "user-2401";
const OTHER_USER = "user-other";

// ---------------------------------------------------------------------------
// SCHEMA — production shapes for the tables this feature touches, including the
// v57 crosswalk and the v57 external_contacts.external_uuid column.
// ---------------------------------------------------------------------------

/**
 * BACKLOG-2410: the schema moved to a shared fixture so this suite, the review
 * queue, the name rule and the provenance suite all run against ONE transcript
 * of the migrations. Four hand-copied schemas drift, and a suite testing a shape
 * the migration does not produce passes for the wrong reason.
 */
const SCHEMA = CONTACT_IDENTITY_SCHEMA;

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

/**
 * Default sync stamp. Every real upsert path takes ONE
 * `new Date().toISOString()` per call and stamps the whole batch with it, so
 * "same sync" == "same synced_at". Tests that need a record left over from an
 * EARLIER sync (the iPhone device swap, which never prunes) pass `syncedAt`.
 */
const CURRENT_SYNC = "2026-08-02T00:00:00.000Z";

function addExternal(
  recordId: string,
  name: string,
  opts: {
    source?: string;
    emails?: string[];
    phones?: string[];
    userId?: string;
    externalUuid?: string | null;
    syncedAt?: string;
  } = {},
): void {
  const phones = opts.phones ?? [];
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      opts.syncedAt ?? CURRENT_SYNC,
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
  const MOVED_PHONE = "+14155550105";

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
  const MOVED_PHONE = "+14155550105";

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
      reason: "ambiguous_identifier",
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
      reason: "ambiguous_identifier",
    });
    expect(linkTriples(C)).toEqual([]);
    expect(linkTriples(D)).toEqual([]);
  });
});

// ===========================================================================
describe("C6 — device swap: every id changed, content fallback re-links", () => {
  /**
   * The distinguishing signal against C8 is CURRENCY: the contact's old link
   * points at a record the source no longer returns, so there is no competing
   * current claim and the content match is the intended repair.
   *
   * ===========================================================================
   * THIS FIXTURE MODELS PRODUCTION, NOT AN IDEALISED PRUNE — SR review
   * ===========================================================================
   * The first version of this block asserted "the old record is GONE" BY
   * OMISSION: it created the crosswalk link for OLD_UID but never inserted an
   * `external_contacts` row for it. That models a prune only macos, outlook and
   * google_contacts actually perform.
   *
   * `iphone` NEVER PRUNES — `deleteStaleIPhoneContacts` has ZERO callers
   * (BACKLOG-2396) and `iPhoneSyncStorageService` only upserts. So in production
   * the old row is STILL THERE after a device swap, the old "does the row still
   * exist?" test was permanently true, and this entire branch was unreachable
   * for the source the task body names as the worst case: every contact on a new
   * iPhone was flagged instead of re-linked, and flagged has no review queue.
   *
   * The old row is therefore inserted here WITH A STALE `synced_at`, exactly as
   * a real new-iPhone sync leaves it. Staleness is what
   * `deleteStaleContactsBySource` itself uses (`synced_at < syncStartTime`) on
   * the sources that do prune, so this fixture and that prune agree.
   */
  const JON = "c-jon";
  const OLD_UID = "old-iphone-1";
  const NEW_UID = "new-iphone-9";
  const PHONE = "+14155550109";
  const OLD_SYNC = "2026-01-01T00:00:00.000Z";
  const NEW_SYNC = "2026-08-02T00:00:00.000Z";

  beforeEach(() => {
    addContact(JON, "Jon", { phones: [PHONE] });
    createLink({
      userId: USER,
      contactId: JON,
      sourceType: "iphone",
      sourceRecordId: OLD_UID,
      matchMethod: "source_id",
    });
    // The OLD device's row, LEFT BEHIND because iphone never prunes.
    addExternal(OLD_UID, "Jon", { source: "iphone", phones: [PHONE], syncedAt: OLD_SYNC });
    // The NEW phone's row, written by the latest sync.
    addExternal(NEW_UID, "Jon", { source: "iphone", phones: [PHONE], syncedAt: NEW_SYNC });
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

    // TWO iphone rows are offered, because iphone never prunes: the stale row
    // from the old device (already linked -> id-matched) and the new device's
    // row (re-linked by phone -> content-matched). The content-matched count is
    // the one that must be non-zero — it is the evidence a device swap happened
    // and was repaired rather than silently flagged.
    expect(summary.contentMatched).toBe(1);
    expect(summary.idMatched).toBe(1);
    expect(summary.flagged).toBe(0);
    expect(summary.unmatched).toBe(0);
  });

  it("becomes an id match on the NEXT sync — convergence, asserted", () => {
    linkExternalContactsForUser(USER);
    const second = linkExternalContactsForUser(USER);

    // Both rows now resolve by id: the stale old-device row and the new one.
    expect(second.idMatched).toBe(2);
    expect(second.contentMatched).toBe(0);
    expect(second.flagged).toBe(0);
  });

  it("REGRESSION GUARD: staleness, not absence, is what unlocks the re-link", () => {
    // Make the old row CURRENT (as if the old device had synced again). It is
    // now a genuine competing claim and the link must be withheld. This is the
    // assertion that fails if anyone reverts currency to a bare existence test:
    // under that rule the two cases are indistinguishable, and the one above —
    // the real new-iPhone case — silently becomes this one.
    mockDb!
      .prepare(
        "UPDATE external_contacts SET synced_at = ? WHERE user_id = ? AND source = 'iphone' AND external_record_id = ?",
      )
      .run(NEW_SYNC, USER, OLD_UID);

    const resolution = resolveSourceRecord(USER, {
      sourceType: "iphone",
      sourceRecordId: NEW_UID,
      phones: [PHONE],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: NEW_UID,
      candidateContactId: JON,
      conflictingSourceRecordId: OLD_UID,
      matchedOn: "phone",
      // Both rows still carry the number, so this is the SAME PERSON TWICE, not
      // an identifier that moved to someone else.
      reason: "duplicate_source_record",
    });
    expect(linkTriples(JON)).toEqual([`iphone ${OLD_UID} -> ${JON} (source_id)`]);
  });

  it("works the same for a PRUNING source, where the old row is simply gone", () => {
    // macos does prune (fullSync -> deleteStaleContactsBySource), so the old row
    // is absent rather than stale. Both routes must reach the same outcome, or
    // the rule is really two rules wearing one name.
    const ANNE = addContact("c-anne", "Anne", { phones: ["+14155552222"] });
    createLink({
      userId: USER,
      contactId: ANNE,
      sourceType: "macos",
      sourceRecordId: "UUID-OLD-MAC:ABPerson",
      matchMethod: "source_id",
    });
    addExternal("UUID-NEW-MAC:ABPerson", "Anne", { phones: ["+14155552222"] });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-NEW-MAC:ABPerson",
      phones: ["+14155552222"],
    });

    expect(resolution).toEqual({
      outcome: "linked",
      contactId: ANNE,
      sourceRecordId: "UUID-NEW-MAC:ABPerson",
      method: "phone",
    });
  });
});

// ===========================================================================
describe("one person in TWO address books of the SAME source (BACKLOG-2392)", () => {
  /**
   * After BACKLOG-2392 the macOS reader returns EVERY address book, so a person
   * in both iCloud and Exchange yields TWO `macos` records with different
   * ZUNIQUEIDs and the same contact details. That is the case this whole table
   * was built for — and it is emphatically NOT an identifier moving between
   * people.
   *
   * The discriminator: the incumbent record STILL CARRIES the matched
   * identifier. In the Daniel/Lilly case it no longer does, because the number
   * was taken off Daniel and given to Lilly.
   *
   * Both are still WITHHELD — whether to link both books is BACKLOG-2370's
   * call, and linking on a guess is what this design refuses to do. What is
   * fixed here is that they are no longer recorded as the SAME thing, which
   * would poison the funnel and any future review queue with benign duplicates.
   *
   * NEGATIVE CONTROL (run, observed): collapse the two reasons into one and this
   * block goes red.
   */
  const PERSON = "c-two-books";
  const ICLOUD = "UUID-ICLOUD:ABPerson";
  const EXCHANGE = "UUID-EXCHANGE:ABPerson";
  const EMAIL = "two.books@example.com";

  beforeEach(() => {
    addContact(PERSON, "Two Books", { emails: [EMAIL] });
    addExternal(ICLOUD, "Two Books", { emails: [EMAIL] });
    addExternal(EXCHANGE, "Two Books", { emails: [EMAIL] });
    createLink({
      userId: USER,
      contactId: PERSON,
      sourceType: "macos",
      sourceRecordId: ICLOUD,
      matchMethod: "source_id",
    });
  });

  it("is flagged as a DUPLICATE record, not as a reassigned identifier", () => {
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: EXCHANGE,
      emails: [EMAIL],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: EXCHANGE,
      candidateContactId: PERSON,
      conflictingSourceRecordId: ICLOUD,
      matchedOn: "email",
      reason: "duplicate_source_record",
    });
  });

  it("the Daniel/Lilly shape stays 'identifier_reassigned' — the two are distinguishable", () => {
    const MOVER = addContact("c-mover", "Mover", { phones: ["+14155553333"] });
    addExternal("UUID-MOVER-OLD:ABPerson", "Mover", { phones: [] });
    addExternal("UUID-MOVER-NEW:ABPerson", "Someone New", { phones: ["+14155553333"] });
    createLink({
      userId: USER,
      contactId: MOVER,
      sourceType: "macos",
      sourceRecordId: "UUID-MOVER-OLD:ABPerson",
      matchMethod: "source_id",
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-MOVER-NEW:ABPerson",
      phones: ["+14155553333"],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: "UUID-MOVER-NEW:ABPerson",
      candidateContactId: MOVER,
      conflictingSourceRecordId: "UUID-MOVER-OLD:ABPerson",
      matchedOn: "phone",
      reason: "identifier_reassigned",
    });
  });

  /**
   * BACKLOG-2473 — AN ORIGIN ROW IS NOT A COMPETING CLAIM.
   *
   * `getLinksForContactBySource` returns origin rows now, because a
   * `contacts_app`/`iphone`/`outlook` contact's origin row carries the same
   * external spelling in `source_type`. Treat one as an incumbent and EVERY
   * address-book contact created through `contacts:create` gets reported as a
   * reassignment conflict against itself.
   *
   * SR observed the guard was protected only INCIDENTALLY: `sourceRecordIsCurrent`
   * happens to fail on `origin:<contactId>` because nothing in
   * `external_contacts` carries that id. That is a lucky consequence of an
   * unrelated lookup, not a decision — so this test DELIBERATELY REMOVES THE
   * LUCK. It plants an `external_contacts` row whose `external_record_id` IS the
   * synthetic origin id, so the incumbent lookup succeeds and the only thing
   * left standing between the user and a false conflict is the explicit
   * `match_method !== ORIGIN_MATCH_METHOD` check.
   *
   * NEGATIVE CONTROL RUN: removed that one line from `contactSourceLinker.ts`.
   * Observed: this test fails — `outcome: "flagged"`,
   * `reason: "identifier_reassigned"`, the contact conflicting with its own
   * statement of where it came from.
   */
  it("an origin row is never a conflicting incumbent, even when its record resolves", () => {
    const TYPED = addContact("c-typed-origin", "Typed Person", {
      phones: ["+14155550115"],
    });
    // The contact's own origin row, carrying the external spelling.
    createLink({
      userId: USER,
      contactId: TYPED,
      sourceType: "macos",
      sourceRecordId: `origin:${TYPED}`,
      matchMethod: "origin",
    });
    // Break the incidental protection: make the origin id genuinely resolvable.
    addExternal(`origin:${TYPED}`, "Typed Person", { phones: [] });

    // A real macOS card for the same person now arrives.
    addExternal("UUID-TYPED-REAL:ABPerson", "Typed Person", {
      phones: ["+14155550115"],
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-TYPED-REAL:ABPerson",
      phones: ["+14155550115"],
    });

    // It LINKS. It is not flagged as a reassignment against the contact's own
    // statement of where it came from.
    expect(resolution).toMatchObject({ outcome: "linked", contactId: TYPED });
    expect(linkTriples(TYPED).sort()).toEqual(
      [
        `macos origin:${TYPED} -> ${TYPED} (origin)`,
        `macos UUID-TYPED-REAL:ABPerson -> ${TYPED} (phone)`,
      ].sort(),
    );
  });

  it("ACROSS sources the same person links to BOTH — this is only a same-source rule", () => {
    const CROSS = addContact("c-cross", "Cross", { emails: ["cross@example.com"] });
    addExternal("UUID-CROSS:ABPerson", "Cross", { emails: ["cross@example.com"] });
    addExternal("outlook-cross-1", "Cross", {
      source: "outlook",
      emails: ["cross@example.com"],
    });

    linkExternalContactsForUser(USER);

    expect(linkTriples(CROSS).sort()).toEqual(
      [
        `macos UUID-CROSS:ABPerson -> ${CROSS} (email)`,
        `outlook outlook-cross-1 -> ${CROSS} (email)`,
      ].sort(),
    );
  });
});

// ===========================================================================
describe("android_sync INCREMENTAL diff — the guard must not go quietly dead", () => {
  /**
   * ===========================================================================
   * THE CASE THAT ALMOST SHIPPED A SILENT WRONG LINK
   * ===========================================================================
   * `localSyncService` (BACKLOG-2208) upserts only CHANGED contacts on an
   * incremental android diff and deliberately skips the stale-deletion. So
   * without intervention every UNCHANGED row keeps an older `synced_at` and
   * reads as "not current" - not because the source dropped it, but because the
   * diff had no reason to mention it.
   *
   * That does not merely weaken the reassignment guard for `android_sync`, it
   * DISABLES it between full snapshots. And it fails in the dangerous
   * direction: under the earlier existence-based rule this case was FLAGGED;
   * under a naive currency rule it becomes a silent wrong link into a table with
   * no unlink UI. Over-flagging is the safe failure. This is not.
   *
   * The fix is in the DATA, not the predicate: no test over `external_contacts`
   * alone can separate "unchanged, still there" from "gone from the source" -
   * they are byte-identical in the shadow table. `markSourceRecordsCurrent`
   * re-stamps every row of the source right after the incremental upsert,
   * making explicit the assertion that skipping the prune already makes.
   *
   * NEGATIVE CONTROL (run, observed): drop the re-stamp and the first test here
   * goes red - the link is silently applied to the wrong contact.
   */
  const DANIEL = "c-and-daniel";
  const DANIEL_REC = "and-daniel";
  const LILLY_REC = "and-lilly";
  const MOVED_PHONE = "+14155557788";
  const OLD_DIFF = "2026-01-01T00:00:00.000Z";
  const NEW_DIFF = "2026-08-02T00:00:00.000Z";

  beforeEach(() => {
    // Daniel is saved and linked to his android record, which still carries the
    // number. His row was written by an EARLIER diff and has not changed since,
    // so a later incremental diff never re-mentions it.
    addContact(DANIEL, "Daniel", { phones: [MOVED_PHONE] });
    addExternal(DANIEL_REC, "Daniel", {
      source: "android_sync",
      phones: [MOVED_PHONE],
      syncedAt: OLD_DIFF,
    });
    createLink({
      userId: USER,
      contactId: DANIEL,
      sourceType: "android_sync",
      sourceRecordId: DANIEL_REC,
      matchMethod: "source_id",
    });
    // The latest diff mentions only Lilly's record, which now carries the number.
    addExternal(LILLY_REC, "Lilly", {
      source: "android_sync",
      phones: [MOVED_PHONE],
      syncedAt: NEW_DIFF,
    });
  });

  it("FLAGS rather than linking, once the incremental path re-stamps the source", () => {
    // What markSourceRecordsCurrent does after an incremental upsert: every row
    // of the source ends up carrying the same, latest stamp.
    markSourceRecordsCurrent(USER, "android_sync", NEW_DIFF);

    const resolution = resolveSourceRecord(USER, {
      sourceType: "android_sync",
      sourceRecordId: LILLY_REC,
      phones: [MOVED_PHONE],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: LILLY_REC,
      candidateContactId: DANIEL,
      conflictingSourceRecordId: DANIEL_REC,
      matchedOn: "phone",
      reason: "duplicate_source_record",
    });
    expect(linkTriples(DANIEL)).toEqual([
      `android_sync ${DANIEL_REC} -> ${DANIEL} (source_id)`,
    ]);
  });

  /**
   * BACKLOG-2619 CHANGED THIS TEST'S OUTCOME, AND THE REASON MATTERS.
   *
   * It used to assert a silent LINK — the state an unpatched incremental diff
   * leaves behind — pinned so the regression was legible rather than
   * hypothetical. The name veto now catches the same case one step later, so the
   * outcome is `flagged`.
   *
   * The DISCRIMINATION IS PRESERVED, and it is the whole point of this block:
   * with the re-stamp the reason is `duplicate_source_record` (the incumbent
   * check fired); without it the reason is `name_mismatch` (the incumbent check
   * did NOT fire, and the last line of defence caught it instead). Two different
   * reasons still tell the two states apart.
   *
   * THE UNDERLYING DEFECT IS NOT FIXED BY THE NAME VETO — see the test below,
   * which is the same shape with names that agree and still links silently. The
   * re-stamp is still load-bearing.
   */
  it("WITHOUT the re-stamp the incumbent check does not fire — the name veto catches it instead", () => {
    const resolution = resolveSourceRecord(USER, {
      sourceType: "android_sync",
      sourceRecordId: LILLY_REC,
      phones: [MOVED_PHONE],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: LILLY_REC,
      candidateContactId: DANIEL,
      // Empty, NOT `DANIEL_REC` — which is the tell that the incumbent branch
      // never ran. With the re-stamp the test above names the incumbent.
      conflictingSourceRecordId: "",
      matchedOn: "phone",
      reason: "name_mismatch",
    });
    expect(linkTriples(DANIEL)).toEqual([
      `android_sync ${DANIEL_REC} -> ${DANIEL} (source_id)`,
    ]);
  });

  /**
   * DEMONSTRATES the defect the re-stamp fixes, with the name veto in place.
   *
   * Two people who share a name AND a number — the father/son shape this
   * codebase already names as the credit-bureau mixed-file pattern, and the
   * reason `name_generational_suffix` exists. The names agree, so the veto
   * cannot help, and the record still binds to the wrong contact silently.
   *
   * NEGATIVE CONTROL (run, observed): call `markSourceRecordsCurrent` here and
   * this goes red — it flags instead, which is the re-stamp doing its job.
   */
  it("the defect survives the name veto whenever the two names agree", () => {
    const ROB = "c-and-rob";
    const ROB_OLD = "and-rob-senior";
    const ROB_NEW = "and-rob-junior";
    const SHARED_LINE = "+14155550179";

    addContact(ROB, "Robert Chen", { phones: [SHARED_LINE] });
    addExternal(ROB_OLD, "Robert Chen", {
      source: "android_sync",
      phones: [SHARED_LINE],
      syncedAt: OLD_DIFF,
    });
    createLink({
      userId: USER,
      contactId: ROB,
      sourceType: "android_sync",
      sourceRecordId: ROB_OLD,
      matchMethod: "source_id",
    });
    addExternal(ROB_NEW, "Robert Chen", {
      source: "android_sync",
      phones: [SHARED_LINE],
      syncedAt: NEW_DIFF,
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "android_sync",
      sourceRecordId: ROB_NEW,
      phones: [SHARED_LINE],
    });

    expect(resolution).toEqual({
      outcome: "linked",
      contactId: ROB,
      sourceRecordId: ROB_NEW,
      method: "phone",
    });
  });

  it("markSourceRecordsCurrent re-stamps EVERY row of that source, and no other", () => {
    // Scoping matters: a re-stamp that leaked across sources would make stale
    // macos/iphone rows look current and re-break the device-swap path.
    addExternal("mac-1", "Someone", { source: "macos", syncedAt: OLD_DIFF });
    addExternal("iph-1", "Someone", { source: "iphone", syncedAt: OLD_DIFF });

    const changed = markSourceRecordsCurrent(USER, "android_sync", NEW_DIFF);

    expect(changed).toBe(2); // both android rows, nothing else
    const stamps = (
      mockDb!
        .prepare(
          "SELECT source, external_record_id, synced_at FROM external_contacts WHERE user_id = ? ORDER BY source, external_record_id",
        )
        .all(USER) as Array<{ source: string; external_record_id: string; synced_at: string }>
    ).map((r) => `${r.source}/${r.external_record_id}@${r.synced_at}`);

    expect(stamps).toEqual([
      `android_sync/${DANIEL_REC}@${NEW_DIFF}`,
      `android_sync/${LILLY_REC}@${NEW_DIFF}`,
      `iphone/iph-1@${OLD_DIFF}`,
      `macos/mac-1@${OLD_DIFF}`,
    ]);
  });

  it("another user's rows of the same source are untouched", () => {
    addExternal("and-theirs", "Theirs", {
      source: "android_sync",
      userId: OTHER_USER,
      syncedAt: OLD_DIFF,
    });

    markSourceRecordsCurrent(USER, "android_sync", NEW_DIFF);

    const theirs = mockDb!
      .prepare(
        "SELECT synced_at FROM external_contacts WHERE user_id = ? AND external_record_id = ?",
      )
      .get(OTHER_USER, "and-theirs") as { synced_at: string };
    expect(theirs.synced_at).toBe(OLD_DIFF);
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

  /**
   * BACKLOG-2619 CHANGED THIS FIXTURE, NOT THIS RULE.
   *
   * The record used to be called "Completely Different Name" — chosen to make
   * the point that the content fallback consults no name at all. That is no
   * longer true: a name cannot CREATE a link, but it can now veto one, so a
   * fixture built to be name-blind was testing a path the app no longer takes.
   *
   * The ordinary C10 shape is a contact whose `display_name` came from this very
   * record, so the two agree. That is what is transcribed here. The
   * differing-name variant is not deleted — it is the test below, with its new
   * outcome.
   */
  it("links opportunistically by EMAIL, recording match_method='email'", () => {
    addContact(OLD, "Legacy Person", { emails: ["legacy@example.com"] });
    addExternal("UUID-LEGACY:ABPerson", "Legacy Person", {
      emails: ["legacy@example.com"],
    });

    const summary = linkExternalContactsForUser(USER);

    expect(summary.contentMatched).toBe(1);
    expect(linkTriples(OLD)).toEqual([`macos UUID-LEGACY:ABPerson -> ${OLD} (email)`]);
  });

  /**
   * BACKLOG-2619 — the honest cost of the name veto, stated rather than hidden.
   *
   * A pre-crosswalk contact the user RENAMED ("Bob" -> "Robert Chen") no longer
   * re-acquires its link silently: it becomes one question, answered once. That
   * is the founder's rule — a shared identifier with names that disagree is
   * exactly what a person should see — but it is a behaviour change for existing
   * data and it belongs in a test rather than in a release note nobody reads.
   */
  it("but a pre-crosswalk contact saved under a DIFFERENT name is asked about, not linked", () => {
    addContact(OLD, "Legacy Person", { emails: ["legacy@example.com"] });
    addExternal("UUID-LEGACY:ABPerson", "Completely Different Name", {
      emails: ["legacy@example.com"],
    });

    const summary = linkExternalContactsForUser(USER);

    expect(summary.contentMatched).toBe(0);
    expect(summary.flagged).toBe(1);
    expect(linkTriples(OLD)).toEqual([]);
  });

  it("prefers EMAIL over phone when both would match", () => {
    addContact(OLD, "Legacy Person", {
      emails: ["legacy@example.com"],
      phones: ["+14155550102"],
    });
    addExternal("UUID-LEGACY:ABPerson", "Legacy Person", {
      emails: ["legacy@example.com"],
      phones: ["+14155550102"],
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
