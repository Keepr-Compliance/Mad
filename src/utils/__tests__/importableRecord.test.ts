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
  COMPANY_ONLY_IMPORT_REASON,
  hasNothingToImport,
  hasNothingToSave,
  importBlockedReason,
  importRefusalReason,
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

/**
 * =============================================================================
 * BACKLOG-2707 — COMPANY-ONLY MOVED, AND THIS RECORDS WHERE IT MOVED TO
 * =============================================================================
 * "a company and nothing else" used to sit in the list above, asserting a
 * company-only record was importable. **It is not, any more.** Founder ruling
 * `a41a805b` and PM decision `5fac2d84` (2026-09-07, delegated): a company-only
 * contact may be CREATED by hand and may NOT be imported.
 *
 * The case is REWRITTEN rather than deleted. Deleting it would leave no trace
 * that the rule was ever the other way — and this whole item is the proof of
 * what that costs: three prior items re-ratified a rule the founder has now
 * overruled, and the only reason that was legible at all was the tests they
 * left behind.
 *
 * The two directions are asserted TOGETHER, because the subset property is the
 * point: saveable and NOT importable is the one divergence that exists.
 */
describe("company-only — saveable, not importable (BACKLOG-2707)", () => {
  const companyOnly = { company: "Vantrees Realty" };

  it("may be saved — it is a real thing a user meant to create", () => {
    expect(hasNothingToSave(companyOnly)).toBe(false);
  });

  it("may NOT be imported — a company is not somebody to import", () => {
    expect(hasNothingToImport(companyOnly)).toBe(true);
  });

  it("carries a reason that is true beside the label its row renders", () => {
    // `labelForContact` shows the company when there is no name, so the row
    // reads "Vantrees Realty". A reason claiming the row is empty would be
    // false to the person looking at it.
    const reason = importRefusalReason(companyOnly);
    expect(reason).toBe(COMPANY_ONLY_IMPORT_REASON);
    expect(reason).not.toMatch(/nothing to import/i);
    expect(reason).toMatch(/company/i);
  });

  it("a record with nothing at all keeps the original reason", () => {
    expect(importRefusalReason({ name: "unknown", phone: "unknown" })).toBe(
      NOTHING_TO_IMPORT_REASON,
    );
  });
});

/**
 * The subset property, SWEPT rather than sampled — SR's required control.
 *
 * `hasNothingToImport` is defined as `hasNothingToSave({...c, company: null})`,
 * so importable ⊂ saveable holds by construction. This enumerates the cross
 * product anyway, because "by construction" is a claim about code and this is a
 * measurement of behaviour — and because it is what goes red if someone ever
 * re-writes the derivation as a second field list.
 */
describe("importable is a strict subset of saveable, swept (BACKLOG-2707)", () => {
  const FIELDS = ["display_name", "name", "company", "phone", "email"] as const;
  const VALUES = [undefined, null, "", "   ", "unknown", "real-value"] as const;

  /** Every scalar combination, plus the two plural arrays toggled. */
  function corpus(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const walk = (i: number, acc: Record<string, unknown>) => {
      if (i === FIELDS.length) {
        for (const phones of [[], [""], ["+16175550147"]]) {
          for (const emails of [[], [""], ["marisol@example.com"]]) {
            out.push({ ...acc, allPhones: phones, allEmails: emails });
          }
        }
        return;
      }
      for (const v of VALUES) walk(i + 1, { ...acc, [FIELDS[i]]: v });
    };
    walk(0, {});
    return out;
  }

  it("no record is importable without also being saveable", () => {
    const violations = corpus().filter(
      (r) => !hasNothingToImport(r) && hasNothingToSave(r),
    );

    expect(violations).toEqual([]);
  });

  /**
   * ANTI-VACUITY. A sweep that never produced an importable record would pass
   * the test above while proving nothing at all.
   */
  it("the sweep actually contains records of both answers", () => {
    const all = corpus();
    expect(all.length).toBe(6 ** 5 * 9);
    expect(all.some((r) => !hasNothingToImport(r))).toBe(true);
    expect(all.some((r) => hasNothingToImport(r))).toBe(true);
    expect(all.some((r) => !hasNothingToSave(r))).toBe(true);
  });

  /**
   * THE ONLY DIVERGENCE IS COMPANY-ONLY, asserted as a SET rather than sampled.
   * If a second import-specific rule is ever added, this set grows and the test
   * names the new member instead of quietly accepting it.
   */
  it("the set of records where the two rules differ is exactly company-only", () => {
    const diverging = corpus().filter(
      (r) => hasNothingToImport(r) !== hasNothingToSave(r),
    );

    expect(diverging.length).toBeGreaterThan(0);
    for (const r of diverging) {
      // Saveable, not importable — never the other way round.
      expect(hasNothingToSave(r)).toBe(false);
      expect(hasNothingToImport(r)).toBe(true);
      // And the ONLY thing carrying it is the company.
      expect(hasNothingToSave({ ...r, company: null })).toBe(true);
    }
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
    // BACKLOG-2707: this string is now shown ONLY for a record with nothing at
    // all. The company-only case has its own, because one sentence could not be
    // true of both — see the describe above.
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
