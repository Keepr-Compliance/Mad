/**
 * @jest-environment node
 *
 * BACKLOG-2684 — the two copies of "there is nothing on this record" must agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO COPIES AT ALL
 * ---------------------------------------------------------------------------
 * `tsconfig.electron.json` sets `rootDir: "./electron"`, so nothing under
 * `electron/` may import from `src/`. Importing the other way is worse:
 * `contactHandlers.ts` pulls in `ipcMain`, which cannot exist in the renderer
 * bundle. So the rule is stated twice, and THIS FILE is what stops the two
 * statements drifting — a test file is not bundled, so it is the one place both
 * copies can be loaded at once and compared.
 *
 * The item asked for "the one exported function imported in both tests". The
 * module boundary forbids that literally; this is the repo's standing answer to
 * exactly that constraint (`contactDisplayLabel`, `phoneNormalization`,
 * `contactNameCompat` and `contactSourceDefaults` are all mirror pairs with a
 * parity test), and it gates the same property.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TABLE CARRIES `expected` AND NOT ONLY PARITY
 * ---------------------------------------------------------------------------
 * Two copies that are identically WRONG agree perfectly. Every row therefore
 * asserts the answer as well as the agreement — the same reason
 * `contactNameCompat.parity.test.ts` carries its verdict column.
 *
 * ---------------------------------------------------------------------------
 * THE CORPUS SWEEPS THE BOUNDARY RATHER THAN SAMPLING IT
 * ---------------------------------------------------------------------------
 * One input per branch cannot catch an off-by-one. So: every field alone, every
 * field alone with a sentinel in it, both plural arrays, whitespace-only,
 * case variants of both sentinels, and the two shapes transcribed from the real
 * producers — the message-derived `{name:"unknown", phone:"unknown"}` and the
 * `contacts:get-available` projection of a nameless address-book row.
 */

import {
  hasNothingToImport as electronRule,
  hasNothingToSave as electronSaveRule,
  importRefusalReason as electronRefusalReason,
  NOTHING_TO_IMPORT_REASON as electronReason,
  COMPANY_ONLY_IMPORT_REASON as electronCompanyReason,
} from "../../../electron/utils/importableRecord";
import {
  hasNothingToImport as rendererRule,
  hasNothingToSave as rendererSaveRule,
  importRefusalReason as rendererRefusalReason,
  NOTHING_TO_IMPORT_REASON as rendererReason,
  COMPANY_ONLY_IMPORT_REASON as rendererCompanyReason,
} from "../importableRecord";

interface Row {
  parts: Parameters<typeof rendererRule>[0];
  expected: boolean;
  why: string;
}

const CASES: Row[] = [
  // --- nothing on the record: refuse -------------------------------------
  { parts: {}, expected: true, why: "literally empty" },
  { parts: { name: "" }, expected: true, why: "empty name, nothing else" },
  { parts: { name: "   " }, expected: true, why: "whitespace-only name" },
  {
    parts: { name: "unknown", phone: "unknown" },
    expected: true,
    why: "THE FOUNDER'S RECORD — getMessageDerivedContacts projects `from` into both slots",
  },
  { parts: { name: "unknown" }, expected: true, why: "the `unknown` sentinel alone" },
  { parts: { name: "Unknown Contact" }, expected: true, why: "the `unknown contact` sentinel" },
  { parts: { name: "  UNKNOWN  " }, expected: true, why: "sentinel differing only in case+space" },
  { parts: { name: "unknown CONTACT" }, expected: true, why: "second sentinel, mixed case" },
  { parts: { display_name: "unknown" }, expected: true, why: "sentinel in display_name" },
  { parts: { company: "" }, expected: true, why: "empty company" },
  { parts: { company: "unknown" }, expected: true, why: "sentinel company" },
  { parts: { phone: "" }, expected: true, why: "empty phone" },
  { parts: { phone: "unknown" }, expected: true, why: "sentinel phone" },
  { parts: { email: "" }, expected: true, why: "empty email" },
  { parts: { email: "unknown" }, expected: true, why: "sentinel email" },
  { parts: { allPhones: [], allEmails: [] }, expected: true, why: "both plural arrays empty" },
  {
    parts: { allPhones: ["", "  "], allEmails: [""] },
    expected: true,
    why: "plural arrays holding only blanks",
  },
  {
    parts: { allPhones: ["unknown"], allEmails: ["unknown"] },
    expected: true,
    why: "plural arrays holding only sentinels",
  },
  {
    parts: { name: null, display_name: null, company: null, phone: null, email: null },
    expected: true,
    why: "every field explicitly null",
  },

  // --- something on the record: accept ------------------------------------
  { parts: { name: "Dana Whitlock" }, expected: false, why: "an ordinary name" },
  { parts: { display_name: "Dana Whitlock" }, expected: false, why: "name only in display_name" },
  {
    // BACKLOG-2707 — REVERSED, by founder ruling `a41a805b` / PM `5fac2d84`.
    // This case read "COMPANY COUNTS — the display chain's second tier renders
    // it on screen" and expected `false`. It still renders on screen, and it is
    // still SAVEABLE (asserted in the subset describe below) — but a company is
    // not somebody you can import, so IMPORT now refuses it. Reversed rather
    // than removed, so the trail from 2672 to here stays legible.
    parts: { company: "Vantrees Realty" },
    expected: true,
    why: "a company alone is SAVEABLE but not IMPORTABLE (BACKLOG-2707)",
  },
  {
    parts: { name: "", phone: "+14155550142", allPhones: ["+14155550142"], allEmails: [] },
    expected: false,
    why: "THE BOUNDARY — transcribed from contacts:get-available for a nameless address-book row",
  },
  { parts: { name: "", email: "dana@example.com" }, expected: false, why: "email only" },
  {
    parts: { allPhones: ["+14155550142"] },
    expected: false,
    why: "identifier only in the plural array — the flat field alone would miss it",
  },
  {
    parts: { allEmails: ["dana@example.com"] },
    expected: false,
    why: "identifier only in the plural emails array",
  },
  {
    parts: { name: "unknown", phone: "+14155550142" },
    expected: false,
    why: "sentinel name but a REAL phone — refusing this is the too-broad failure",
  },
  {
    parts: { phone: "dana@example.com" },
    expected: false,
    why: "NO DIGIT TEST — an iMessage handle can be an Apple ID and still identify a person",
  },
  {
    // BACKLOG-3358 — transcribed from the `contacts:get-available` row for a
    // nameless Outlook record whose only address has a dotless domain. Presence
    // decides, not validity: the import stores the value as the source holds
    // it, so neither copy may start refusing this record.
    parts: { name: null, phone: null, company: null, email: "name@localhost", allEmails: ["name@localhost"], allPhones: [] },
    expected: false,
    why: "an address the app cannot use still makes the record importable (BACKLOG-3358)",
  },
  {
    parts: { name: "unknown", allPhones: ["", "+14155550142"] },
    expected: false,
    why: "one usable entry among blanks is enough",
  },
];

