/**
 * @jest-environment node
 *
 * BACKLOG-2619 — the linker links across sources on a phone number alone.
 *
 * ---------------------------------------------------------------------------
 * THE CASE
 * ---------------------------------------------------------------------------
 * `contactSourceLinker.ts` contained NO name comparison of any kind. The content
 * fallback matched on an email, else on the last ten digits of a phone, and then
 * called `createLink` silently and copied that record's addresses onto the saved
 * contact.
 *
 * The founder's own fixtures prove what that costs. **Marcus Ord** is an Outlook
 * record. **Priya Raman** is a saved contact imported from macOS only. They share
 * one office line, `(415) 555-0120`, and nothing else. `contacts:get-available`
 * shows them as two people — the picker has a name check. `resolveSourceRecord`
 * merged them, because the same-source conflict rule
 * (`getLinksForContactBySource` is `WHERE contact_id = ? AND source_type = ?`)
 * cannot see across sources, and because nothing here looked at a name.
 *
 * ---------------------------------------------------------------------------
 * NO HAND-WRITTEN LINKS IN THE SETUP
 * ---------------------------------------------------------------------------
 * Every crosswalk row in this file is created by `linkExternalContactsForUser`
 * running over planted `external_contacts` rows — the production entry point,
 * the production sequence. Nothing calls `createLink` to arrange a starting
 * state. A helper that writes the crosswalk directly can describe a state the
 * app never produces, which is how a defect hid behind green tests for a day
 * elsewhere in this epic.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * "No link was created" and "B's addresses did not land on A" are only
 * informative if this harness can produce a link and a copy at all. The Dana
 * Reyes block does exactly that, on the same shape, and every negative
 * assertion in this file is worthless without it.
 *
 * ASSERTION STYLE — EXACT ID SETS, NEVER COUNTS. `toHaveLength(1)` is equally
 * satisfied by linking the wrong person, which is the failure this file exists
 * to catch.
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

import { resolveSourceRecord, linkExternalContactsForUser } from "../contactSourceLinker";
import { getLinksForContact } from "../db/contactSourceLinkDbService";
import { formatPhoneNumber } from "../../utils/phoneNormalization";

const USER = "user-2619";

// ---------------------------------------------------------------------------
// SEED HELPERS — copied from `contactSourceLinker.test.ts`, same schema fixture.
// ---------------------------------------------------------------------------
const CURRENT_SYNC = "2026-08-09T00:00:00.000Z";

function lookupKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function addContact(
  id: string,
  displayName: string,
  opts: { emails?: string[]; phones?: string[] } = {},
): string {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
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
  opts: { source?: string; emails?: string[]; phones?: string[] } = {},
): void {
  const phones = opts.phones ?? [];
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `ext-${opts.source ?? "macos"}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(lookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      CURRENT_SYNC,
    );
}

function renameExternal(recordId: string, newName: string, source = "macos"): void {
  mockDb!
    .prepare(
      "UPDATE external_contacts SET name = ? WHERE user_id = ? AND source = ? AND external_record_id = ?",
    )
    .run(newName, USER, source, recordId);
}

/** `${source_type} ${source_record_id} -> ${contact_id} (${match_method})` */
function linkTriples(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type} ${l.source_record_id} -> ${l.contact_id} (${l.match_method})`)
    .sort();
}

/** EVERY crosswalk row in the database, not just one contact's. */
function allLinkTriples(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT source_type, source_record_id, contact_id, match_method
           FROM contact_source_links ORDER BY source_type, source_record_id`,
      )
      .all() as Array<{
      source_type: string;
      source_record_id: string;
      contact_id: string;
      match_method: string;
    }>
  )
    .map((l) => `${l.source_type} ${l.source_record_id} -> ${l.contact_id} (${l.match_method})`)
    .sort();
}

