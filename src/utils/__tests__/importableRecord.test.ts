/**
 * BACKLOG-2672 — the predicate, swept rather than sampled.
 *
 * The two suites that drive real producers
 * (`contactDbService.nothingToImport-2672.test.ts`) and real surfaces
 * (`Contacts.nothingToImport-2672.test.tsx`,
 * `ContactAssignmentStep.nothingToImport-2672.test.tsx`) establish that this
 * function is asked the right question about the right rows. This file covers
 * the boundary: ONE input per field per state, so an off-by-one in the
 * or-chain cannot hide behind a fixture that happens to be empty in two places
 * at once.
 *
 * The founder's rule: block only when there is NO usable name AND NO phone AND
 * NO email. Every single-field row below must therefore come back IMPORTABLE.
 */

import {
  hasNothingToImport,
  importBlockedReason,
  isUnimportedSourceRecord,
  NOTHING_TO_IMPORT_REASON,
} from "../importableRecord";

describe("hasNothingToImport — the empty record", () => {
  it.each([
    ["all fields absent", {}],
    ["all fields null", { name: null, company: null, phone: null, email: null }],
    ["all fields whitespace", { name: "  ", company: "\t", phone: " ", email: "" }],
    ["empty arrays", { allPhones: [], allEmails: [] }],
    ["arrays of blanks", { allPhones: ["", "  "], allEmails: [" "] }],
    // The founder's row, and its capital-U twin from the iPhone contact writer.
    ["the message sentinel in both slots", { name: "unknown", phone: "unknown" }],
    ["the iPhone contact sentinel", { name: "Unknown", phone: null, email: null }],
    ["the second sentinel spelling", { name: "Unknown Contact" }],
    ["a sentinel with padding", { name: "  UNKNOWN  ", phone: " unknown " }],
    ["a sentinel in the arrays", { allPhones: ["unknown"], allEmails: ["unknown"] }],
  ])("blocks: %s", (_label, record) => {
    expect(hasNothingToImport(record)).toBe(true);
  });
});

describe("hasNothingToImport — ONE field is enough to import", () => {
  it.each([
    // CONTROL 2, the boundary the founder named: no name, but a number.
    ["a phone and nothing else", { phone: "+16175550147" }],
    ["a phone in the array only", { allPhones: ["+16175550147"] }],
    ["the SECOND phone in the array", { phone: null, allPhones: ["", "+16175550147"] }],
    ["an email and nothing else", { email: "marisol@example.com" }],
    ["an email in the array only", { allEmails: ["marisol@example.com"] }],
    ["a company and nothing else", { company: "Vantrees Realty" }],
    ["a name and nothing else", { name: "Marisol Vantrees" }],
    ["display_name and nothing else", { display_name: "Marisol Vantrees" }],
    // A non-numeric handle still identifies someone — an Apple ID, for one.
    ["a non-numeric handle in the phone slot", { phone: "marisol.iphone" }],
    // The sentinel is discounted, but a real value beside it is not.
    ["a sentinel name WITH a real phone", { name: "unknown", phone: "+16175550147" }],
    ["a sentinel phone WITH a real name", { name: "Marisol Vantrees", phone: "unknown" }],
    // A name that CONTAINS the sentinel is a name. The match is exact.
    ["a real name containing the word", { name: "Unknown Soldier Trust" }],
  ])("allows: %s", (_label, record) => {
    expect(hasNothingToImport(record)).toBe(false);
  });
});

describe("isUnimportedSourceRecord — both legs", () => {
  const empty = { name: "unknown", phone: "unknown" };

  it("an address-book row is one (external set membership)", () => {
    expect(isUnimportedSourceRecord(empty, true)).toBe(true);
  });

  /**
   * THE LEG THAT CATCHES THE FOUNDER'S RECORD. Message-derived pseudo-contacts
   * arrive in the SAVED half's array, so `isExternal` is FALSE for them and a
   * fix gated on it alone would miss every one.
   */
  it("a message-derived row is one even when isExternal is false", () => {
    expect(isUnimportedSourceRecord({ ...empty, is_message_derived: 1 }, false)).toBe(true);
    expect(isUnimportedSourceRecord({ ...empty, is_message_derived: true }, false)).toBe(true);
  });

  it("a saved contact is not", () => {
    expect(isUnimportedSourceRecord({ ...empty, is_message_derived: 0 }, false)).toBe(false);
  });
});

describe("importBlockedReason", () => {
  it("names the missing fields", () => {
    expect(importBlockedReason({ name: "unknown", phone: "unknown" }, true)).toBe(
      NOTHING_TO_IMPORT_REASON,
    );
    expect(NOTHING_TO_IMPORT_REASON).toMatch(/no name, phone, or email/i);
    expect(NOTHING_TO_IMPORT_REASON).toMatch(/nothing to import/i);
  });

  /**
   * A SAVED CONTACT IS NEVER REFUSED, even in this state. Adding an existing
   * contact to a transaction is not an import, and blocking it would break a
   * real workflow to guard a state gate 4 check 6 measured as zero rows.
   */
  it("says nothing about a saved contact", () => {
    expect(importBlockedReason({ name: "unknown", phone: "unknown" }, false)).toBeNull();
  });

  it("says nothing about an importable source record", () => {
    expect(importBlockedReason({ phone: "+16175550147" }, true)).toBeNull();
  });
});
