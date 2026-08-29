/**
 * @jest-environment node
 *
 * BACKLOG-2630 D2 piece 2 — the evidence GATHERER.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS ALLOWED TO ASSERT
 * ---------------------------------------------------------------------------
 * Facts, and never a verdict. There is no assertion below of the form "these two
 * are the same person", because the module under test cannot produce one. What
 * is asserted is that the right FACTS are reported, as EXACT SETS, and that the
 * two branches the founder ruled must stay apart (2026-08-02, BACKLOG-2273)
 * cannot be added together.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(sharedKeys).toHaveLength(1)` is equally satisfied by sharing the WRONG
 * key. Every assertion names the exact strings it expects, and every expected
 * key is DERIVED FROM THE LIVE RULE (`toMatchingKey` / `emailProbeKeys`) rather
 * than transcribed, so a corpus cannot silently regress to coincidence.
 *
 * ---------------------------------------------------------------------------
 * PII
 * ---------------------------------------------------------------------------
 * Every value is synthetic. Emails are on `example.invalid` (RFC 6761 reserved,
 * unresolvable). Phone numbers use 555-01xx inside a valid assignable area code,
 * which is both parseable by libphonenumber and reserved-fictional.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "./helpers/contactCommunicationSchema";

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

import * as evidenceModule from "../contactIdentityEvidence";
import { gatherIdentityEvidence, type EvidenceEndpoint } from "../contactIdentityEvidence";
import { recordVerdict } from "../db/contactLinkReviewDbService";
import { createLink } from "../db/contactSourceLinkDbService";
import { toLookupKey, toMatchingKey } from "../../utils/phoneNormalization";

const USER = "user-2630-d2b";

// ---------------------------------------------------------------------------
// SEEDS — the same shapes the production writers emit
// ---------------------------------------------------------------------------

function addContact(
  id: string,
  displayName: string,
  opts: { emails?: string[]; phones?: string[]; removedAt?: string } = {},
): EvidenceEndpoint {
  mockDb!
    .prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, removed_at) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, USER, displayName, opts.removedAt ?? null);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)")
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    // `phone_normalized` is written by `toLookupKey`, exactly as production does
    // — the gatherer keys the contact side from `phone_e164` through
    // `toMatchingKey`, and a fixture that pre-floored the stored column would
    // describe a state no writer can produce.
    mockDb!
      .prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`${id}-p${i}`, id, p, toLookupKey(p), i === 0 ? 1 : 0);
  });
  return { kind: "contact", contactId: id };
}

function addExternal(
  recordId: string,
  name: string | null,
  opts: { emails?: string[]; phones?: string[]; source?: string } = {},
): EvidenceEndpoint {
  const phones = opts.phones ?? [];
  const source = opts.source ?? "macos";
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(toLookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      source,
      "2026-08-27T00:00:00.000Z",
    );
  return {
    kind: "record",
    sourceType: source as "macos",
    sourceRecordId: recordId,
  };
}

function addTransaction(id: string, address: string, contactIds: string[]): void {
  mockDb!
    .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)")
    .run(id, USER, address);
  contactIds.forEach((cid, i) => {
    mockDb!
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run(`${id}-tc${i}`, id, cid, i === 0 ? "buyer" : "seller");
  });
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  // `emails` / `email_participants` — the tables contactRecencySql reads, from
  // the helper that already owns them. `phone_last_message` has no shared owner
  // yet, so it is declared here from schema.sql:1488-1494.
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
  mockDb.exec(`
    CREATE TABLE IF NOT EXISTS phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );
  `);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. THE DIGIT FLOOR — SWEPT AT 6, 7 AND 8, NOT SAMPLED
// ===========================================================================
/**
 * One input per branch cannot catch an off-by-one, so the boundary is walked
 * from both sides. 7 is the shipped floor (`MATCHING_DIGIT_FLOOR`, slice 1).
 *
 * CONTROLS RUN (see the PR body for the observed red counts):
 *  - floor 7 -> 6: the six-digit case starts sharing a key.
 *  - `digitCount < FLOOR` -> `<=`: the seven-digit case stops sharing one.
 * Both are needed; either alone leaves one side of the boundary unproven.
 */
