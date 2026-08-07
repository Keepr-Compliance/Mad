/**
 * @jest-environment node
 *
 * BACKLOG-2426 (manual linking) + BACKLOG-2419 (a stronger reason replaces a
 * weaker one) — WORK GROUP A.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT SETS AND EXACT STRINGS, NEVER COUNTS OR NOT-NULL
 * ---------------------------------------------------------------------------
 * `expect(links).toHaveLength(1)` is equally satisfied by linking the WRONG
 * record, and `expect(description).toBeTruthy()` by every wrong sentence. The
 * provenance assertions below name the sentence VERBATIM, because the whole
 * point of BACKLOG-2419 is which of two true-looking sentences is shown.
 *
 * ---------------------------------------------------------------------------
 * THE AFFORDANCE TWIN (§A1) — WHY A DATABASE ASSERTION IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The harm an implicit `match_method` upgrade would do is NOT visible in the
 * crosswalk: the row stays well-formed and only the CARD changes, losing its
 * Unlink button. So the control for it asserts on
 * `src/utils/contactSourceAffordances` — fed by REAL `getContactProvenance`
 * output from a REAL linking pass, never a hand-written fixture, so it cannot
 * describe a state the code is incapable of emitting.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES
 * ---------------------------------------------------------------------------
 * RFC 2606 reserved domains (`example.com`) and `+1 <area> 555-01xx` numbers.
 * The reserved slot is the EXCHANGE — `555` in the AREA CODE fails
 * `scripts/ci/check-fixture-pii.mjs` (`/^\d{3}55501\d{2}$/`).
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

/**
 * Step 7 of the write, mocked so one test can make it THROW and prove the
 * earlier writes roll back. Default passes through to the real implementation
 * so every other test exercises the genuine copy.
 */
const applyLinkedSourceValuesMock = jest.fn();
jest.mock("../contactSourceValues", () => {
  const actual = jest.requireActual("../contactSourceValues");
  return {
    ...actual,
    applyLinkedSourceValues: (...args: unknown[]) => applyLinkedSourceValuesMock(...args),
  };
});

import {
  findLinkableSourceRecords,
  linkSourceRecordToContact,
  linkSourceRecordsToContact,
} from "../contactManualLink";
import { resolveSourceRecord } from "../contactSourceLinker";
import { confirmProposal } from "../contactLinkReview";
import { getContactProvenance } from "../contactProvenance";
import { getLinksForContact, createLink } from "../db/contactSourceLinkDbService";
import {
  hasCannotLink,
  hasMustLink,
  proposeLink,
  recordVerdict,
  listVerdicts,
} from "../db/contactLinkReviewDbService";
// The affordance rule is a PURE renderer util; importing it here is what makes
// the A1 control able to assert at the layer the user experiences. Precedent:
// electron/services/__tests__/gmailFetchService.test.ts imports src/utils.
import { canUnlinkSource, showSourcesPanel } from "../../../src/utils/contactSourceAffordances";

const USER = "user-2426";
const PAT = "contact-pat";
const JANE = "contact-jane";
const REMOVED = "contact-removed";

const OUTLOOK_RECORD = "AAMkAGoutlook-robin-1";
const MACOS_RECORD = "macos-pat-1";

function addContact(id: string, displayName: string, opts: { removed?: boolean } = {}): void {
  mockDb!
    .prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, removed_at) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, USER, displayName, opts.removed ? "2026-08-01T00:00:00.000Z" : null);
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
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `ext-${opts.source ?? "macos"}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      "2026-08-06T00:00:00.000Z",
    );
}

/** Every crosswalk link for a contact as `sourceType|recordId|method` — a SET. */
function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}|${l.match_method}`)
    .sort();
}

/**
 * TRANSCRIBED from `electron/database/schema.sql` — `phone_last_message` at
 * :1269-1275, `emails` at :361 (narrowed to the columns the expression reads),
 * `email_participants` at :464-474. Not invented.
 *
 * The shared identity-schema helper does not carry them, but
 * `contactRecencySql.EXTERNAL_CONTACT_LAST_MESSAGE_EXPR` subqueries all three on
 * every `external_contacts` read — so without them the search paths fail with
 * "no such table" instead of exercising the code under test.
 */
