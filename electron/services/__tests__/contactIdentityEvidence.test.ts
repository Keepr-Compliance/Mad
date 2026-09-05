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
// BACKLOG-3104: the two readers of `CONTACTS_SHARE_TRANSACTION_SQL` and
// `SHARED_TRANSACTION_ADDRESSES_SQL`. The gatherer already calls both — it
// reports `shareTransaction`, and a COUNT of shared addresses — so section 9
// reads them directly to assert the exact PAIRS and the exact ADDRESSES that a
// count cannot tell apart from a wrong answer of the same size.
import { contactsShareTransaction, sharedTransactionAddresses } from "../contactLinkEvidence";

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

// ---------------------------------------------------------------------------
// BACKLOG-3104 — THE OTHER FIVE PLACEMENTS, IN THE SHAPES PRODUCTION WRITES
// ---------------------------------------------------------------------------

/** The four direct role columns a contact can occupy on a transaction. */
type RoleColumn = "buyer_agent_id" | "seller_agent_id" | "escrow_officer_id" | "inspector_id";

/**
 * One literal `UPDATE` per column rather than a column name spliced into a
 * string. `TRANSACTION_COLUMN_POLICY` marks all four `insert: "db-default"`,
 * `update: "writable"` (`db/transactionDbService.ts:374-393`), so an UPDATE
 * after creation is the path production actually takes to set them — and the
 * value is a bare contact id, which is what
 * `getTransactionsByContact`'s direct-FK query compares each column against
 * (`db/contactDbService.ts:1658-1680`).
 */
const ROLE_COLUMN_UPDATE: Record<RoleColumn, string> = {
  buyer_agent_id: "UPDATE transactions SET buyer_agent_id = ? WHERE id = ?",
  seller_agent_id: "UPDATE transactions SET seller_agent_id = ? WHERE id = ?",
  escrow_officer_id: "UPDATE transactions SET escrow_officer_id = ? WHERE id = ?",
  inspector_id: "UPDATE transactions SET inspector_id = ? WHERE id = ?",
};

function placeInRoleColumn(transactionId: string, column: RoleColumn, contactId: string): void {
  const res = mockDb!.prepare(ROLE_COLUMN_UPDATE[column]).run(contactId, transactionId);
  // A placement that silently hit no row would make the case that depends on it
  // green for the wrong reason — the branch would look covered while nothing was
  // ever on the deal.
  expect(res.changes).toBe(1);
}

/**
 * The `other_contacts` array, written the way `bindValue` writes it:
 * `TRANSACTION_COLUMN_POLICY.other_contacts` carries `json: true`, and
 * `bindValue` turns any object into `JSON.stringify(value)`
 * (`db/transactionDbService.ts:484-485`). So the stored text is a JSON array of
 * bare contact ids — the shape `json_each(t.other_contacts) j WHERE j.value = ?`
 * reads back in `getTransactionsByContact` (`db/contactDbService.ts:1771`).
 */
function placeInOtherContacts(transactionId: string, contactIds: string[]): void {
  const res = mockDb!
    .prepare("UPDATE transactions SET other_contacts = ? WHERE id = ?")
    .run(JSON.stringify(contactIds), transactionId);
  expect(res.changes).toBe(1);
}

/** A canonical key for an unordered pair, so the order ids were seeded in cannot matter. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/**
 * Every unordered pair among `contactIds` that the predicate reports as sharing
 * a deal, sorted.
 *
 * This exists so the cases below can assert an EXACT SET. `expect(...).toBe(true)`
 * on one pair is equally satisfied by a predicate that says yes to EVERY pair,
 * and `toHaveLength(1)` is equally satisfied by the wrong pair. Enumerating every
 * pair and naming the survivors distinguishes both.
 */
function sharingPairs(contactIds: string[]): string[] {
  const ids = [...contactIds].sort();
  const pairs: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (contactsShareTransaction(ids[i], ids[j])) pairs.push(pairKey(ids[i], ids[j]));
    }
  }
  return pairs.sort();
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