describe("the phone digit floor decides which values may be evidence", () => {
  const CASES = [
    { digits: 6, value: "555010" },
    { digits: 7, value: "5550109" },
    { digits: 8, value: "15550109" },
  ];

  for (const { digits, value } of CASES) {
    it(`${digits} digits: the shared-key set is exactly what the live rule emits`, () => {
      const contact = addContact(`c-floor-${digits}`, "Pat Riverton", { phones: [value] });
      const record = addExternal(`rec-floor-${digits}`, "Pat Riverton", { phones: [value] });

      const facts = gatherIdentityEvidence({
        userId: USER,
        subject: contact,
        candidate: record,
      });

      // Derived from the live rule, never transcribed.
      const key = toMatchingKey(value);
      const expected = key ? [key] : [];

      expect(facts.identity.phones.subjectKeys).toEqual(expected);
      expect(facts.identity.phones.candidateKeys).toEqual(expected);
      expect(facts.identity.phones.sharedKeys).toEqual(expected);
    });
  }

  it("a below-floor value is reported as HELD BUT UNUSABLE, not as absent", () => {
    const contact = addContact("c-ext", "Pat Riverton", { phones: ["555010"] });
    const record = addExternal("rec-ext", "Pat Riverton", { phones: ["555010"] });

    const facts = gatherIdentityEvidence({ userId: USER, subject: contact, candidate: record });

    expect(facts.identity.phones.sharedKeys).toEqual([]);
    // The number is still on file on both sides. "No key" is not "no number" —
    // BACKLOG-2754's whole point.
    expect(facts.identity.phones.subjectUnkeyableCount).toBe(1);
    expect(facts.identity.phones.candidateUnkeyableCount).toBe(1);
  });

  it("the boundary is exactly 7: six shares nothing, seven shares its key", () => {
    const six = toMatchingKey("555010");
    const seven = toMatchingKey("5550109");
    expect(six).toBe("");
    expect(seven).not.toBe("");
  });
});

// ===========================================================================
// 2. THE WHITFIELD CONTROL — A SHARED EMAIL AND A DISAGREEING NAME ARE TWO FACTS
// ===========================================================================
/**
 * BACKLOG-2674's negative control, restated with synthetic values: several
 * records share one household address, and so does someone with a DIFFERENT
 * first name. A grouping key built on the email alone swallows the odd one out.
 *
 * The gatherer must report the shared address AND the name disagreement as
 * SEPARATE facts, and must group nothing.
 *
 * CONTROL RUN: collapse the name fact into the identifier group (report only
 * `sharedKeys`). See the PR body for the red test names.
 */
describe("a shared address and a disagreeing name are reported separately", () => {
  it("reports the shared email key AND the differing name keys, and groups nothing", () => {
    const household = "household@example.invalid";
    const sarah = addContact("c-sarah", "Chris Alvarez", { emails: [household] });
    const tom = addExternal("rec-tom", "Dana Alvarez", { emails: [household] });

    const facts = gatherIdentityEvidence({ userId: USER, subject: sarah, candidate: tom });

    // Fact one: they share an address. Exactly one, and it is that one.
    expect(facts.identity.emails.sharedKeys).toEqual([household]);

    // Fact two, INDEPENDENT of fact one: the names do not agree.
    expect(facts.identity.name.subject.normalizedKey).toBe("chris alvarez");
    expect(facts.identity.name.candidate.normalizedKey).toBe("dana alvarez");
    expect(facts.identity.name.normalizedKeysEqual).toBe(false);

    // And nothing anywhere says they are the same person.
    expect(Object.keys(facts.identity).sort()).toEqual(["crosswalk", "emails", "name", "phones"]);
  });

  it("a missing name on one side is not an agreement", () => {
    const shared = "shared@example.invalid";
    const named = addContact("c-named", "Pat Riverton", { emails: [shared] });
    const nameless = addExternal("rec-nameless", null, { emails: [shared] });

    const facts = gatherIdentityEvidence({ userId: USER, subject: named, candidate: nameless });

    expect(facts.identity.emails.sharedKeys).toEqual([shared]);
    expect(facts.identity.name.candidate.raw).toBeNull();
    expect(facts.identity.name.candidate.normalizedKey).toBeNull();
    // BACKLOG-2624: absence of evidence is not evidence of a match.
    expect(facts.identity.name.normalizedKeysEqual).toBe(false);
  });

  it("a machine sentinel is not a name", () => {
    const shared = "sentinel@example.invalid";
    const a = addContact("c-unknown-a", "Unknown", { emails: [shared] });
    const b = addExternal("rec-unknown-b", "Unknown", { emails: [shared] });

    const facts = gatherIdentityEvidence({ userId: USER, subject: a, candidate: b });

    // The column holds it, so `raw` reports it — but `real` does not, and no key
    // is derived from it. Two records both labelled "Unknown" must not read as a
    // name match.
    expect(facts.identity.name.subject.raw).toBe("Unknown");
    expect(facts.identity.name.subject.real).toBeNull();
    expect(facts.identity.name.subject.normalizedKey).toBeNull();
    expect(facts.identity.name.normalizedKeysEqual).toBe(false);
  });
});

