/**
 * @jest-environment node
 *
 * BACKLOG-2666 — the unique-name rule must not bind a contact on a FILED audit.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS DEFENDING, AND WHY IT NEEDED ITS OWN FILE
 * ===========================================================================
 * `runUniqueNameAutoLink` creates a crosswalk link and then calls
 * `applyLinkedSourceValues`. Until this fix it consulted `hasCannotLink` — a
 * prior "different people" verdict — and NOTHING about whether the contact's
 * details had already gone out in an exported audit. It was the third route
 * past that guard found in one evening; the other two are the linker's content
 * fallback (which refuses correctly) and the backfill query (BACKLOG-2664,
 * gated inside `CONTACT_SOURCE_RECORDS_SQL` by PR #2291).
 *
 * ===========================================================================
 * TWO ASSERTIONS, NOT ONE — THE 2664 LESSON
 * ===========================================================================
 * "No link" and "no value copied" are SEPARATE claims and must go red
 * separately. On BACKLOG-2664 the link assertion passed while the values
 * arrived anyway, because the writer was in a different module. So every frozen
 * case here asserts the exact `contact_source_links` set AND the exact
 * `contact_phones` / `contact_emails` sets.
 *
 * ===========================================================================
 * THE FIXTURES CARRY REAL VALUES, DELIBERATELY
 * ===========================================================================
 * The sibling suite `contactNameAutoLink.test.ts` seeds every external record
 * with `emails_json: '[]'`, which makes a value assertion vacuous — nothing can
 * be copied because there is nothing to copy, and a test written against those
 * fixtures would pass with the copy call deleted. Every record here carries a
 * reserved `555-01xx` number and an `example.*` address, and the contact is
 * pre-seeded with its own linked record's values exactly as the import would
 * have left it. So the ONLY thing that can move the exact set is a NEW link.
 *
 * ===========================================================================
 * EXACT SETS, NEVER COUNTS
 * ===========================================================================
 * `expect(phones).toHaveLength(1)` is satisfied by the wrong phone. Two of the
 * three numbers below differ only in the final digit.
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

import { runUniqueNameAutoLink, type AskPair } from "../contactNameAutoLink";
import { createLink, getLinksForContact } from "../db/contactSourceLinkDbService";
import {
  listPendingProposals,
  proposeLink,
  recordVerdict,
  type LinkProposalReason,
} from "../db/contactLinkReviewDbService";
import { buildEvidence } from "../contactLinkEvidence";
import type { ExternalContactSource } from "../db/externalContactDbService";

const USER = "user-frozen-name-2666";

// ---------------------------------------------------------------------------
// FIXTURE VALUES — RFC 2606 domains, NANP reserved 555-0100..0199 range.
//
// PROVENANCE, STATED SO NOBODY HAS TO ASK AGAIN (BACKLOG-2666):
//
//   - `Priya Raman` is this repo's ESTABLISHED name for a saved contact that a
//     record content-matches but is not the same person. She is named in
//     `contactSourceLinker.ts`'s docblock and in three suites already
//     (`contactSourceLinker.nameGuard-2619`, `autoLinkNameGuard-2624`,
//     `contact-handlers.foldDeleted-2556`). Reused deliberately: two suites
//     naming one person is how a reader connects them.
//   - `Rosalind Farquharson` is INVENTED for this suite. The surname was made
//     up; it is not derived from any record, card, database or message. She is
//     NOT the `Rosalind Vance` of `contact-handlers.stopHidingRecords-2608` — a
//     different fixture person in a different scenario. Her address is spelled
//     out in full below precisely so the two cannot be confused: that suite
//     owns the bare `rosalind@example.com`, and this one must not borrow it.
//
// Neither name is in `FICTIONAL_NAMES` (`scripts/ci/check-fixture-pii.mjs`) and
// neither needs to be: the guard pairs a quoted name with an identifier ON THE
// SAME LINE, and every name here sits alone on its own `const`. That is a
// documented deliberate gap in the guard, not a hole these fixtures found — see
// the note at `check-fixture-pii.mjs:200-203`. Closing it is one deliberate
// repo-wide pass with SR's agreement, not two engineers tidying their corners.
// ---------------------------------------------------------------------------
const MAC_PHONE = "+15035550140";
const OUT_PHONE = "+15035550141"; // differs from MAC_PHONE in the last digit only
const TWIN_OUT_PHONE = "+15035550142";
const MAC_EMAIL = "rosalind.farquharson@example.com";
const OUT_EMAIL = "r.farquharson@example.net";
const TWIN_OUT_EMAIL = "priya.twin@example.net";

const FROZEN_NAME = "Rosalind Farquharson";
const UNFROZEN_NAME = "Priya Raman";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
function addContact(id: string, displayName: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
}

function addExternal(
  recordId: string,
  name: string,
  source: ExternalContactSource,
  emails: string[],
  phones: string[],
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-11T00:00:00.000Z')`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(emails),
      recordId,
      source,
    );
}

/**
 * The values the import already put on the contact from the record it was
 * created from. Written as `source = 'import'`, which is what the backfill
 * writes — see `contactSourceValues`' header for why that column matters.
 */