// ===========================================================================
// 9. ALL SIX WAYS A CONTACT REACHES A DEAL — BACKLOG-3104
// ===========================================================================
/**
 * `CONTACTS_SHARE_TRANSACTION_SQL` (`db/contactLinkEvidenceSql.ts:104`) asks
 * whether two contacts appear on one transaction, and its `onTransactionFor`
 * fragment answers yes down SIX independent branches: the four direct role
 * columns, a `transaction_contacts` row, and a `json_each` membership test over
 * the `other_contacts` array. Section 4 above exercised exactly ONE of them.
 *
 * That was measured, not assumed. Each branch was neutralised to `1 = 0` in
 * turn: five were completely SILENT, and only `transaction_contacts` reddened
 * anything — "populates relationship facts while every identity fact stays
 * empty". Five sixths of the predicate could have been deleted with the suite
 * still green at 23/23.
 *
 * ---------------------------------------------------------------------------
 * BOTH DIRECTIONS, AND WHICH ONE IS THE IRREVERSIBLE ONE
 * ---------------------------------------------------------------------------
 * Two contacts on one deal is an ANTI-merge signal: you do not put one human on
 * a deal twice, so appearing together is evidence they are DIFFERENT PEOPLE
 * (BACKLOG-2366, and the reason this predicate deliberately ignores
 * `removed_at`).
 *
 * UNDER-reporting — a branch that stops matching — loses that signal quietly and
 * prints a sentence naming a deal the contact is not on. OVER-reporting is the
 * dangerous one: a predicate that reports a shared deal where there is none
 * FABRICATES the anti-merge signal, and a fabricated anti-merge signal is what
 * a wrong merge looks like from the other side. The five positive cases guard
 * the first direction. The negative case guards the second, and it is the only
 * test here that reds when the predicate is LOOSENED rather than narrowed.
 *
 * ---------------------------------------------------------------------------
 * EXACT PAIRS, NEVER COUNTS — AND WHY EVERY CASE SEEDS A DECOY
 * ---------------------------------------------------------------------------
 * `sharingPairs` enumerates every unordered pair among the seeded contacts that
 * the predicate reports as sharing a deal. Every case seeds a THIRD contact on a
 * DIFFERENT deal, so "exactly one pair" is a claim over three candidate pairs
 * rather than a vacuous claim over one — and any over-link that drags the decoy
 * in reds the case on the spot. The shared deal is then named by ADDRESS, not
 * counted: `sharedTransactionAddressCount` is a number, and a number cannot tell
 * the right deal from a different one of the same quantity.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE TRANSCRIBED
 * ---------------------------------------------------------------------------
 * See `placeInRoleColumn` and `placeInOtherContacts` above: the role columns take
 * a bare contact id by way of an UPDATE, which is the only path the column policy
 * allows, and `other_contacts` takes `JSON.stringify` of an array of bare contact
 * ids, which is literally what `bindValue` emits. Each placement asserts it
 * changed a row, so a fixture that quietly hit nothing cannot leave a case green.
 */

describe("all four direct role columns put a contact on a deal", () => {
  const ROLE_CASES: { column: RoleColumn; slug: string; address: string }[] = [
    { column: "buyer_agent_id", slug: "buyer", address: "14 Aspen Court" },
    { column: "seller_agent_id", slug: "seller", address: "27 Birch Row" },
    { column: "escrow_officer_id", slug: "escrow", address: "41 Juniper Way" },
    { column: "inspector_id", slug: "inspector", address: "58 Larch Close" },
  ];

  for (const { column, slug, address } of ROLE_CASES) {
    it(`${column}: exactly the pair on that deal shares it, named by address`, () => {
      const columnId = `c-3104-${slug}-column`;
      const junctionId = `c-3104-${slug}-junction`;
      const decoyId = `c-3104-${slug}-decoy`;

      const subject = addContact(columnId, "Pat Riverton");
      const candidate = addContact(junctionId, "Robin Marsh");
      addContact(decoyId, "Chris Alvarez");

      // The deal: one side sits in the role COLUMN under test, the other on the
      // junction. The column is that side's ONLY route onto the transaction, so
      // the case goes red the moment this branch stops matching.
      addTransaction(`t-3104-${slug}`, address, [junctionId]);
      placeInRoleColumn(`t-3104-${slug}`, column, columnId);
      // A second deal, so the decoy is a contact with deals of its own rather
      // than a contact with none — an over-link has something to grab.
      addTransaction(`t-3104-${slug}-elsewhere`, "9 Sycamore Bend", [decoyId]);

      // The EXACT set, out of the three pairs three contacts can form.
      expect(sharingPairs([columnId, junctionId, decoyId])).toEqual([
        pairKey(columnId, junctionId),
      ]);

      // And the gatherer — the real consumer, and the only one section 4 probes
      // — reports it as a relationship fact.
      const facts = gatherIdentityEvidence({ userId: USER, subject, candidate });
      expect(facts.relationship.shareTransaction).toBe(true);

      // WHICH deal, not how many.
      expect(sharedTransactionAddresses(columnId, junctionId)).toEqual([address]);
    });
  }
});