// ===========================================================================
// 3. SUFFIXES ARE NOT STRIPPED
// ===========================================================================
/**
 * `contactNameAutoLink`'s rule, reported rather than re-derived: normalisation
 * that removes a generational suffix makes a father and a son identical.
 *
 * CONTROL RUN: strip the last token when it is in `GENERATIONAL_SUFFIXES`.
 */
describe("a generational suffix survives normalisation", () => {
  it("father and son do not normalise to the same key, and the flag is set", () => {
    const father = addContact("c-father", "John Smith Sr");
    const son = addExternal("rec-son", "John Smith Jr");

    const facts = gatherIdentityEvidence({ userId: USER, subject: father, candidate: son });

    expect(facts.identity.name.subject.normalizedKey).toBe("john smith sr");
    expect(facts.identity.name.candidate.normalizedKey).toBe("john smith jr");
    expect(facts.identity.name.normalizedKeysEqual).toBe(false);
    expect(facts.identity.name.subject.hasGenerationalSuffix).toBe(true);
    expect(facts.identity.name.candidate.hasGenerationalSuffix).toBe(true);
  });

  it("two spellings of one name DO agree — accents and punctuation only", () => {
    const a = addContact("c-accent", "Renée O'Hare");
    const b = addExternal("rec-accent", "Renee OHare");

    const facts = gatherIdentityEvidence({ userId: USER, subject: a, candidate: b });

    expect(facts.identity.name.subject.normalizedKey).toBe("renee ohare");
    expect(facts.identity.name.normalizedKeysEqual).toBe(true);
    // Still a FACT, not a verdict: the bundle says the keys are equal and stops.
    expect(facts.identity.name.subject.hasGenerationalSuffix).toBe(false);
  });
});

// ===========================================================================
// 4. BUYER AND SELLER — RELATIONSHIP FACTS WITHOUT IDENTITY FACTS
// ===========================================================================
/**
 * The founder's 2026-08-02 ruling, made structural: contextual signals are
 * evidence of a RELATIONSHIP, and identity is a much stronger claim. Two people
 * on one deal max out the contextual signals and share no identifier.
 *
 * The second assertion is the load-bearing one: there is NO EXPORTED FUNCTION
 * that takes both branches. The absence is the enforcement.
 */
describe("two people on one deal are connected, not the same person", () => {
  it("populates relationship facts while every identity fact stays empty", () => {
    const buyer = addContact("c-buyer", "Pat Riverton", { emails: ["ada@example.invalid"] });
    const seller = addContact("c-seller", "Robin Marsh", { emails: ["bram@example.invalid"] });
    addTransaction("t-1", "12 Cedar Lane", ["c-buyer", "c-seller"]);

    const facts = gatherIdentityEvidence({ userId: USER, subject: buyer, candidate: seller });

    expect(facts.pairKind).toBe("contact_contact");
    expect(facts.relationship.shareTransaction).toBe(true);
    expect(facts.relationship.sharedTransactionAddressCount).toBe(1);

    expect(facts.identity.emails.sharedKeys).toEqual([]);
    expect(facts.identity.phones.sharedKeys).toEqual([]);
    expect(facts.identity.name.normalizedKeysEqual).toBe(false);
  });

  it("exports no helper that can add the two branches together", () => {
    // An EXACT export set. Adding a scoring, summing or verdict helper reds this
    // test, which is the entire mechanism protecting the ruling.
    expect(Object.keys(evidenceModule).sort()).toEqual([
      "IDENTITY_EVIDENCE_SCHEMA_VERSION",
      "gatherIdentityEvidence",
      "pairKindFor",
      "tryGatherIdentityEvidence",
    ]);
  });

  it("cannot be asked about a transaction when either side is a record", () => {
    const contact = addContact("c-solo", "Pat Riverton");
    const record = addExternal("rec-solo", "Pat Riverton");

    const facts = gatherIdentityEvidence({ userId: USER, subject: contact, candidate: record });

    // NULL is "cannot be asked", not "no". The transaction graph is
    // contact-keyed, so a record has no position in it at all.
    expect(facts.relationship.shareTransaction).toBeNull();
    expect(facts.relationship.sharedTransactionAddressCount).toBeNull();
  });
});

