/**
 * @jest-environment node
 *
 * BACKLOG-2416 — the two copies of the name-compatibility rule must agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO COPIES AT ALL
 * ---------------------------------------------------------------------------
 * `tsconfig.electron.json` sets `rootDir: "./electron"`, so nothing under
 * `electron/` may import from `src/` or `shared/` — the same constraint that
 * makes `electron/types/license.ts` a hand-duplicate of `shared/types/license.ts`.
 * Importing the other way is worse: `contactHandlers.ts` pulls in `ipcMain`,
 * which cannot exist in the renderer bundle.
 *
 * So the rule is stated twice, and THIS FILE is what stops the two statements
 * drifting. A test file is not bundled, so it is the one place both copies can
 * be loaded at once and compared.
 *
 * That drift is not hypothetical — it is the whole of BACKLOG-2416. The main
 * process required name compatibility before a shared phone could collapse two
 * records; the renderer's picker dedup matched on phone unconditionally. Two
 * people on one office line survived the backend and were then merged on
 * screen. The rule existing in one layer and not the other is exactly the bug.
 */

import {
  namesAreCompatible as electronRule,
  normalizeContactName as electronNormalize,
} from "../../../electron/utils/contactNameCompat";
import {
  namesAreCompatible as rendererRule,
  normalizeContactName as rendererNormalize,
} from "../contactNameCompat";

/**
 * The verdict table. Each row is a real question the picker asks.
 *
 * `expected` is asserted too, not just parity — two copies that are identically
 * WRONG would agree perfectly, so agreement alone proves nothing.
 */
const CASES: Array<{ a: string | null; b: string | null; expected: boolean; why: string }> = [
  // --- compatible: the same person recorded twice ------------------------
  { a: "Casey Lane", b: "Casey Lane", expected: true, why: "identical" },
  { a: "Casey Lane", b: "casey  lane", expected: true, why: "case and spacing" },
  { a: "Jane Smith", b: "Jane S.", expected: true, why: "abbreviated surname" },
  { a: "Jane Smith", b: "Jane Smithson", expected: true, why: "prefix-compatible surname" },
  { a: "Margaret", b: "Margaret", expected: true, why: "exact lone token" },
  { a: null, b: "Jane Smith", expected: true, why: "an empty name cannot contradict" },
  { a: "", b: "Jane Smith", expected: true, why: "a blank name cannot contradict" },
  { a: "Jane Smith Adams", b: "Jane Smith", expected: true, why: "extra trailing token" },

  // --- incompatible: distinct people on one line -------------------------
  {
    a: "Margaret Chen",
    b: "Margaret Torres",
    expected: false,
    why: "BACKLOG-2416: the office-line case — different surnames",
  },
  {
    a: "Margaret",
    b: "Margaret Chen",
    expected: false,
    why: "BACKLOG-2399: a lone non-exact token is never enough",
  },
  { a: "Margaret Chen", b: "John Chen", expected: false, why: "different first names" },
  { a: "Bob Smith", b: "Robert Smith", expected: false, why: "nicknames are not assumed" },
  { a: "Casey Lane", b: "Caseya Lane", expected: true, why: "prefix-compatible first name" },
];

describe("the electron and renderer copies of the name rule agree", () => {
  it.each(CASES)("$a ~ $b -> $expected ($why)", ({ a, b, expected }) => {
    expect(electronRule(a, b)).toBe(expected);
    expect(rendererRule(a, b)).toBe(expected);
  });

  it("agrees in BOTH argument orders for every case", () => {
    for (const { a, b } of CASES) {
      expect(rendererRule(b, a)).toBe(electronRule(b, a));
      // The rule is symmetric; an asymmetric one would make dedup depend on
      // arrival order, which is how "the same list twice" becomes two answers.
      expect(electronRule(a, b)).toBe(electronRule(b, a));
    }
  });

  it("normalizes identically", () => {
    for (const raw of ["Jane S.", "  Margaret   Chen ", "O'Neill, Pat", "", "CASEY LANE"]) {
      expect(rendererNormalize(raw)).toBe(electronNormalize(raw));
    }
  });
});