/** `${source_type} ${source_record_id} -> ${contact_id} [${reason}/${status}]` */
function proposalTriples(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT contact_id, source_type, source_record_id, reason, status
           FROM contact_link_proposals ORDER BY source_type, source_record_id, contact_id`,
      )
      .all() as Array<{
      contact_id: string;
      source_type: string;
      source_record_id: string;
      reason: string;
      status: string;
    }>
  )
    .map(
      (p) =>
        `${p.source_type} ${p.source_record_id} -> ${p.contact_id} [${p.reason}/${p.status}]`,
    )
    .sort();
}

function proposalSummaryFor(sourceRecordId: string): string {
  const row = mockDb!
    .prepare(
      `SELECT evidence_json FROM contact_link_proposals WHERE source_record_id = ? LIMIT 1`,
    )
    .get(sourceRecordId) as { evidence_json: string | null } | undefined;
  return JSON.parse(row?.evidence_json ?? "{}").summary ?? "";
}

/** The addresses actually ON a contact's card — the thing the copy would change. */
function contactEmails(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
      .all(contactId) as Array<{ email: string }>
  ).map((r) => r.email);
}

function contactPhones(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
      .all(contactId) as Array<{ phone_e164: string }>
  ).map((r) => r.phone_e164);
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:") as DatabaseType;
  mockDb.pragma("foreign_keys = ON");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2619 — Marcus Ord and Priya Raman share an office line", () => {
  const OFFICE_LINE = "+14155550120";
  const PRIYA = "c-priya";
  const PRIYA_MAC = "UUID-PRIYA:ABPerson";
  const MARCUS_OUTLOOK = "outlook-marcus-ord";
  const MARCUS_EMAIL = "marcus@ord-realty.example";

  /**
   * Priya is imported from macOS ONLY, and her macOS link is created by the
   * linker itself on a first pass — not written by hand. That first pass is also
   * the regression guard for this whole file: if the name veto were too strict,
   * Priya would never link to her own record and the second pass would prove
   * nothing.
   */
  beforeEach(() => {
    addContact(PRIYA, "Priya Raman", {
      emails: ["priya.raman@example.com"],
      phones: [OFFICE_LINE],
    });
    addExternal(PRIYA_MAC, "Priya Raman", {
      emails: ["priya.raman@example.com"],
      phones: [OFFICE_LINE],
    });

    const firstPass = linkExternalContactsForUser(USER);
    expect(firstPass.contentMatched).toBe(1);
    expect(linkTriples(PRIYA)).toEqual([`macos ${PRIYA_MAC} -> ${PRIYA} (email)`]);
  });

  /**
   * CONTROL 1 — the mandatory one.
   *
   * NEGATIVE CONTROL RUN: deleted the `if (!nameSupport.supportsLink)` block from
   * `contactSourceLinker.ts` so the resolution fell through to `createLink`.
   * OBSERVED: this test fails — `outcome: "linked"`, `method: "phone"`, and a
   * crosswalk row `outlook outlook-marcus-ord -> c-priya (phone)`. Failure count
   * and output recorded in the PR.
   */
  it("does NOT link Marcus's Outlook record to Priya on the shared line alone", () => {
    addExternal(MARCUS_OUTLOOK, "Marcus Ord", {
      source: "outlook",
      emails: [MARCUS_EMAIL],
      phones: [OFFICE_LINE],
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "outlook",
      sourceRecordId: MARCUS_OUTLOOK,
      name: "Marcus Ord",
      phones: [OFFICE_LINE],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: MARCUS_OUTLOOK,
      candidateContactId: PRIYA,
      conflictingSourceRecordId: "",
      matchedOn: "phone",
      reason: "name_mismatch",
    });

    // The EXACT link set in the whole database — Priya keeps her macOS record
    // and nothing else exists.
    expect(allLinkTriples()).toEqual([`macos ${PRIYA_MAC} -> ${PRIYA} (email)`]);
  });

  /**
   * CONTROL 2 — the harm is not only the link.
   *
   * `applyLinkedSourceValues` writes exactly two tables, `contact_emails` and
   * `contact_phones` (read from `contactSourceValues.ts:228-258`, not assumed),
   * so both are asserted as exact value sets. Asserting only emails would be a
   * control that cannot go red on a phone-only copy.
   */
  it("and Marcus's address does not land on Priya's contact card", () => {
    addExternal(MARCUS_OUTLOOK, "Marcus Ord", {
      source: "outlook",
      emails: [MARCUS_EMAIL],
      phones: [OFFICE_LINE, "+14155559999"],
    });

    const emailsBefore = contactEmails(PRIYA);
    const phonesBefore = contactPhones(PRIYA);

    linkExternalContactsForUser(USER);

    expect(contactEmails(PRIYA)).toEqual(emailsBefore);
    expect(contactEmails(PRIYA)).toEqual(["priya.raman@example.com"]);
    expect(contactEmails(PRIYA)).not.toContain(MARCUS_EMAIL);

    expect(contactPhones(PRIYA)).toEqual(phonesBefore);
    expect(contactPhones(PRIYA)).toEqual([OFFICE_LINE]);
    expect(contactPhones(PRIYA)).not.toContain("+14155559999");
  });

  it("files a question instead — the pair reaches the review queue", () => {
    addExternal(MARCUS_OUTLOOK, "Marcus Ord", {
      source: "outlook",
      emails: [MARCUS_EMAIL],
      phones: [OFFICE_LINE],
    });

    linkExternalContactsForUser(USER);

    expect(proposalTriples()).toEqual([
      `outlook ${MARCUS_OUTLOOK} -> ${PRIYA} [name_mismatch/pending]`,
    ]);

    // The sentence a person actually reads names the number and says what the
    // names did. A generic fallback string here means `summaryForReason` lost
    // its case — it has a `default:` clause, so nothing else would notice.
    const summary = proposalSummaryFor(MARCUS_OUTLOOK);
    expect(summary).toContain("…0120");
    expect(summary).toContain("saved under a different name");
    expect(summary).toContain("Marcus Ord");
    expect(summary).not.toBe("This match was not applied automatically.");
  });

  it("re-running the sweep re-states the same question and still links nothing", () => {
    addExternal(MARCUS_OUTLOOK, "Marcus Ord", {
      source: "outlook",
      emails: [MARCUS_EMAIL],
      phones: [OFFICE_LINE],
    });

    linkExternalContactsForUser(USER);
    linkExternalContactsForUser(USER);

    expect(proposalTriples()).toEqual([
      `outlook ${MARCUS_OUTLOOK} -> ${PRIYA} [name_mismatch/pending]`,
    ]);
    expect(allLinkTriples()).toEqual([`macos ${PRIYA_MAC} -> ${PRIYA} (email)`]);
  });
});

// ===========================================================================
describe("BACKLOG-2619 — the act band survives (positive controls)", () => {
  /**
   * CONTROL 8 / the item's control 3. Without this block every "did not link"
   * assertion above is uninformative: a guard that refused everything would pass
   * them all. This is the same cross-source shape, with names that agree.
   */
  const DANA = "c-dana";
  const DANA_EMAIL = "dana.reyes@example.com";
  const DANA_MAC = "UUID-DANA:ABPerson";
  const DANA_OUTLOOK = "outlook-dana-reyes";
  const DANA_WORK_EMAIL = "d.reyes@brokerage.example";
  const DANA_WORK_PHONE = "+14155550188";

  beforeEach(() => {
    addContact(DANA, "Dana Reyes", { emails: [DANA_EMAIL] });
    addExternal(DANA_MAC, "Dana Reyes", { emails: [DANA_EMAIL] });
    addExternal(DANA_OUTLOOK, "Dana Reyes", {
      source: "outlook",
      emails: [DANA_EMAIL, DANA_WORK_EMAIL],
      phones: [DANA_WORK_PHONE],
    });
  });

  it("the same person across two sources still links SILENTLY on a shared email", () => {
    linkExternalContactsForUser(USER);

    expect(linkTriples(DANA)).toEqual(
      [
        `macos ${DANA_MAC} -> ${DANA} (email)`,
        `outlook ${DANA_OUTLOOK} -> ${DANA} (email)`,
      ].sort(),
    );
    expect(proposalTriples()).toEqual([]);
  });

  it("and the copy DOES happen — which is what makes control 2 mean something", () => {
    linkExternalContactsForUser(USER);

    expect(contactEmails(DANA)).toEqual([DANA_WORK_EMAIL, DANA_EMAIL].sort());
    expect(contactPhones(DANA)).toEqual([DANA_WORK_PHONE]);
  });

  it("'Jane S.' is still Jane Smith — an abbreviated surname is not a mismatch", () => {
    const JANE = addContact("c-jane", "Jane Smith", { emails: ["jane@example.com"] });
    addExternal("outlook-jane", "Jane S.", {
      source: "outlook",
      emails: ["jane@example.com"],
    });

    linkExternalContactsForUser(USER);

    expect(linkTriples(JANE)).toEqual([`outlook outlook-jane -> ${JANE} (email)`]);
  });

  /**
   * A rename in Contacts.app must not create a question. STEP 1 resolves by
   * source id and never consults the guard — the whole point of the matching
   * order's rule 1.
   */
  it("a renamed card still resolves by source id and is never re-asked", () => {
    linkExternalContactsForUser(USER);
    expect(linkTriples(DANA)).toHaveLength(2);

    renameExternal(DANA_MAC, "Dana Reyes-Okafor");
    renameExternal(DANA_OUTLOOK, "Someone Else Entirely", "outlook");

    const summary = linkExternalContactsForUser(USER);

    expect(summary.idMatched).toBe(2);
    expect(summary.flagged).toBe(0);
    expect(proposalTriples()).toEqual([]);
    expect(linkTriples(DANA)).toEqual(
      [
        `macos ${DANA_MAC} -> ${DANA} (email)`,
        `outlook ${DANA_OUTLOOK} -> ${DANA} (email)`,
      ].sort(),
    );
  });
});

// ===========================================================================
describe("BACKLOG-2624 — a nameless record asks, it never acts", () => {
  /**
   * The nameless spellings below are the ones the app WRITES, not `""`:
   *   - `"Unknown"` — `contactDbService.ts:187,327`, `contactHandlers.ts:1280,1519`,
   *     `localSyncService.ts:1534`, because `display_name` is NOT NULL;
   *   - the baked label — `contactsService.buildContactLabel:932-944` returns
   *     `emails[0]`, else `formatPhoneNumber(phones[0])`, for a record with no
   *     name. Built here by calling the same formatter that producer calls.
   */
  const TOMAS = "c-tomas";
  const TOMAS_LINE = "+14155550131";
  const INES = "c-ines";
  const INES_EMAIL = "ines.duarte@example.com";

  /** CONTROL 3 — nameless record, shared PHONE. */
  it("a nameless Outlook record sharing a phone is a question, not a link", () => {
    addContact(TOMAS, "Tomas Vega", { phones: [TOMAS_LINE] });
    addExternal("outlook-nameless-phone", "Unknown", {
      source: "outlook",
      phones: [TOMAS_LINE],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual([
      `outlook outlook-nameless-phone -> ${TOMAS} [name_unknown/pending]`,
    ]);
    expect(proposalSummaryFor("outlook-nameless-phone")).toContain("no name on it");
  });

  it("the same case with the record's phone BAKED into its name field", () => {
    addContact(TOMAS, "Tomas Vega", { phones: [TOMAS_LINE] });
    addExternal("outlook-baked-phone", formatPhoneNumber(TOMAS_LINE), {
      source: "outlook",
      phones: [TOMAS_LINE],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual([
      `outlook outlook-baked-phone -> ${TOMAS} [name_unknown/pending]`,
    ]);
  });

  /** CONTROL 4 — nameless record, shared EMAIL. */
  it("a nameless Outlook record sharing an email is a question, not a link", () => {
    addContact(INES, "Ines Duarte", { emails: [INES_EMAIL] });
    addExternal("outlook-nameless-email", INES_EMAIL, {
      source: "outlook",
      emails: [INES_EMAIL],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual([
      `outlook outlook-nameless-email -> ${INES} [name_unknown/pending]`,
    ]);
  });

  /**
   * CONTROL 5 — both sides nameless.
   *
   * This is the case the naive guard gets wrong. A contact imported from a
   * nameless record carries the BAKED LABEL as its `display_name` (the import
   * has no choice: `validateContactData` requires at least one character). A
   * second nameless record sharing that email carries the SAME baked label. Two
   * identical strings — and identical strings are exactly what a name check
   * reads as agreement.
   */
  it("two nameless records carrying the same baked label do NOT match on it", () => {
    const SHARED_EMAIL = "billing@twelve-oaks.example";
    const NAMELESS = addContact("c-nameless", SHARED_EMAIL, { emails: [SHARED_EMAIL] });
    addExternal("outlook-nameless-a", SHARED_EMAIL, {
      source: "outlook",
      emails: [SHARED_EMAIL],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual([
      `outlook outlook-nameless-a -> ${NAMELESS} [name_unknown/pending]`,
    ]);
  });

  it("two nameless records BOTH carrying the sentinel do not match on it either", () => {
    const SHARED_LINE = "+14155550177";
    const SENTINEL = addContact("c-sentinel", "Unknown", { phones: [SHARED_LINE] });
    addExternal("outlook-sentinel", "Unknown", {
      source: "outlook",
      phones: [SHARED_LINE],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual([
      `outlook outlook-sentinel -> ${SENTINEL} [name_unknown/pending]`,
    ]);
  });

  /**
   * THE GUARD CANNOT BE SWITCHED OFF BY FORGETTING A FIELD.
   *
   * `SourceRecordCandidate.name` is optional. A caller that omits it gets the
   * name read from `external_contacts` instead of a free pass — without that
   * fallback the veto would be live on the sweep and dead on every other caller,
   * which is precisely the shape `sourceRecordIsCurrent`'s docblock warns about.
   */
  it("a candidate built WITHOUT a name still gets the guard", () => {
    addContact(TOMAS, "Tomas Vega", { phones: [TOMAS_LINE] });
    addExternal("outlook-no-field", "Marcus Ord", {
      source: "outlook",
      phones: [TOMAS_LINE],
    });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "outlook",
      sourceRecordId: "outlook-no-field",
      // no `name` — the shadow row is consulted.
      phones: [TOMAS_LINE],
    });

    expect(resolution).toMatchObject({ outcome: "flagged", reason: "name_mismatch" });
    expect(allLinkTriples()).toEqual([]);
  });

  it("and a candidate whose name is missing EVERYWHERE asks rather than acts", () => {
    addContact(TOMAS, "Tomas Vega", { phones: [TOMAS_LINE] });
    // No `external_contacts` row at all — the record exists only as an argument.
    const resolution = resolveSourceRecord(USER, {
      sourceType: "outlook",
      sourceRecordId: "outlook-ghost",
      phones: [TOMAS_LINE],
    });

    expect(resolution).toMatchObject({ outcome: "flagged", reason: "name_unknown" });
    expect(allLinkTriples()).toEqual([]);
  });
});

// ===========================================================================
describe("BACKLOG-2619 — the guard runs LAST, so existing reasons are untouched", () => {
  /**
   * The name veto is placed after the same-source conflict and frozen-audit
   * branches deliberately: those know something more specific about WHY the
   * match is suspect, and both already withhold the link. If the guard ran
   * first it would relabel the Daniel/Lilly discriminator — the one that tells
   * "an identifier moved between people" from "one person saved twice" — as a
   * name problem, and that distinction would stop being testable.
   */
  it("the Daniel/Lilly shape keeps its own reason, not a name reason", () => {
    const MOVER = addContact("c-mover", "Mover Chen", { phones: ["+14155553333"] });
    // The incumbent is Mover's OWN card. It is linked by the sweep while it
    // still carries the number, and the number is taken off it afterwards —
    // which is the real sequence a correction in Contacts.app produces, and the
    // only way to reach this branch without writing a crosswalk row by hand.
    addExternal("UUID-MOVER-OLD:ABPerson", "Mover Chen", {
      phones: ["+14155553333"],
    });
    linkExternalContactsForUser(USER);
    expect(linkTriples(MOVER)).toEqual([`macos UUID-MOVER-OLD:ABPerson -> ${MOVER} (phone)`]);

    // The number moves to a different person's card, exactly as a correction in
    // Contacts.app does.
    mockDb!
      .prepare(
        "UPDATE external_contacts SET phones_json = '[]', phones_normalized_json = '[]' WHERE external_record_id = ?",
      )
      .run("UUID-MOVER-OLD:ABPerson");
    addExternal("UUID-MOVER-NEW:ABPerson", "Someone New", { phones: ["+14155553333"] });

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "UUID-MOVER-NEW:ABPerson",
      name: "Someone New",
      phones: ["+14155553333"],
    });

    expect(resolution).toEqual({
      outcome: "flagged",
      sourceRecordId: "UUID-MOVER-NEW:ABPerson",
      candidateContactId: MOVER,
      conflictingSourceRecordId: "UUID-MOVER-OLD:ABPerson",
      matchedOn: "phone",
      // NOT `name_mismatch`, even though the names disagree.
      reason: "identifier_reassigned",
    });
  });

  it("an ambiguous identifier is still ambiguous, whatever the names say", () => {
    const A = addContact("c-amb-a", "Alma Ferro", { phones: ["+14155550144"] });
    const B = addContact("c-amb-b", "Bruno Ferro", { phones: ["+14155550144"] });
    addExternal("outlook-amb", "Marcus Ord", {
      source: "outlook",
      phones: ["+14155550144"],
    });

    linkExternalContactsForUser(USER);

    expect(allLinkTriples()).toEqual([]);
    expect(proposalTriples()).toEqual(
      [
        `outlook outlook-amb -> ${A} [ambiguous_identifier/pending]`,
        `outlook outlook-amb -> ${B} [ambiguous_identifier/pending]`,
      ].sort(),
    );
  });
});