const RECENCY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS phone_last_message (
    phone_normalized TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_message_at DATETIME NOT NULL,
    PRIMARY KEY (phone_normalized, user_id)
  );
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    sent_at DATETIME,
    received_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS email_participants (
    email_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
    position INTEGER NOT NULL,
    participant_hash TEXT NOT NULL,
    email_address TEXT NOT NULL,
    display_name TEXT,
    resolved_contact_id TEXT,
    PRIMARY KEY (email_id, role, position)
  );
`;

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(RECENCY_TABLES_SQL);
  applyLinkedSourceValuesMock.mockReset();
  applyLinkedSourceValuesMock.mockImplementation(() => undefined);
  addContact(PAT, "Pat Riverton");
  addContact(JANE, "Jane Doe");
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. THE SEARCH — unclaimed records only
// ===========================================================================
describe("findLinkableSourceRecords", () => {
  /**
   * =========================================================================
   * R-A — THE CONTROL THIS SWAP CANNOT SHIP WITHOUT (BACKLOG-2591)
   * =========================================================================
   * Rendering through `ContactSearchList` makes it tempting to also feed the
   * link panel the `externalContacts` the transaction pickers already hold —
   * the data "is right there". IT IS NOT THE SAME SET, and the difference is
   * the whole feature.
   *
   * `contacts:get-available` applies THREE exclusions:
   *
   *   1. `linkedSourceKeys.has(sourceKey(...))`        — the crosswalk
   *   2. `emailClaimedByImported(primaryEmail, name)`  — a heuristic
   *   3. `phoneClaimedByImported(normalized, name)`    — a heuristic
   *
   * `findLinkableSourceRecords` applies ONLY the crosswalk. So a record no
   * crosswalk row claims but whose EMAIL matches a saved contact is linkable
   * here and INVISIBLE there — and that is the single most common duplicate
   * shape the founder reported: an address-book entry for someone he has
   * already saved, never linked.
   *
   * Reusing the picker's data would have removed the feature's purpose while
   * every other test in this repo stayed green.
   *
   * CONTROL: add an email-claimed exclusion here, i.e. make this behave like
   * `get-available`. OBSERVED: 1 failed / 20 passed.
   */
  it("offers a record whose EMAIL matches a saved contact but which no crosswalk row claims", () => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)")
      .run("pat-e0", PAT, "pat@example.com");

    // An address-book record for the SAME person, sharing that email, with NO
    // crosswalk row. `get-available` suppresses this as "already imported";
    // linking must still offer it, because attaching it IS the feature.
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });

    expect(findLinkableSourceRecords(USER).map((r) => r.sourceRecordId)).toEqual([MACOS_RECORD]);
  });

  /**
   * CONTROL: drop the `claimed.has(...)` filter.
   * OBSERVED: 1 failed / 12 passed — the claimed record joins the results.
   */
  it("returns the EXACT set of unclaimed records, excluding claimed ones", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook", emails: ["robin@example.org"] });
    createLink({
      userId: USER,
      contactId: PAT,
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      matchMethod: "email",
    });

    const keys = findLinkableSourceRecords(USER).map(
      (r) => `${r.sourceType}|${r.sourceRecordId}`,
    );
    expect(keys).toEqual(["outlook|" + OUTLOOK_RECORD]);
  });

  /**
   * BACKLOG-2591: TEXT SEARCH IS NO LONGER THIS FUNCTION'S JOB. The renderer
   * filters the returned set in memory through `ContactSearchList`, exactly
   * like the transaction pickers, so what this must still get right is the SET
   * and each record's descriptive fields.
   */
  it("reports each record's source in words", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook", emails: ["robin@example.org"] });
    const found = findLinkableSourceRecords(USER);
    expect(found.map((r) => r.sourceRecordId)).toEqual([OUTLOOK_RECORD]);
    expect(found[0].sourceLabel).toBe("Outlook contacts");
  });

  /**
   * =========================================================================
   * FOUNDER QA, PR #2254: *"does the search allow for circular linking — does
   * it filter out the contact I'm on from the list?"*
   * =========================================================================
   *
   * TWO INDEPENDENT REASONS THE ANSWER IS NO, and the first is structural.
   *
   * 1. **The list is a different KIND of thing from the contact.** Candidates
   *    come from `external_contacts` — address-book records — through
   *    `externalContactDbService.search` / `getAllForUser`. A saved `contacts`
   *    row can never appear in it, so "link this contact to itself" is not an
   *    expressible request rather than a filtered-out one.
   *    `findLinkableSourceRecords` is not even GIVEN a `contactId`.
   *
   * 2. **Its own source records are already excluded** by the third filter,
   *    `claimed.has(sourceKey(record.source, record.external_record_id))`,
   *    where `claimed` is `getLinkedSourceKeys(userId)` — EVERY crosswalk row
   *    for the user. Anything the current contact holds is in that set. It is
   *    the same set `contacts:get-available` uses for the import picker, so a
   *    record cannot be offered here and hidden there.
   */
  it("never offers a record the CURRENT contact already holds", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    // PAT's own imported record — exactly what "the contact I'm on" means.
    createLink({
      userId: USER,
      contactId: PAT,
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      matchMethod: "source_id",
    });

    const keys = findLinkableSourceRecords(USER).map(
      (r) => `${r.sourceType}|${r.sourceRecordId}`,
    );
    expect(keys).toEqual([`outlook|${OUTLOOK_RECORD}`]);
  });

  /**
   * The contact's ORIGIN row points at a synthetic `source_record_id`
   * (`origin:<contactId>`) whose source type is outside the five external ones.
   * It JOINs no `external_contacts` row, so it cannot reach the candidate list
   * at all — and the source-type filter would reject it even if it could.
   */
  it("never offers the contact's own origin row", () => {
    mockDb!
      .prepare(
        `INSERT INTO contact_source_links
           (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES ('link-origin', ?, ?, 'manual', ?, 'origin')`,
      )
      .run(USER, PAT, `origin:${PAT}`);

    expect(findLinkableSourceRecords(USER)).toEqual([]);
    expect(findLinkableSourceRecords(USER)).toEqual([]);
  });

  /**
   * THE CASE A NAIVE CIRCULARITY FIX WOULD BREAK, pinned so nobody adds one.
   *
   * Filtering the list by the contact's NAME looks like a reasonable "don't
   * show me myself" guard and would destroy the feature: attaching an
   * address-book record for the SAME PERSON is the entire point. Only the
   * crosswalk decides what is already claimed — never the name.
   */
  it("STILL offers an unclaimed record that shares the contact's name", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });

    const found = findLinkableSourceRecords(USER);
    expect(found.map((r) => r.sourceRecordId)).toEqual([MACOS_RECORD]);
  });

  /**
   * The round trip: once linked, the record leaves the list — so the same pair
   * cannot be offered twice and no second crosswalk row can be attempted.
   */
  it("drops a record from the list once it has been linked", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    expect(findLinkableSourceRecords(USER).map((r) => r.sourceRecordId)).toEqual([
      OUTLOOK_RECORD,
    ]);

    linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD);

    expect(findLinkableSourceRecords(USER)).toEqual([]);
  });
});

// ===========================================================================
// 2. THE WRITE — and every refusal that precedes it
// ===========================================================================
describe("linkSourceRecordToContact", () => {
  it("writes a manual link, a same_person verdict, and copies the addresses", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", {
      source: "outlook",
      emails: ["robin@example.org"],
      phones: ["+1 206 555-0142"],
    });

    const outcome = linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD);

    expect(outcome).toEqual({ ok: true, linkId: expect.any(String) });
    expect(linkSet(PAT)).toEqual([`outlook|${OUTLOOK_RECORD}|manual`]);
    expect(hasMustLink(USER, PAT, "outlook", OUTLOOK_RECORD)).toBe(true);
    expect(applyLinkedSourceValuesMock).toHaveBeenCalledWith(USER, PAT);
  });

  /**
   * The provenance sentence a manual link produces, VERBATIM.
   *
   * CONTROL: pass `matchMethod: "source_id"` in `linkSourceRecordToContact`.
   * OBSERVED: 3 failed / 10 passed — this sentence becomes "Recognised by its
   * own entry in your Outlook contacts", and the two `linkSet` assertions that
   * name the method go red with it.
   */
  it("renders the manual link as 'You confirmed this yourself'", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD);

    const sources = getContactProvenance(USER, PAT);
    expect(sources.map((s) => s.matchMethod)).toEqual(["manual"]);
    expect(sources[0].matchDescription).toBe("You confirmed this yourself");
  });

  /**
   * THE MERGE GUARD. Joining two saved contacts is out of scope across the
   * whole epic, and a re-point here would be exactly that.
   *
   * CONTROL: delete the `incumbent && incumbent !== contactId` refusal.
   * OBSERVED: 1 failed / 12 passed — the call reports `{ ok: true }` carrying
   * JANE's link id, having written a `same_person` verdict binding PAT to a
   * record PAT does not hold. `createLink`'s own refusal stops the re-point, so
   * the damage is a false success and a spurious verdict — which is precisely
   * why the outcome SHAPE is asserted and not just the link table.
   */
  it("refuses a record another contact claims, names the incumbent, writes nothing", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    createLink({
      userId: USER,
      contactId: JANE,
      sourceType: "outlook",
      sourceRecordId: OUTLOOK_RECORD,
      matchMethod: "email",
    });

    const outcome = linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD);

    expect(outcome).toEqual({ ok: false, reason: "claimed", incumbentContactId: JANE });
    expect(linkSet(PAT)).toEqual([]);
    expect(linkSet(JANE)).toEqual([`outlook|${OUTLOOK_RECORD}|email`]);
    expect(listVerdicts(USER)).toEqual([]);
  });

  /**
   * A tombstoned contact is invisible in the list but still holds its links,
   * and the UNIQUE constraint would then block the LIVE contact the user
   * wanted. `contactTombstoneSql` says plainly that matching lookups are not
   * tombstone-filtered, so this filter cannot be inherited — it is spelled out.
   *
   * CONTROL: drop `ACTIVE_CONTACTS_CLAUSE_UNALIASED` from the contact lookup.
   * OBSERVED: 1 failed / 12 passed — the link is written onto a removed contact.
   */
  it("refuses a tombstoned contact and writes nothing", () => {
    addContact(REMOVED, "Removed Person", { removed: true });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });

    const outcome = linkSourceRecordToContact(USER, REMOVED, "outlook", OUTLOOK_RECORD);

    expect(outcome).toEqual({ ok: false, reason: "contact_removed" });
    expect(linkSet(REMOVED)).toEqual([]);
    expect(listVerdicts(USER)).toEqual([]);
  });

  it("refuses a source type the crosswalk does not accept", () => {
    expect(linkSourceRecordToContact(USER, PAT, "contacts_app", MACOS_RECORD)).toEqual({
      ok: false,
      reason: "unknown_source",
    });
  });

  it("refuses a record that is not in the address book", () => {
    expect(linkSourceRecordToContact(USER, PAT, "outlook", "no-such-record")).toEqual({
      ok: false,
      reason: "record_not_found",
    });
  });
});

// ===========================================================================
// 3. OVERTURNING A PRIOR UNLINK — disclose first, then act
// ===========================================================================
describe("a prior 'different people' answer", () => {
  function seedRejectedPair(): void {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    recordVerdict({
      userId: USER,
      contactId: PAT,
      sourceType: "outlook",
      sourceRecordId: OUTLOOK_RECORD,
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });
  }

  /**
   * CONTROL: skip the `getLatestVerdict` read in `linkSourceRecordToContact`.
   * OBSERVED: 1 failed / 12 passed — the first attempt links silently, so the
   * user is never told they are reversing themselves.
   */
  it("is disclosed rather than overwritten, and nothing is written yet", () => {
    seedRejectedPair();

    const outcome = linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD);

    expect(outcome).toEqual({ ok: false, reason: "prior_rejection" });
    expect(linkSet(PAT)).toEqual([]);
    expect(hasCannotLink(USER, PAT, "outlook", OUTLOOK_RECORD)).toBe(true);
  });

  /**
   * No delete is needed: `recordVerdict` only appends and `getLatestVerdict`
   * takes the newest, so a newer `same_person` supersedes the older answer.
   *
   * CONTROL: drop the `recordVerdict` call from `linkSourceRecordToContact`.
   * OBSERVED: 2 failed / 11 passed — `hasCannotLink` stays true here (so the
   * next automatic pass would treat the pair as barred despite the user's
   * link), and the happy-path `hasMustLink` assertion goes red with it.
   */
  it("is superseded once acknowledged, so the pair is no longer barred", () => {
    seedRejectedPair();

    const outcome = linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD, {
      acknowledgedPriorRejection: true,
    });

    expect(outcome).toEqual({ ok: true, linkId: expect.any(String) });
    expect(linkSet(PAT)).toEqual([`outlook|${OUTLOOK_RECORD}|manual`]);
    expect(hasCannotLink(USER, PAT, "outlook", OUTLOOK_RECORD)).toBe(false);
    expect(hasMustLink(USER, PAT, "outlook", OUTLOOK_RECORD)).toBe(true);
  });
});

// ===========================================================================
// 4. ATOMICITY — the check CI cannot provide
// ===========================================================================
describe("the write is all-or-nothing", () => {
  /**
   * `writeAtomicity.guard.test.ts` scans `electron/services/db` ONLY, and this
   * service is deliberately a layer above that (see its docblock). So THIS TEST
   * IS THE ONLY THING standing between a future edit and a half-written link.
   *
   * CONTROL: remove `dbTransaction` from `linkSourceRecordToContact` (return
   * the body directly).
   * OBSERVED: 1 failed / 12 passed — the verdict survives the throw, leaving a
   * `same_person` answer for a pair that is not linked.
   */
  it("rolls the verdict back when a later step throws", () => {
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    applyLinkedSourceValuesMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => linkSourceRecordToContact(USER, PAT, "outlook", OUTLOOK_RECORD)).toThrow(
      "disk full",
    );

    expect(linkSet(PAT)).toEqual([]);
    expect(listVerdicts(USER)).toEqual([]);
  });
});

// ===========================================================================
// 5. BACKLOG-2419 — confirming a question upgrades the reason it records
// ===========================================================================
describe("confirming a review-queue question (BACKLOG-2419)", () => {
  /**
   * The reachable 2419 defect. The opportunistic matcher links the pair by
   * email and files a question; the user answers "same person"; `confirmProposal`
   * passes `matchMethod: "manual"` — and until `assertMethod` existed
   * `createLink` discarded it, leaving the card asserting an email match after a
   * human had agreed. The source comment above that call already claimed the
   * behaviour the code lacked.
   *
   * CONTROL: drop `assertMethod: true` at the `contactLinkReview` call site.
   * OBSERVED: 1 failed / 12 passed — the sentence stays "Matched by an email
   * address you already had for this person".
   */
  it("replaces the email sentence with the human one, verbatim", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    createLink({
      userId: USER,
      contactId: PAT,
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      matchMethod: "email",
    });

    // The sentence BEFORE the answer — the state the founder objected to.
    expect(getContactProvenance(USER, PAT)[0].matchDescription).toBe(
      "Matched by an email address you already had for this person",
    );

    const { id: proposalId } = proposeLink({
      userId: USER,
      contactId: PAT,
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      reason: "ambiguous_identifier",
      identityAssessment: "possibly_same_person",
      relationshipAssessment: "possibly_connected",
      clusterKey: `contact:${PAT}`,
      evidence: {
        summary: "Two records share an email address.",
        details: ["Both carry pat@example.com."],
        contactLabel: "Pat Riverton",
        sourceLabel: "your Mac address book",
        sourceName: "Pat Riverton",
      },
    }) as { created: boolean; id: string };

    confirmProposal(USER, proposalId);

    const after = getContactProvenance(USER, PAT);
    expect(after.map((s) => s.matchMethod)).toEqual(["manual"]);
    expect(after[0].matchDescription).toBe("You confirmed this yourself");
  });
});

// ===========================================================================
// 6. §A1 — THE AFFORDANCE TWIN
// ===========================================================================
describe("a sync pass must not withdraw the Unlink button (§A1)", () => {
  /**
   * THE CONTROL THAT ASSERTS WHERE THE USER LIVES.
   *
   * `contactSourceLinker` STEP 1 re-calls `createLink` with a hard-coded
   * `source_id` to capture an `external_uuid`. If that were treated as an
   * assertion, a single-source content-matched contact would silently become
   * `source_id` — and because `isAttachedSource("source_id")` is FALSE, the
   * card would lose `Unlink` AND the whole Sources panel. The crosswalk row
   * would still look perfectly well-formed.
   *
   * The provenance below is REAL `getContactProvenance` output following a REAL
   * `resolveSourceRecord` pass — not a fixture — so it cannot describe a state
   * the code is incapable of producing.
   *
   * CONTROL: default `assertMethod` to `true` in `createLink`.
   * OBSERVED: 1 failed / 12 passed, red AT `showSourcesPanel(sourceList)` —
   * the user-facing layer, which is the whole point of §A1. The founder loses a
   * button he had yesterday and the crosswalk row still looks well-formed.
   */
  it("keeps the panel and the Unlink control after a uuid-capturing pass", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    createLink({
      userId: USER,
      contactId: PAT,
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      matchMethod: "email",
    });

    // The real sync path, on an already-linked pair that now carries a uuid.
    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: MACOS_RECORD,
      externalUuid: "zexternaluuid-from-the-address-book",
      emails: ["pat@example.com"],
      phones: [],
    });
    expect(resolution.outcome).toBe("already_linked");

    // THE AFFORDANCE ASSERTIONS COME FIRST, DELIBERATELY.
    //
    // They were originally written after the crosswalk assertion below, and the
    // control exposed that as a mistake: the db assertion failed first, so the
    // test aborted before reaching these and the affordance half was never
    // actually exercised by the red run. A control that cannot reach its own
    // subject is not a control — the same "the check that would fail is missing
    // from the set" shape this suite exists to catch, one level down.
    const sourceList = getContactProvenance(USER, PAT).filter((s) => s.matchMethod !== "origin");
    expect(showSourcesPanel(sourceList)).toBe(true);
    expect(canUnlinkSource(sourceList, sourceList[0])).toBe(true);

    // Corroboration, after the fact: the same state, read from the crosswalk.
    expect(sourceList.map((s) => s.matchMethod)).toEqual(["email"]);
    expect(linkSet(PAT)).toEqual([`macos|${MACOS_RECORD}|email`]);
  });
});

// ===========================================================================
// 7. MULTI-RECORD LINKING (BACKLOG-2591)
// ===========================================================================
describe("linking several records at once", () => {
  const SECOND_RECORD = "macos-pat-2";

  /**
   * Per-record refusals: one claimed record does not stop the others.
   *
   * NOTE this is NOT the atomicity control — see the throw test below. A
   * refusal is RETURNED rather than thrown, so wrapping the batch in one
   * transaction passes this test unchanged (measured). This pins the OUTCOME
   * MAPPING; the next test pins the transaction shape.
   */
  it("links the good records even when one is claimed by another contact", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    addExternal(SECOND_RECORD, "Pat Riverton work", { emails: ["p.riverton@example.net"] });

    // The middle record already belongs to JANE.
    createLink({
      userId: USER,
      contactId: JANE,
      sourceType: "outlook",
      sourceRecordId: OUTLOOK_RECORD,
      matchMethod: "email",
    });

    const outcomes = linkSourceRecordsToContact(USER, PAT, [
      { sourceType: "macos", sourceRecordId: MACOS_RECORD },
      { sourceType: "outlook", sourceRecordId: OUTLOOK_RECORD },
      { sourceType: "macos", sourceRecordId: SECOND_RECORD },
    ]);

    // One outcome per input, SAME ORDER — so the caller can name which record
    // did what without matching on identity.
    expect(outcomes.map((o) => (o.ok ? "ok" : o.reason))).toEqual(["ok", "claimed", "ok"]);

    // Both good links exist; the incumbent's link is untouched.
    expect(linkSet(PAT)).toEqual([
      `macos|${MACOS_RECORD}|manual`,
      `macos|${SECOND_RECORD}|manual`,
    ]);
    expect(linkSet(JANE)).toEqual([`outlook|${OUTLOOK_RECORD}|email`]);
  });

  /**
   * The batch disclosure: records the user previously unlinked come back
   * `prior_rejection` and write NOTHING, while the others link normally — so
   * the question is asked once for the batch rather than per record.
   *
   * CONTROL: skip the `getLatestVerdict` read in `linkSourceRecordToContact`.
   */
  it("discloses prior rejections once, without blocking the others", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });
    recordVerdict({
      userId: USER,
      contactId: PAT,
      sourceType: "outlook",
      sourceRecordId: OUTLOOK_RECORD,
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });

    const first = linkSourceRecordsToContact(USER, PAT, [
      { sourceType: "macos", sourceRecordId: MACOS_RECORD },
      { sourceType: "outlook", sourceRecordId: OUTLOOK_RECORD },
    ]);
    expect(first.map((o) => (o.ok ? "ok" : o.reason))).toEqual(["ok", "prior_rejection"]);
    expect(linkSet(PAT)).toEqual([`macos|${MACOS_RECORD}|manual`]);

    // Asked once, answered once.
    const second = linkSourceRecordsToContact(
      USER,
      PAT,
      [{ sourceType: "outlook", sourceRecordId: OUTLOOK_RECORD }],
      { acknowledgedPriorRejections: [{ sourceType: "outlook", sourceRecordId: OUTLOOK_RECORD }] },
    );
    expect(second.map((o) => o.ok)).toEqual([true]);
    expect(hasCannotLink(USER, PAT, "outlook", OUTLOOK_RECORD)).toBe(false);
  });

  /**
   * THE ATOMICITY CONTROL — and the reason it uses a THROW.
   *
   * My first version of this asserted on a `claimed` refusal and DID NOT GO RED
   * when the loop was wrapped in a single transaction, because a refusal is
   * returned rather than thrown: the outer transaction commits identically. A
   * control that cannot separate the two shapes is not a control, so it was
   * replaced rather than reworded.
   *
   * A genuine exception is what distinguishes them. Here record 2 throws while
   * copying values; record 1 is already committed by its own transaction and
   * MUST survive. Under one big transaction it would be rolled back with it.
   *
   * CONTROL: wrap the loop in a single `dbTransaction`.
   * OBSERVED: 1 failed / 21 passed.
   */
  it("keeps the links already committed when a later record throws", () => {
    addExternal(MACOS_RECORD, "Pat Riverton", { emails: ["pat@example.com"] });
    addExternal(OUTLOOK_RECORD, "Robin Marsh", { source: "outlook" });

    let call = 0;
    applyLinkedSourceValuesMock.mockImplementation(() => {
      call += 1;
      if (call === 2) throw new Error("disk full");
    });

    expect(() =>
      linkSourceRecordsToContact(USER, PAT, [
        { sourceType: "macos", sourceRecordId: MACOS_RECORD },
        { sourceType: "outlook", sourceRecordId: OUTLOOK_RECORD },
      ]),
    ).toThrow("disk full");

    // Record 1 committed in its OWN transaction and survives the later throw.
    expect(linkSet(PAT)).toEqual([`macos|${MACOS_RECORD}|manual`]);
  });

  /**
   * BACKLOG-2591 — THE COST OF DROPPING THE LIMIT, MEASURED RATHER THAN ASSUMED.
   *
   * `findLinkableSourceRecords` now returns the WHOLE unclaimed set through
   * `getAllForUser` — a synchronous `dbAll` with no LIMIT, on the main process,
   * once per panel open. The transaction pickers move the same volume through a
   * WORKER (TASK-1956; `get-available` measured at ~3.7s at 1000+ contacts).
   * This path does not, so the number is recorded rather than guessed.
   *
   * MEASURED at 1200 records: **3 ms** — three orders of magnitude below the
   * worker path, because that path's cost is the per-row funnel work, not the
   * read. The ceiling below is deliberately loose: it exists to catch an
   * order-of-magnitude regression (an accidental N+1, a per-row subquery), not
   * to pin a machine-specific timing.
   */
  it("returns a realistic address book in a bounded time", () => {
    const N = 1200;
    const insert = mockDb!.prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'macos', ?, NULL)`,
    );
    const seed = mockDb!.transaction(() => {
      for (let i = 0; i < N; i++) {
        const exchange = String(i % 100).padStart(2, "0");
        insert.run(
          `ext-bulk-${i}`,
          USER,
          `Pat Riverton ${i}`,
          JSON.stringify([`+1 206 555-01${exchange}`]),
          JSON.stringify([`206555 01${exchange}`.replace(/\s/g, "")]),
          JSON.stringify([`pat${i}@example.com`]),
          `macos-bulk-${i}`,
          "2026-08-07T00:00:00.000Z",
        );
      }
    });
    seed();

    const started = Date.now();
    const found = findLinkableSourceRecords(USER);
    const elapsedMs = Date.now() - started;

    expect(found).toHaveLength(N);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
