/**
 * BACKLOG-4106 — Missouri controls: MREC and KCRAR (title-keyed, whole line) and Missouri REALTORS®
 * (code-page, document markers). Every SYNTHETIC input is labelled; every other input is a fixture
 * transcribed from a blank form (see moHeaders.ts).
 */
import { DEFAULT_REGISTRY } from "../registry";
import { EVIDENCE_CAP, inferRegion, matchForms } from "../formMatcher";
import { KCRAR_PUBLISHER, MREC_PUBLISHER } from "../moForms";
import type { FormMatch, TitleKeyedHeader } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import {
  MO1_MREC_PORTRAIT,
  MO2_MREC_LANDSCAPE,
  MO3_MR_RES_2000,
  MO4_MR_DSC_8000,
  MO5_MR_RES_1010,
  MO6_KCRAR_SALE,
  MO_FIXTURES,
} from "./fixtures/moHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const pin = (ms: FormMatch[]) => ms.map((m) => [m.formId, m.occurrences, m.revisionSeen]);
const dots = (n: number) => ".".repeat(n);
const MR_FOOT = "Last Revised 12/31/09. ®2003 Missouri Association of Realtors";

describe("BACKLOG-4106 MREC (title-keyed, whole line)", () => {
  it("K13: portrait — the title prints mid-page (offset 3,034), the prescription line 2,059 chars after", () => {
    const text = fixtureText(MO1_MREC_PORTRAIT);
    const ms = matchForms(text);
    expect(pin(ms)).toEqual([["mrec-broker-disclosure", 1, "January, 2005"]]);
    expect(ms[0].firstOffset).toBe(3034);
    expect(text.indexOf("Prescribed by") - 3034).toBe(2059);
  });

  it("landscape — title at the top, prescription line +1,239", () => {
    const ms = matchForms(fixtureText(MO2_MREC_LANDSCAPE));
    expect(pin(ms)).toEqual([["mrec-broker-disclosure", 1, "January, 2005"]]);
    expect(ms[0].firstOffset).toBe(0);
  });

  it("R7: the portrait's evidence is capped at 400 chars from the title", () => {
    const [m] = matchForms(fixtureText(MO1_MREC_PORTRAIT));
    expect(m.evidence.length).toBe(EVIDENCE_CAP);
    expect(m.evidence.startsWith("MISSOURI BROKER DISCLOSURE FORM\n")).toBe(true);
  });

  it("the title without the Commission's prescription line does not match (SYNTHETIC)", () => {
    expect(matchForms(["MISSOURI BROKER DISCLOSURE FORM", ...BODY, "as of January, 2005"].join("\n"))).toEqual([]);
  });

  it("F4: the prescription line without its date does not match (SYNTHETIC)", () => {
    expect(matchForms(["MISSOURI BROKER DISCLOSURE FORM", ...BODY, "Prescribed by the Missouri Real Estate Commission as of the current rule."].join("\n"))).toEqual([]);
  });
});