// ===========================================================================
// 5. ELIGIBILITY — TOMBSTONED EITHER SIDE, ONE PREDICATE, NO REDIRECT
// ===========================================================================
describe("a removed contact is reported as removed, and nothing is substituted", () => {
  it("reports the tombstone on whichever side carries it", () => {
    const removed = addContact("c-removed", "Pat Riverton", {
      removedAt: "2026-08-01T00:00:00.000Z",
    });
    const live = addExternal("rec-live", "Pat Riverton");

    const facts = gatherIdentityEvidence({ userId: USER, subject: removed, candidate: live });

    expect(facts.eligibility.subjectRemoved).toBe(true);
    expect(facts.eligibility.candidateRemoved).toBe(false);
    expect(facts.eligibility.subjectExists).toBe(true);
  });

  it("an endpoint that does not exist is reported as absent, not as empty", () => {
    const real = addContact("c-real", "Pat Riverton");
    const ghost: EvidenceEndpoint = { kind: "record", sourceType: "macos", sourceRecordId: "nope" };

    const facts = gatherIdentityEvidence({ userId: USER, subject: real, candidate: ghost });

    expect(facts.eligibility.subjectExists).toBe(true);
    expect(facts.eligibility.candidateExists).toBe(false);
  });
});

// ===========================================================================
// 6. ALL THREE PAIR SHAPES, AND WHAT PRIOR ANSWERS CAN BE READ FOR
// ===========================================================================
describe("the gatherer serves all three pair shapes the schema can hold", () => {
  it("names each shape from its endpoints", () => {
    const contactA = addContact("c-a", "Pat Riverton");
    const contactB = addContact("c-b", "Robin Marsh");
    const recordA = addExternal("rec-a", "Pat Riverton");
    const recordB = addExternal("rec-b", "Robin Marsh");

    expect(
      gatherIdentityEvidence({ userId: USER, subject: contactA, candidate: recordA }).pairKind,
    ).toBe("record_contact");
    // Order-independent: the shape is a property of the endpoints, not of which
    // one was named first.
    expect(
      gatherIdentityEvidence({ userId: USER, subject: recordA, candidate: contactA }).pairKind,
    ).toBe("record_contact");
    expect(
      gatherIdentityEvidence({ userId: USER, subject: recordA, candidate: recordB }).pairKind,
    ).toBe("record_record");
    expect(
      gatherIdentityEvidence({ userId: USER, subject: contactA, candidate: contactB }).pairKind,
    ).toBe("contact_contact");
  });

  it("reads a prior answer for the one shape whose readers exist", () => {
    const contact = addContact("c-answered", "Pat Riverton");
    addExternal("rec-answered", "Pat Riverton");
    recordVerdict({
      userId: USER,
      contactId: "c-answered",
      sourceType: "macos",
      sourceRecordId: "rec-answered",
      identityVerdict: "different_people",
      decidedBy: "review_queue",
    });

    const facts = gatherIdentityEvidence({
      userId: USER,
      subject: contact,
      candidate: { kind: "record", sourceType: "macos", sourceRecordId: "rec-answered" },
    });

    expect(facts.priorAnswers.readable).toBe(true);
    expect(facts.priorAnswers.latestIdentityVerdict).toBe("different_people");
    expect(facts.priorAnswers.hasCannotLink).toBe(true);
    expect(facts.priorAnswers.hasMustLink).toBe(false);
  });

  it("says NOBODY CAN LOOK for the two shapes with no pair-keyed reader", () => {
    const contactA = addContact("c-x", "Pat Riverton");
    const contactB = addContact("c-y", "Robin Marsh");
    const recordA = addExternal("rec-x", "Pat Riverton");
    const recordB = addExternal("rec-y", "Robin Marsh");

    for (const pair of [
      { subject: contactA, candidate: contactB },
      { subject: recordA, candidate: recordB },
    ]) {
      const facts = gatherIdentityEvidence({ userId: USER, ...pair });
      // `readable: false` is the honest report. Saying `latestIdentityVerdict:
      // null` alone would read as "nobody has answered", which is a different
      // claim and the one that would mislead D3. The unordered pair readers are
      // plan §4 — piece 3.
      expect(facts.priorAnswers.readable).toBe(false);
      expect(facts.priorAnswers.latestIdentityVerdict).toBeNull();
      expect(facts.priorAnswers.hasCannotLink).toBe(false);
    }
  });

  it("reports the contact that already owns a record", () => {
    const contact = addContact("c-owner", "Pat Riverton");
    addExternal("rec-owned", "Pat Riverton");
    createLink({
      userId: USER,
      contactId: "c-owner",
      sourceType: "macos",
      sourceRecordId: "rec-owned",
      matchMethod: "source_id",
    });

    const facts = gatherIdentityEvidence({
      userId: USER,
      subject: contact,
      candidate: { kind: "record", sourceType: "macos", sourceRecordId: "rec-owned" },
    });

    expect(facts.identity.crosswalk.candidateOwnerContactId).toBe("c-owner");
    expect(facts.identity.crosswalk.subjectOwnerContactId).toBeNull();
  });
});