function seedOwnValues(contactId: string, email: string, phone: string): void {
  mockDb!
    .prepare(
      "INSERT INTO contact_emails (id, contact_id, email, source) VALUES (?, ?, ?, 'import')",
    )
    .run(`ce-${contactId}`, contactId, email);
  mockDb!
    .prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, source)
       VALUES (?, ?, ?, ?, 'import')`,
    )
    .run(`cp-${contactId}`, contactId, phone, phone.replace(/\D/g, "").slice(-10));
}

/**
 * A transaction that has been EXPORTED, with the contact as a party.
 *
 * The direct FK column is used here; `frozenContactSql`'s parity suite
 * (BACKLOG-2664) covers all three routes into the predicate — FK column,
 * junction and `other_contacts` JSON — so this suite does not re-prove them.
 */
function freezeContact(contactId: string, transactionId: string): void {
  mockDb!
    .prepare(
      `INSERT INTO transactions (id, user_id, property_address, first_exported_at, buyer_agent_id)
       VALUES (?, ?, '4821 Beaumont Way', '2026-08-05T00:00:00.000Z', ?)`,
    )
    .run(transactionId, USER, contactId);
}

// ---------------------------------------------------------------------------
// Readers — every one returns a SORTED EXACT SET
// ---------------------------------------------------------------------------
function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}|${l.match_method}`)
    .sort();
}

function phoneSet(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ?")
      .all(contactId) as Array<{ phone_e164: string }>
  )
    .map((r) => r.phone_e164)
    .sort();
}

function emailSet(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT email FROM contact_emails WHERE contact_id = ?")
      .all(contactId) as Array<{ email: string }>
  )
    .map((r) => r.email)
    .sort();
}

function proposalSet(): string[] {
  return listPendingProposals(USER)
    .map((p) => `${p.contact_id}|${p.source_type}|${p.source_record_id}|${p.reason}`)
    .sort();
}

/**
 * `contactHandlers.fileNameQuestion`, TRANSCRIBED (contactHandlers.ts:708-741).
 *
 * The pass takes `onAsk` as a callback so the module stays free of the queue's
 * schema; the handler owns the write. Importing the handler here would drag in
 * the whole IPC surface, so its body is copied rather than approximated — the
 * point of the proposal assertions below is that the question a REAL user would
 * see gets filed, and a hand-rolled INSERT would prove only that this test can
 * write a row.
 */
function fileNameQuestion(
  pair: AskPair,
  ctx: { reason: LinkProposalReason; holderCount: number; displayName: string },
): void {
  const built = buildEvidence({
    userId: USER,
    contactId: pair.contactId,
    sourceType: pair.sourceType,
    sourceRecordId: pair.sourceRecordId,
    reason: ctx.reason,
    matchedOn: "name",
    matchedValues: [ctx.displayName],
    nameHolderCount: ctx.holderCount,
    nameText: ctx.displayName,
  });
  proposeLink({
    userId: USER,
    contactId: pair.contactId,
    sourceType: pair.sourceType,
    sourceRecordId: pair.sourceRecordId,
    reason: ctx.reason,
    matchedOn: "name",
    identityAssessment: built.identityAssessment,
    relationshipAssessment: built.relationshipAssessment,
    clusterKey: `name:${ctx.displayName.trim().toLowerCase()}`,
    evidence: built.evidence,
  });
}

