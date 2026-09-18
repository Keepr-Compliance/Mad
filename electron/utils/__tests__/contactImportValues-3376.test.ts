/**
 * @jest-environment node
 *
 * =============================================================================
 * BACKLOG-3376 — `isUnmatchableImportEmail`, and the field it feeds
 * =============================================================================
 * BACKLOG-3358 made a contact with an address the app cannot validate import
 * instead of fail, saving the value as the address book has it. This item tells
 * the user when that happened — but only when the sentence it shows is TRUE.
 *
 * The sentence is "emails from it won't be linked to your transactions", and it
 * is definite. That forced the predicate to be much narrower than "the
 * validator refused it":
 *
 *   - An address links iff some `email_participants.email_address` equals it
 *     exactly after `toLowerCase().trim()`. Nothing on that path filters on
 *     validity — not the store (`createContactsBatch`,
 *     `backfillContactEmailsSync`), not the read (`AUTOLINK_CONTACT_EMAILS_SQL`),
 *     not the match (`IN (...)`).
 *   - So `pat@intranet` — refused by `validateEmail` for having no dot after
 *     the `@` — is stored and links perfectly normally. A definite "won't be
 *     linked" about it would be FALSE.
 *
 * Hence: whitespace inside the address, or no `@` at all. That is a STRICT
 * SUBSET of "not usable", so the message can only ever under-warn, which is the
 * safe direction for a sentence stated as certain. Everything unusable-but-
 * matchable is swept below and asserted SILENT.
 *
 * The founder ruled on this directly (pm_comments, 2026-09-16): warn only on
 * addresses no email can carry, and keep the definite wording.
 *
 * Corpus rows carry their `usable` value as well as their `unmatchable` one, so
 * the subset invariant is swept rather than sampled (SR review R8).
 */

import {
  isUnmatchableImportEmail,
  isUsableImportEmail,
  shapeImportValues,
} from "../contactImportValues";

/** [value, usable, unmatchable]. Every row measured against the live code. */
const CORPUS: Array<[string, boolean, boolean]> = [
  // --- no email can be addressed from these: whitespace, or no "@" ---------
  ["pat@ example.com", false, true],
  ["pat @example.com", false, true],
  ["first last@example.com", false, true],
  ["pat@exam ple.com", false, true],
  ["noatsign.example.com", false, true],
  ["pat", false, true],

  // --- unusable, but a participant address CAN equal them: SILENT ----------
  // A dotless intranet domain is the case the founder ruled on by name: stored,
  // and its mail links.
  ["pat@intranet", false, false],
  ["pat@localhost", false, false],
  // `validateAddress` splits on the FIRST "@" (`indexOf`), so the legacy
  // participant path can emit a two-"@" string.
  ["two@@example.com", false, false],
  // Over `validateEmail`'s 254-character ceiling, which is Keepr's rule and not
  // a property of email.
  ["a".repeat(243) + "@example.com", false, false],
  ["pat@example.", false, false],
  ["@example.com", false, false],
  ["pat@", false, false],

  // --- usable: never unmatchable ------------------------------------------
  ["pat@example.com", true, false],
  ["a@b.c", true, false],
  ["  padded@example.com  ", true, false],
  ["a".repeat(242) + "@example.com", true, false],
];

describe("C8 the predicate is narrower than `not usable`", () => {
  it.each(CORPUS.map(([v, , u]) => [v, u] as const))(
    "%j -> unmatchable=%s",
    (value, expected) => {
      expect(isUnmatchableImportEmail(value)).toBe(expected);
    },
  );

  it("the four addresses the founder's ruling names as silent are silent", () => {
    // Called out in the decision comment, so they are asserted by name as well
    // as swept above: an edit that widened the predicate would have to pass
    // here too, and this is the row that says why it must not.
    for (const v of ["pat@", "@example.com", "pat@example.", "a".repeat(243) + "@example.com"]) {
      expect(isUsableImportEmail(v)).toBe(false);
      expect(isUnmatchableImportEmail(v)).toBe(false);
    }
    expect(isUnmatchableImportEmail("pat@intranet")).toBe(false);
  });

  it("blanks and non-strings are never unmatchable", () => {
    // A blank entry has no "@" either. There is nothing to name in a message,
    // so it is excluded ahead of both arms.
    for (const v of ["", "   ", null, undefined, 42, {}, ["pat@ example.com"]]) {
      expect(isUnmatchableImportEmail(v)).toBe(false);
    }
  });
});

describe("C9 unmatchable is a STRICT SUBSET of unusable", () => {
  it("no value in the corpus is both usable and unmatchable", () => {
    // The invariant the definite wording rests on. Today it is also implied by
    // `validateEmail`'s regex, which forbids whitespace and requires an "@" —
    // so removing the subset guard alone is INERT (handoff, M10). This sweep is
    // what would catch a future loosening of that regex, which is the change
    // that would make the guard load-bearing.
    for (const [value, usable, unmatchable] of CORPUS) {
      expect(isUsableImportEmail(value)).toBe(usable);
      expect(usable && unmatchable).toBe(false);
    }
  });

  it("every unmatchable value in the corpus is unusable", () => {
    const unmatchable = CORPUS.filter(([, , u]) => u);
    expect(unmatchable.length).toBeGreaterThan(0);
    for (const [value] of unmatchable) {
      expect(isUsableImportEmail(value)).toBe(false);
    }
  });
});

describe("C10 the shaped record carries the VALUES, as the source holds them", () => {
  it("address-book casing and address-book order, deduped case-insensitively", () => {
    const shaped = shapeImportValues({
      allEmails: [
        "Pat@ Example.com",
        "pat@example.com",
        // The same address as the first, differing only in case: the database
        // stores one row (`createContactsBatch` dedupes on
        // `toLowerCase().trim()`), so the message must name it once.
        "PAT@ EXAMPLE.COM",
        "  noatsign.example.com  ",
      ] as unknown as string[],
    });
    // The SOURCE's casing, not the lowercased stored form — the user is being
    // sent to find this address on their own contact card.
    expect(shaped.unmatchableEmails).toEqual([
      "Pat@ Example.com",
      "noatsign.example.com",
    ]);
    // Nothing is removed from what gets stored: the usable one is merely first.
    expect(shaped.allEmails).toHaveLength(4);
  });

  it("nothing unmatchable -> an empty array, and the usable values are untouched", () => {
    const shaped = shapeImportValues({
      allEmails: ["pat@intranet", "pat@example.com"] as unknown as string[],
    });
    expect(shaped.unmatchableEmails).toEqual([]);
    expect(shaped.allEmails).toEqual(["pat@example.com", "pat@intranet"]);
  });

  it("a scalar-only record (message-derived rows) is covered too", () => {
    // `usableFirst` treats an empty array plus a scalar as one candidate, which
    // is also what `createContactsBatch` stores for such a row.
    const shaped = shapeImportValues({ allEmails: [], email: "  pat@ example.com  " });
    expect(shaped.unmatchableEmails).toEqual(["pat@ example.com"]);
  });

  it("phones are never reported, whatever they hold (MECHANISM UNTRACED)", () => {
    // An unusable phone is only one over 50 characters, and whether such a
    // value can match a message handle is untraced. No phone sentence ships.
    const shaped = shapeImportValues({
      allEmails: ["pat@example.com"] as unknown as string[],
      allPhones: ["5".repeat(51), "+1 415 555 0142"] as unknown as string[],
    });
    expect(shaped.unmatchableEmails).toEqual([]);
  });
});