// ===========================================================================
// 7. THE NAME TALLY IS NEVER INVENTED
// ===========================================================================
describe("the name holder count is the caller's, or it is null", () => {
  it("is null when the caller has no tally — null is NOT zero", () => {
    const contact = addContact("c-tally-a", "Pat Riverton");
    const record = addExternal("rec-tally-a", "Pat Riverton");

    const facts = gatherIdentityEvidence({ userId: USER, subject: contact, candidate: record });

    expect(facts.identity.name.holderCount).toBeNull();
  });

  it("is exactly what the caller passed when the name pass already tallied it", () => {
    const contact = addContact("c-tally-b", "Pat Riverton");
    const record = addExternal("rec-tally-b", "Pat Riverton");

    const facts = gatherIdentityEvidence({
      userId: USER,
      subject: contact,
      candidate: record,
      nameHolderCount: 2,
    });

    expect(facts.identity.name.holderCount).toBe(2);
  });
});

// ===========================================================================
// 8. THE BUNDLE'S OWN SHAPE
// ===========================================================================
describe("the bundle keeps identity and relationship in separate branches", () => {
  it("carries exactly the four fact groups plus its own provenance", () => {
    const contact = addContact("c-shape", "Pat Riverton");
    const record = addExternal("rec-shape", "Pat Riverton");

    const facts = gatherIdentityEvidence({ userId: USER, subject: contact, candidate: record });

    expect(Object.keys(facts).sort()).toEqual([
      "eligibility",
      "gatheredAt",
      "identity",
      "pairKind",
      "priorAnswers",
      "relationship",
      "schemaVersion",
    ]);
    expect(facts.schemaVersion).toBe(1);
    expect(Date.parse(facts.gatheredAt)).not.toBeNaN();
  });

  it("survives a corrupt identifier blob without losing the rest of the facts", () => {
    const contact = addContact("c-corrupt", "Pat Riverton");
    mockDb!
      .prepare(
        `INSERT INTO external_contacts
          (id, user_id, name, phones_json, phones_normalized_json, emails_json,
           external_record_id, source, synced_at, external_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        "ext-macos-rec-corrupt",
        USER,
        "Pat Riverton",
        "{not json",
        "[]",
        "{also not json",
        "rec-corrupt",
        "macos",
        "2026-08-27T00:00:00.000Z",
      );

    const facts = gatherIdentityEvidence({
      userId: USER,
      subject: contact,
      candidate: { kind: "record", sourceType: "macos", sourceRecordId: "rec-corrupt" },
    });

    // A corrupt blob is MISSING evidence, not a reason to lose the name fact.
    expect(facts.identity.emails.candidateKeys).toEqual([]);
    expect(facts.identity.name.candidate.normalizedKey).toBe("pat riverton");
    expect(facts.eligibility.candidateExists).toBe(true);
  });
});