describe("BACKLOG-4106 Missouri REALTORS® (code-page, document markers)", () => {
  it("RES-1010: all 6 pages; revision from the Last Revised line, found document-wide", () => {
    const ms = matchForms(fixtureText(MO5_MR_RES_1010));
    expect(pin(ms)).toEqual([["mr-RES-1010", 6, "12/31/12"]]);
    expect(ms[0]).toMatchObject({ publisherId: "mr", code: "RES-1010", kind: "listing_agreement" });
    expect(ms[0].firstOffset).toBe(fixtureText(MO5_MR_RES_1010).indexOf("RES-1010 Page 1 of 6"));
  });

  it("DSC-8000: 5 of 6 pages (page 6's page line is a vendor stamp)", () => {
    expect(pin(matchForms(fixtureText(MO4_MR_DSC_8000)))).toEqual([["mr-DSC-8000", 5, "12/31/09"]]);
  });

  it("F4/R3: RES-2000 prints no Last Revised — no match at all, not even ?RES-2000 (row held)", () => {
    const text = fixtureText(MO3_MR_RES_2000);
    expect(text).toContain("RES-2000 PAGE 1 OF 8");
    expect(text).toContain("©2015 Missouri REALTORS®");
    expect(matchForms(text)).toEqual([]);
    expect(DEFAULT_REGISTRY.forms.map((f) => f.code)).not.toContain("RES-2000");
  });

  it("K17: without the publisher's name anywhere, no match (SYNTHETIC: the Last Revised line rewritten without it)", () => {
    const lines = MO4_MR_DSC_8000.lines.map((l) => (l === MR_FOOT ? "Last Revised 12/31/09." : l));
    expect(lines).not.toEqual(MO4_MR_DSC_8000.lines);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("K1: a code-page token mid-line, or a code with no page token, is not a code line (SYNTHETIC)", () => {
    expect(matchForms(["attach MAR form MSC-2040 Page 1 of 1 to this contract", MR_FOOT].join("\n"))).toEqual([]);
    expect(matchForms(["MSC-2040 is attached", MR_FOOT].join("\n"))).toEqual([]);
    expect(ids(matchForms(["MSC-2040 Page 1 of 1", MR_FOOT].join("\n")))).toEqual(["?MSC-2040"]);
  });

  it("K3: text glued after the page token is allowed (SYNTHETIC)", () => {
    expect(ids(matchForms(["DSC-8000 Page 3 of 6 Seller's Initials ____", MR_FOOT].join("\n")))).toEqual(["mr-DSC-8000"]);
  });

  it("K4: the page total is never a key (SYNTHETIC: totals 6 and 7)", () => {
    const ms = matchForms(["DSC-8000 Page 1 of 6", ...BODY, "DSC-8000 Page 2 of 7", MR_FOOT].join("\n"));
    expect(pin(ms)).toEqual([["mr-DSC-8000", 2, "12/31/09"]]);
  });
});

describe("BACKLOG-4106 KCRAR (title-keyed, whole line, document markers)", () => {
  it("sale contract: all 16 pages; revision found document-wide", () => {
    const ms = matchForms(fixtureText(MO6_KCRAR_SALE));
    expect(pin(ms)).toEqual([["kcrar-sale-contract", 16, "September 2020"]]);
    expect(ms[0]).toMatchObject({ publisherId: "kcrar", kind: "purchase_agreement", firstOffset: 0 });
  });

  it("K17: without the publisher's name anywhere, no match (SYNTHETIC: name line taken out)", () => {
    const lines = MO6_KCRAR_SALE.lines.filter((l) => !/Kansas City Regional/.test(l));
    expect(lines.length).toBe(MO6_KCRAR_SALE.lines.length - 1);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("F4: without the Last revised line, no match (SYNTHETIC: line taken out)", () => {
    const lines = MO6_KCRAR_SALE.lines.filter((l) => !/Last revised/.test(l));
    expect(lines.length).toBe(MO6_KCRAR_SALE.lines.length - 1);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("K15: the title must be a whole line as printed — the upper-case form and a prose mention do not anchor (SYNTHETIC)", () => {
    const tail = ["Approved by Legal Counsel of the Kansas City Regional Association of REALTORS®", "Last revised September 2020."];
    expect(ids(matchForms(["Residential Real Estate Sale Contract", "Page 1 of 16", ...tail].join("\n")))).toEqual(["kcrar-sale-contract"]);
    expect(matchForms(["RESIDENTIAL REAL ESTATE SALE CONTRACT", "Page 1 of 16", ...tail].join("\n"))).toEqual([]);
    expect(matchForms(["This Residential Real Estate Sale Contract is binding", "Page 1 of 16", ...tail].join("\n"))).toEqual([]);
  });
});

describe("BACKLOG-4106 K25 — MO window boundary sweeps (SYNTHETIC layouts)", () => {
  const MREC_T = "MISSOURI BROKER DISCLOSURE FORM";
  const PRESC = "Prescribed by the Missouri Real Estate Commission as of January, 2005";
  const MREC_M = "Prescribed by the Missouri Real Estate Commission as of";
  const mrecAfter = (end: number) => `${MREC_T}\n${dots(end - MREC_T.length - 2 - MREC_M.length)}\n${PRESC}`;
  const mrecBefore = (start: number) => `${PRESC}\n${dots(start - PRESC.length - 2)}\n${MREC_T}`;
  const KC_T = "Residential Real Estate Sale Contract";
  const KC_TAIL = "\nKansas City Regional Association of REALTORS®\nLast revised September 2020.";
  // A one-digit total: a window that cuts "Page 1 of 16" to "Page 1 of 1" would still match `\d+`.
  const kcAt = (end: number) => `${KC_T}\n${dots(end - KC_T.length - 2 - 11)}\nPage 1 of 9${KC_TAIL}`;

  it("windows are MREC ±2600, KCRAR 0/+60", () => {
    expect([MREC_PUBLISHER, KCRAR_PUBLISHER].map((p) => [(p.header as TitleKeyedHeader).windowBefore, (p.header as TitleKeyedHeader).windowAfter])).toEqual([
      [2600, 2600],
      [0, 60],
    ]);
  });

  // The required marker ends before the date; the revision (`as of January, 2005`) must lie in the
  // window too, so the measured end is the marker's, and the revision ends 14 chars later.
  it.each([2583, 2584, 2585, 2586])("MREC: prescription marker ending at +%i (revision 14 chars later) matches", (end) => {
    expect(ids(matchForms(mrecAfter(end)))).toEqual(["mrec-broker-disclosure"]);
  });
  it.each([2587, 2588, 2589])("MREC: prescription marker ending at +%i (revision past +2600) does not", (end) => {
    expect(matchForms(mrecAfter(end))).toEqual([]);
  });
  it.each([2598, 2599, 2600])("MREC: prescription line starting %i before the title matches", (start) => {
    expect(matchForms(mrecBefore(start))[0]?.firstOffset).toBe(start);
  });
  it.each([2601, 2602, 2603])("MREC: prescription line starting %i before the title does not", (start) => {
    expect(matchForms(mrecBefore(start))).toEqual([]);
  });

  it.each([58, 59, 60])("KCRAR: page line ending at +%i matches", (end) => {
    expect(ids(matchForms(kcAt(end)))).toEqual(["kcrar-sale-contract"]);
  });
  it.each([61, 62, 63])("KCRAR: page line ending at +%i does not", (end) => {
    expect(matchForms(kcAt(end))).toEqual([]);
  });
});

describe("BACKLOG-4106 MO — region and registry", () => {
  it("K24: every MO form fixture infers MO only (RES-2000 matches nothing)", () => {
    for (const f of MO_FIXTURES.filter((x) => x !== MO3_MR_RES_2000)) {
      const ms = matchForms(fixtureText(f));
      expect(ms.length).toBe(1);
      expect(inferRegion(ms).map((r) => r.state)).toEqual(["MO"]);
    }
  });

  it("MO ships 4 rows; RES-2000 (no revision) and RES-1020 (none banked) are held", () => {
    const mo = DEFAULT_REGISTRY.forms.filter((f) => ["mrec", "mr", "kcrar"].includes(f.publisherId)).map((f) => f.id);
    expect(mo).toEqual(["mrec-broker-disclosure", "mr-RES-1010", "mr-DSC-8000", "kcrar-sale-contract"]);
  });
});