// ---------------------------------------------------------------------------
describe("the unique-name rule and a contact on a filed audit (BACKLOG-2666)", () => {
  beforeEach(() => {
    mockDb = new RealDatabase(":memory:");
    mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  /**
   * One person, in the Mac address book (imported, linked) and in Outlook (not
   * linked). Exactly the shape the rule fires on: two holders, cross-family, no
   * generational suffix.
   */
  function seedFrozenPair(): void {
    addContact("c-frozen", FROZEN_NAME);
    seedOwnValues("c-frozen", MAC_EMAIL, MAC_PHONE);
    addExternal("mac-1", FROZEN_NAME, "macos", [MAC_EMAIL], [MAC_PHONE]);
    addExternal("out-1", FROZEN_NAME, "outlook", [OUT_EMAIL], [OUT_PHONE]);
    createLink({
      userId: USER,
      contactId: "c-frozen",
      sourceType: "macos",
      sourceRecordId: "mac-1",
      matchMethod: "source_id",
    });
    freezeContact("c-frozen", "t-exported");
  }

  /** The same shape, with NO exported transaction. The rule must still fire. */
  function seedUnfrozenPair(): void {
    addContact("c-open", UNFROZEN_NAME);
    seedOwnValues("c-open", "priya@example.com", "+15035550120");
    addExternal("mac-2", UNFROZEN_NAME, "macos", ["priya@example.com"], ["+15035550120"]);
    addExternal("out-2", UNFROZEN_NAME, "outlook", [TWIN_OUT_EMAIL], [TWIN_OUT_PHONE]);
    createLink({
      userId: USER,
      contactId: "c-open",
      sourceType: "macos",
      sourceRecordId: "mac-2",
      matchMethod: "source_id",
    });
  }

  // -------------------------------------------------------------------------
  // CONTROL 1 — the defect itself, in two independent halves
  // -------------------------------------------------------------------------
  /**
   * THE TWO HALVES ARE TWO TESTS, NOT TWO ASSERTIONS IN ONE.
   *
   * Written as one test first, and the control exposed it: jest abandons a test
   * at its first failed expectation, so with the link assertion at the top the
   * VALUE assertions were never reached and the run proved nothing about them.
   * That is the BACKLOG-2664 failure in miniature — there, a link assertion
   * passed while the values arrived anyway.
   *
   * CONTROL (break -> observed): disable the `isContactOnFrozenTransaction`
   * branch in `runUniqueNameAutoLink`'s `auto_link` case. BOTH of the next two
   * tests go red, each on its own subject.
   */
  it("creates NO link onto a contact on an exported audit", () => {
    seedFrozenPair();

    const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(summary.actions).toEqual([]);
    expect(summary.barredByFreeze).toBe(1);
    expect(linkSet("c-frozen")).toEqual(["macos|mac-1|source_id"]);
  });

  /**
   * No link assertion in here AT ALL, deliberately: this test must be able to
   * fail on the values alone.
   */
  it("copies NO value onto a contact on an exported audit", () => {
    seedFrozenPair();

    runUniqueNameAutoLink(USER, fileNameQuestion);

    // Exact sets. The Outlook record's number differs from the one she already
    // has in the FINAL DIGIT ONLY, so a length check would not separate them.
    expect(phoneSet("c-frozen")).toEqual([MAC_PHONE]);
    expect(emailSet("c-frozen")).toEqual([MAC_EMAIL]);
  });

  it("files the question instead of going quiet, with the frozen reason", () => {
    seedFrozenPair();

    const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(summary.askPairs).toEqual([
      {
        contactId: "c-frozen",
        sourceType: "outlook",
        sourceRecordId: "out-1",
        reason: "frozen_audit_contact",
        holderCount: 2,
        displayName: FROZEN_NAME,
      },
    ]);
    expect(proposalSet()).toEqual(["c-frozen|outlook|out-1|frozen_audit_contact"]);
  });

  /**
   * The sentence the user actually reads. `frozen_audit_contact` has an explicit
   * case in BOTH switches in `contactLinkEvidence` — each has a `default:`, so a
   * reason reaching this queue by a NEW route with no case would render the
   * generic "This match was not applied automatically." with every other check
   * still green.
   *
   * CONTROL (break -> observed): comment out the `case "frozen_audit_contact":`
   * arm of `summaryForReason` and this goes red on the summary text.
   */
  it("renders the frozen sentence, not the generic fallback", () => {
    seedFrozenPair();
    runUniqueNameAutoLink(USER, fileNameQuestion);

    const [proposal] = listPendingProposals(USER);
    const evidence = JSON.parse(proposal.evidence_json ?? "{}") as { summary?: string };

    expect(evidence.summary).toContain("audit you have already exported");
    expect(evidence.summary).not.toContain("This match was not applied automatically");
    expect(proposal.relationship_assessment).toBe("possibly_connected");
  });

  // -------------------------------------------------------------------------
  // CONTROL 2 — the positive control. A fix that just stopped linking would
  // pass everything above and break the product.
  // -------------------------------------------------------------------------
  /**
   * CONTROL (break -> observed): delete the `applyLinkedSourceValues(userId,
   * contactId)` call in the `auto_link` case. The link half stays green and the
   * VALUE half goes red — so this test is load-bearing on the copy, not just on
   * the link. That mutation is the one BACKLOG-2664 needed and did not have: a
   * positive control nobody has broken defends nothing.
   */
  it("still links AND still copies when the contact is not on an exported audit", () => {
    seedUnfrozenPair();

    const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(summary.actions).toEqual([
      { sourceType: "outlook", sourceRecordId: "out-2", contactId: "c-open" },
    ]);
    expect(summary.barredByFreeze).toBe(0);
    expect(linkSet("c-open")).toEqual(["macos|mac-2|source_id", "outlook|out-2|unique_name"]);

    // The Outlook record's values ARRIVED.
    expect(phoneSet("c-open")).toEqual(["+15035550120", TWIN_OUT_PHONE].sort());
    expect(emailSet("c-open")).toEqual(["priya@example.com", TWIN_OUT_EMAIL].sort());

    // And no question was filed — the rule acted, so there is nothing to ask.
    expect(proposalSet()).toEqual([]);
  });

  /**
   * Both fixtures in one pass, because the gate has to discriminate rather than
   * switch the whole rule off. Same linker, same sweep, opposite outcomes — the
   * Dana/Priya control from BACKLOG-2664, applied to this route.
   */
  it("discriminates: the frozen contact is refused and the open one is linked, in ONE pass", () => {
    seedFrozenPair();
    seedUnfrozenPair();

    const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(summary.actions).toEqual([
      { sourceType: "outlook", sourceRecordId: "out-2", contactId: "c-open" },
    ]);
    expect(linkSet("c-frozen")).toEqual(["macos|mac-1|source_id"]);
    expect(linkSet("c-open")).toEqual(["macos|mac-2|source_id", "outlook|out-2|unique_name"]);
    expect(phoneSet("c-frozen")).toEqual([MAC_PHONE]);
    expect(phoneSet("c-open")).toEqual(["+15035550120", TWIN_OUT_PHONE].sort());
    expect(proposalSet()).toEqual(["c-frozen|outlook|out-1|frozen_audit_contact"]);
  });

  // -------------------------------------------------------------------------
  // CONTROL 3 — the existing guard must not regress, and it must WIN
  // -------------------------------------------------------------------------
  /**
   * A pair the user has already called "different people" produces NO link and
   * NO question — not even a frozen one. The freeze check sits AFTER
   * `hasCannotLink` for exactly this reason: a decided pair coming back as a
   * question is the queue re-asking something already answered.
   *
   * CONTROL (break -> observed): move the freeze branch ABOVE the
   * `hasCannotLink` check and this goes red — `barredByVerdict` reads 0,
   * `barredByFreeze` reads 1 and a proposal appears.
   */
  it("honours a prior 'different people' answer over the freeze, and asks nothing", () => {
    seedFrozenPair();
    recordVerdict({
      userId: USER,
      contactId: "c-frozen",
      sourceType: "outlook",
      sourceRecordId: "out-1",
      identityVerdict: "different_people",
      decidedBy: "review_queue",
    });

    const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(summary.barredByVerdict).toBe(1);
    expect(summary.barredByFreeze).toBe(0);
    expect(summary.askPairs).toEqual([]);
    expect(proposalSet()).toEqual([]);
    expect(linkSet("c-frozen")).toEqual(["macos|mac-1|source_id"]);
    expect(phoneSet("c-frozen")).toEqual([MAC_PHONE]);
  });

  // -------------------------------------------------------------------------
  // CONTROL 4 — convergence. This pass runs on EVERY sync.
  // -------------------------------------------------------------------------
  /**
   * The refusal is permanent — the rule can never link her, so it reaches this
   * branch again on every single sync. `proposeLink`'s `INSERT OR IGNORE`
   * against the proposals UNIQUE is the only thing between that and one new
   * question per sync forever, so it is pinned at the DATABASE rather than at
   * the summary.
   *
   * CONTROL (break -> observed): drop the UNIQUE from
   * `CONTACT_LINK_PROPOSALS_TABLE_SQL` and the second pass files a duplicate
   * row, turning the exact set into two entries.
   */
  it("converges — a second and third pass file no new question and copy nothing", () => {
    seedFrozenPair();

    runUniqueNameAutoLink(USER, fileNameQuestion);
    const second = runUniqueNameAutoLink(USER, fileNameQuestion);
    runUniqueNameAutoLink(USER, fileNameQuestion);

    expect(second.barredByFreeze).toBe(1);
    expect(proposalSet()).toEqual(["c-frozen|outlook|out-1|frozen_audit_contact"]);
    expect(linkSet("c-frozen")).toEqual(["macos|mac-1|source_id"]);
    expect(phoneSet("c-frozen")).toEqual([MAC_PHONE]);
    expect(emailSet("c-frozen")).toEqual([MAC_EMAIL]);
  });
});
