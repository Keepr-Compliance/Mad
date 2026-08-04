/**
 * The renderer's copy of the evidence vocabulary must not drift from the main
 * process's (BACKLOG-2459).
 *
 * ===========================================================================
 * WHY A PARITY TEST INSTEAD OF ONE MODULE
 * ===========================================================================
 * `maskEmail`, `maskPhone` and `describeIdentifier` were written for the review
 * queue (BACKLOG-2410) and live in `electron/services/contactLinkEvidence.ts`.
 * The picker's collapse disclosure needs the identical words. It cannot import
 * them, and this was established by BUILDING, not by reading config:
 *
 *  - Vite applies its TypeScript transform only under `src/`. A shared module at
 *    `electron/services/contactLinkEvidenceVocabulary.ts`, imported by
 *    `ContactRow`, passed `tsc --noEmit`, eslint, the full jest suite and an SR
 *    review — and then failed `vite build` on its first `import type` line, on
 *    macOS and Windows both.
 *  - `shared/` at the repo root behaves identically; probed with a throwaway
 *    value import, same parse error. (Hence `shared/types/license.js` sitting
 *    beside its `.ts` as a hand-compiled artifact.)
 *  - `electron/` cannot import from `src/`: `tsconfig.electron.json` sets
 *    `rootDir: ./electron`, and every existing import in that direction is in a
 *    test file, which that config excludes.
 *
 * So the words are duplicated. **This test is what makes that safe.** Jest
 * resolves across the process boundary freely — unlike Vite and unlike
 * `tsc -p tsconfig.electron.json` — so it can hold both copies side by side and
 * compare them on real inputs. Edit one side alone and this goes red.
 *
 * It compares OUTPUT over a corpus rather than source text: two implementations
 * that agree on every input are interchangeable, which is the property that
 * actually matters, and a source-text comparison would break on a reformat that
 * changed nothing.
 */

import {
  describeIdentifier as canonicalDescribeIdentifier,
  maskEmail as canonicalMaskEmail,
  maskPhone as canonicalMaskPhone,
} from "../../../electron/services/contactLinkEvidence";
import {
  describeIdentifier as mirrorDescribeIdentifier,
  maskEmail as mirrorMaskEmail,
  maskPhone as mirrorMaskPhone,
} from "../contactCollapseVocabulary";

/**
 * The corpus is GENERATED across each function's boundary dimensions, not
 * hand-picked.
 *
 * The first version of this file hand-picked "one input per branch" and was NOT
 * DISCRIMINATING: drifting the mirror's `local.length <= 2` to `<= 3` left it
 * green, because no chosen email happened to have a 3-character local part. A
 * parity test that cannot see drift is worse than none — it reports safety it
 * has not checked. That is the same defect class as the fixture and
 * verification-set failures filed under BACKLOG-2439, committed here in the very
 * test written to prevent drift.
 *
 * So every length boundary is swept exhaustively rather than sampled. Reserved
 * ranges only (RFC 2606 domains, +1 555 01xx numbers).
 */

/** Local parts of every length 0..8, so no `<=` boundary can hide between two samples. */
const LOCAL_PARTS = ["", "a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh"];

const EMAILS: string[] = [
  ...LOCAL_PARTS.map((local) => `${local}@example.test`),
  ...LOCAL_PARTS.map((local) => `  ${local}@Example.test  `), // trimming + case
  "no-at-sign",
  "",
  "   ",
  "first@second@example.test", // lastIndexOf, not indexOf
  "a@b",
];

/** Digit strings of every length 0..8, sweeping the `<= 4` boundary from both sides. */
const PHONES: string[] = [
  ...Array.from({ length: 9 }, (_, n) => "415555017734".slice(0, n)),
  "+1 (415) 555-0177",
  "+1-415-555-0100",
  "4155550177",
  "",
  "   ",
  "not a phone",
  "(0)",
];

const MATCHED_ON: Array<"email" | "phone" | "name" | null | undefined> = [
  "email",
  "phone",
  "name",
  null,
  undefined,
];

/**
 * Value sets crossed with every `matchedOn`, so each identifier kind is exercised
 * against each other kind's values — `describeIdentifier` branches on the pair.
 */
const VALUE_SETS: string[][] = [
  [],
  [""],
  ["   "],
  ...EMAILS.map((e) => [e]),
  ...PHONES.map((p) => [p]),
  ["Elm Example"],
  ["  Elm Example  "],
  ["  ", "abc@example.test"], // first non-blank wins
  ["Alice Example", "Bea Example"],
];

describe("contactCollapseVocabulary — parity with the main-process canonical", () => {
  it("maskEmail agrees on every input", () => {
    for (const input of EMAILS) {
      expect({ input, out: mirrorMaskEmail(input) }).toEqual({
        input,
        out: canonicalMaskEmail(input),
      });
    }
  });

  it("maskPhone agrees on every input", () => {
    for (const input of PHONES) {
      expect({ input, out: mirrorMaskPhone(input) }).toEqual({
        input,
        out: canonicalMaskPhone(input),
      });
    }
  });

  it("describeIdentifier agrees on every (matchedOn, values) pair", () => {
    for (const matchedOn of MATCHED_ON) {
      for (const values of VALUE_SETS) {
        const key = `${String(matchedOn)}:${JSON.stringify(values)}`;
        expect({ key, out: mirrorDescribeIdentifier(matchedOn, values) }).toEqual({
          key,
          out: canonicalDescribeIdentifier(matchedOn, values),
        });
      }
    }
  });

  it("is comparing two REAL implementations, not one re-exported twice", () => {
    // Without this, the suite above would pass just as happily if the mirror
    // secretly re-exported the canonical — which is exactly the thing the build
    // forbids, so a green parity suite would be hiding a broken build again.
    expect(mirrorMaskEmail).not.toBe(canonicalMaskEmail);
    expect(mirrorMaskPhone).not.toBe(canonicalMaskPhone);
    expect(mirrorDescribeIdentifier).not.toBe(canonicalDescribeIdentifier);
  });

  it("still produces the masked forms the disclosure depends on", () => {
    // A parity test alone would pass if BOTH sides were broken identically.
    // These pin the actual contract the collapse sentence relies on.
    expect(mirrorMaskEmail("alice.example@example.test")).toBe("al…@example.test");
    expect(mirrorMaskPhone("+1 (415) 555-0177")).toBe("…0177");
    expect(mirrorDescribeIdentifier("email", ["alice.example@example.test"])).toBe(
      "the email address al…@example.test",
    );
    expect(mirrorDescribeIdentifier("phone", ["+1 (415) 555-0177"])).toBe(
      "the phone number …0177",
    );
    expect(mirrorDescribeIdentifier("name", ["  Elm Example  "])).toBe(
      'the name "Elm Example"',
    );
  });
});