describe("the other_contacts array puts a contact on a deal", () => {
  it("other_contacts: both sides inside the JSON array share the deal", () => {
    const aId = "c-3104-json-a";
    const bId = "c-3104-json-b";
    const decoyId = "c-3104-json-decoy";

    const subject = addContact(aId, "Pat Riverton");
    const candidate = addContact(bId, "Robin Marsh");
    addContact(decoyId, "Chris Alvarez");

    // Neither side is in a role column or on the junction. The JSON array is the
    // ONLY route onto this transaction for EITHER of them, which is what makes
    // this case a clean probe of that one branch and nothing else.
    addTransaction("t-3104-json", "63 Willow Bank", []);
    placeInOtherContacts("t-3104-json", [aId, bId]);
    addTransaction("t-3104-json-elsewhere", "9 Sycamore Bend", [decoyId]);

    expect(sharingPairs([aId, bId, decoyId])).toEqual([pairKey(aId, bId)]);

    const facts = gatherIdentityEvidence({ userId: USER, subject, candidate });
    expect(facts.relationship.shareTransaction).toBe(true);

    expect(sharedTransactionAddresses(aId, bId)).toEqual(["63 Willow Bank"]);
  });
});

describe("two contacts on different deals share nothing — the over-link guard", () => {
  it("the sharing set is EXACTLY EMPTY for a pair with no deal in common", () => {
    const soloAId = "c-3104-neg-a";
    const soloBId = "c-3104-neg-b";
    const witnessId = "c-3104-neg-witness";

    const soloA = addContact(soloAId, "Pat Riverton");
    const soloB = addContact(soloBId, "Robin Marsh");
    addContact(witnessId, "Chris Alvarez");

    // Deal one: soloA in a role column, the witness on the junction.
    addTransaction("t-3104-neg-one", "72 Hawthorn Rise", [witnessId]);
    placeInRoleColumn("t-3104-neg-one", "buyer_agent_id", soloAId);
    // Deal two, a different property: soloB alone.
    addTransaction("t-3104-neg-two", "85 Rowan Gate", []);
    placeInRoleColumn("t-3104-neg-two", "seller_agent_id", soloBId);

    // LIVENESS FIRST, and it is load-bearing. Without it the empty set below is
    // equally satisfied by a fixture that seeded nothing — green because there
    // was never anything to find, which proves nothing about the predicate.
    expect(sharingPairs([soloAId, witnessId])).toEqual([pairKey(soloAId, witnessId)]);

    // The claim: across all three, the ONLY pair sharing a deal is the pair that
    // is genuinely on one. soloA|soloB is absent, and so is soloB|witness.
    expect(sharingPairs([soloAId, soloBId, witnessId])).toEqual([
      pairKey(soloAId, witnessId),
    ]);

    // And the same answer through the gatherer, in both of the shapes it reports.
    const facts = gatherIdentityEvidence({ userId: USER, subject: soloA, candidate: soloB });
    expect(facts.relationship.shareTransaction).toBe(false);
    expect(sharedTransactionAddresses(soloAId, soloBId)).toEqual([]);
  });
});