describe("the main-process and renderer copies of hasNothingToImport agree", () => {
  it.each(CASES)("$why", ({ parts, expected }) => {
    expect(rendererRule(parts)).toBe(expected);
    expect(electronRule(parts)).toBe(expected);
  });

  /**
   * A caller that shows the handler's refusal next to the button's refusal must
   * not show two different sentences for one rule.
   */
  it("states the reason identically on both sides", () => {
    expect(electronReason).toBe(rendererReason);
  });

  /**
   * BACKLOG-2707 — the mirror pair grew three members and a second string, and
   * a drift in any of them is silent unless it is pinned here.
   */
  it("states the company-only reason identically on both sides", () => {
    expect(electronCompanyReason).toBe(rendererCompanyReason);
    expect(electronCompanyReason).not.toBe(electronReason);
  });

  it("hasNothingToSave agrees on both sides across the same corpus", () => {
    for (const { parts } of CASES) {
      expect(rendererSaveRule(parts)).toBe(electronSaveRule(parts));
    }
  });

  it("importRefusalReason picks the same string on both sides", () => {
    for (const { parts } of CASES) {
      expect(rendererRefusalReason(parts)).toBe(electronRefusalReason(parts));
    }
  });

  /**
   * The subset property, asserted across the MIRROR PAIR rather than within one
   * copy: if the two `hasNothingToSave` bodies ever drift, the derived import
   * rule drifts with them and this catches it on both sides at once.
   */
  it("importable implies saveable, on both copies", () => {
    for (const { parts } of CASES) {
      if (!rendererRule(parts)) expect(rendererSaveRule(parts)).toBe(false);
      if (!electronRule(parts)) expect(electronSaveRule(parts)).toBe(false);
    }
  });

  /**
   * THE COPIES MUST NOT SILENTLY BECOME DIFFERENT FUNCTIONS.
   *
   * The table above is a fixed corpus, so a divergence outside it would pass.
   * This sweeps a generated cross-product of the five scalar fields over
   * {absent, blank, whitespace, sentinel, real value} — 5^5 = 3125 records —
   * and asserts the two copies answer identically on every one.
   */
  it("agrees across a generated sweep of every scalar field combination", () => {
    const VALUES = [undefined, "", "   ", "unknown", "real"];
    const FIELDS = ["display_name", "name", "company", "phone", "email"] as const;

    let compared = 0;
    const disagreements: string[] = [];

    const walk = (i: number, acc: Record<string, string | undefined>): void => {
      if (i === FIELDS.length) {
        const parts = acc as Parameters<typeof rendererRule>[0];
        compared += 1;
        // BACKLOG-2707: all four mirror-pair members swept, not just the one.
        if (
          rendererRule(parts) !== electronRule(parts) ||
          rendererSaveRule(parts) !== electronSaveRule(parts) ||
          rendererRefusalReason(parts) !== electronRefusalReason(parts)
        ) {
          disagreements.push(JSON.stringify(parts));
        }
        return;
      }
      for (const v of VALUES) {
        walk(i + 1, { ...acc, [FIELDS[i]]: v });
      }
    };
    walk(0, {});

    expect(compared).toBe(VALUES.length ** FIELDS.length);
    expect(disagreements).toEqual([]);
  });
});
