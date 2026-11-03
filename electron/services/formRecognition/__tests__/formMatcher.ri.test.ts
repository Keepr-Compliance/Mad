/**
 * BACKLOG-4106 — Rhode Island controls: the Real Estate Commission's disclosure forms and RIAR (both
 * title-keyed, whole line). Every SYNTHETIC input is labelled; every other input is a fixture
 * transcribed from a blank form (see riHeaders.ts).
 */
import { DEFAULT_REGISTRY } from "../registry";
import { inferRegion, matchForms } from "../formMatcher";
import { RI_COMMISSION_PUBLISHER, RIAR_PUBLISHER } from "../riForms";
import type { FormMatch, TitleKeyedHeader } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import { NV2_GLVAR_BBA } from "./fixtures/nvHeaders";
import {
  RI1_MRED,
  RI2_MRED_TEAM,
  RI3_RIAR_SALES_DISCLOSURE,
  RI4_RIAR_SF_PS,
  RI5_HANDOUT,
  RI_FIXTURES,
} from "./fixtures/riHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const pin = (ms: FormMatch[]) => ms.map((m) => [m.formId, m.occurrences, m.revisionSeen]);
const dots = (n: number) => ".".repeat(n);

describe("BACKLOG-4106 RI Real Estate Commission (title-keyed, whole line; revision is the gate)", () => {
  it("MRED 03/22: the revision prints just above the title (glued to the page token)", () => {
    const ms = matchForms(fixtureText(RI1_MRED));
    expect(pin(ms)).toEqual([["ri-mred", 1, "03/22"]]);
    expect(ms[0]).toMatchObject({ publisherId: "ri-commission", code: null, kind: "other", firstOffset: 22 });
  });

  it("team addendum 03/22: 2-line title, revision only on the last line (+3,626)", () => {
    const text = fixtureText(RI2_MRED_TEAM);
    expect(text.indexOf("Rev. 03/22")).toBe(3626);
    expect(pin(matchForms(text))).toEqual([["ri-mred-team", 1, "03/22"]]);
  });

  it("R3/K19: MRED with its revision lines taken out does not match — the bare draft date `3-18-22` is not a revision (SYNTHETIC)", () => {
    const lines = RI1_MRED.lines.filter((l) => !/Rev\./.test(l));
    expect(lines).toContain("3-18-22");
    expect(lines.length).toBe(RI1_MRED.lines.length - 2);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("K19: `Review`, `Revised` or `Rev.` prose with no `Rev. MM/YY` is not a revision (SYNTHETIC)", () => {
    const title = "RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE";
    expect(matchForms([title, "3-18-22", "Review this disclosure; Revised forms follow.", "Rev. draft", ...BODY].join("\n"))).toEqual([]);
    expect(ids(matchForms([title, "Rev. 03/22", ...BODY].join("\n")))).toEqual(["ri-mred"]);
  });

  it("a revision followed by more date (`Rev. 07/15/24`) is not a revision (SYNTHETIC)", () => {
    const title = "RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE";
    expect(matchForms(["Rev. 07/15/24", title, ...BODY].join("\n"))).toEqual([]);
  });

  it("the disclosure's name in prose (mixed case, mid-line) is not a title (SYNTHETIC)", () => {
    expect(matchForms("In reference to the Rhode Island Mandatory Real Estate Relationship Disclosure form, Rev. 03/22")).toEqual([]);
  });
});

describe("BACKLOG-4106 RIAR (title-keyed, whole line)", () => {
  it("Sales Disclosure 05/19: order A (`Rev 05/19 Page 1 of 6`, no dot); title on page 1 only", () => {
    const ms = matchForms(fixtureText(RI3_RIAR_SALES_DISCLOSURE));
    expect(pin(ms)).toEqual([["riar-sales-disclosure", 1, "05/19"]]);
    expect(ms[0]).toMatchObject({ publisherId: "riar", kind: "other", firstOffset: 22 });
  });

  it("Single Family P&S 01/19: order B (`Page 1 of 4Rev. 01/19`, glued)", () => {
    const ms = matchForms(fixtureText(RI4_RIAR_SF_PS));
    expect(pin(ms)).toEqual([["riar-sf-ps", 1, "01/19"]]);
    expect(ms[0].kind).toBe("purchase_agreement");
  });

  it("R9: GLVAR's page/revision lines (real, NV2) under a RIAR title, without RIAR's name, do not match", () => {
    // Recomposed: RI4 title line + NV2 lines 1-2. The page/revision guard alone accepts the GLVAR line.
    const text = ["SINGLE FAMILY PURCHASE AND SALES AGREEMENT", ...NV2_GLVAR_BBA.lines.slice(0, 2)].join("\n");
    expect(text).toContain("Buyer Brokerage Agreement Rev. 01/19 Page 1 of 3");
    expect(matchForms(text).filter((m) => m.publisherId === "riar")).toEqual([]);
  });

  it("the title and RIAR's name without a page/revision line do not match (SYNTHETIC)", () => {
    expect(matchForms("SINGLE FAMILY PURCHASE AND SALES AGREEMENT\nRhode Island Association of REALTORS®")).toEqual([]);
  });

  it("the forms handout (real negative: its title, `Rev. 07/15/24`, a heading naming a RIAR form) matches nothing", () => {
    expect(matchForms(fixtureText(RI5_HANDOUT))).toEqual([]);
  });
});

describe("BACKLOG-4106 K25 — RI window boundary sweeps (SYNTHETIC layouts)", () => {
  const MRED = "RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE";
  const PS = "SINGLE FAMILY PURCHASE AND SALES AGREEMENT";
  const NAME = "Rhode Island Association of REALTORS®";
  const commissionAfter = (end: number) => `${MRED}\n${dots(end - MRED.length - 2 - 10)}\nRev. 03/22`;
  const commissionBefore = (start: number) => `Rev. 03/22\n${dots(start - 12)}\n${MRED}`;
  const riarAfter = (end: number) => `Rev 05/19 Page 1 of 6\n${PS}\n${dots(end - PS.length - 2 - NAME.length)}\n${NAME}`;
  const riarBefore = (start: number) => `${NAME}\n${dots(start - NAME.length - 2)}\n${PS}\nRev 05/19 Page 1 of 6`;
  const firstOffset = (t: string) => matchForms(t)[0]?.firstOffset;

  it("windows are Commission −80/+3800, RIAR ±150", () => {
    expect([RI_COMMISSION_PUBLISHER, RIAR_PUBLISHER].map((p) => [(p.header as TitleKeyedHeader).windowBefore, (p.header as TitleKeyedHeader).windowAfter])).toEqual([
      [80, 3800],
      [150, 150],
    ]);
  });

  it.each([3798, 3799, 3800])("Commission: revision ending at +%i matches", (end) => {
    expect(ids(matchForms(commissionAfter(end)))).toEqual(["ri-mred"]);
  });
  it.each([3801, 3802, 3803])("Commission: revision ending at +%i does not", (end) => {
    expect(matchForms(commissionAfter(end))).toEqual([]);
  });
  it.each([78, 79, 80])("Commission: revision starting %i before the title matches", (start) => {
    expect(firstOffset(commissionBefore(start))).toBe(start);
  });
  it.each([81, 82, 83])("Commission: revision starting %i before the title does not", (start) => {
    expect(matchForms(commissionBefore(start))).toEqual([]);
  });

  it.each([148, 149, 150])("RIAR: name ending at +%i matches", (end) => {
    expect(ids(matchForms(riarAfter(end))).filter((i) => i?.startsWith("riar"))).toEqual(["riar-sf-ps"]);
  });
  it.each([151, 152, 153])("RIAR: name ending at +%i does not", (end) => {
    expect(matchForms(riarAfter(end))).toEqual([]);
  });
  it.each([148, 149, 150])("RIAR: name starting %i before the title matches", (start) => {
    expect(firstOffset(riarBefore(start))).toBe(start);
  });
  it.each([151, 152, 153])("RIAR: name starting %i before the title does not", (start) => {
    expect(matchForms(riarBefore(start))).toEqual([]);
  });
});

describe("BACKLOG-4106 RI — region and registry", () => {
  it("K24: every RI form fixture infers RI only", () => {
    for (const f of RI_FIXTURES.filter((x) => x !== RI5_HANDOUT)) {
      const ms = matchForms(fixtureText(f));
      expect(ms.length).toBe(1);
      expect(inferRegion(ms).map((r) => r.state)).toEqual(["RI"]);
    }
  });

  it("a bundle of the four forms returns all four rows in order", () => {
    const text = [RI1_MRED, RI2_MRED_TEAM, RI3_RIAR_SALES_DISCLOSURE, RI4_RIAR_SF_PS].map(fixtureText).join("\n");
    expect(ids(matchForms(text))).toEqual(["ri-mred", "ri-mred-team", "riar-sales-disclosure", "riar-sf-ps"]);
  });

  it("holds the Seller's Lead Disclosure (filled copy only): no such title row", () => {
    const riar = DEFAULT_REGISTRY.byTitle.get("riar") ?? [];
    expect(riar.map((f) => f.id)).toEqual(["riar-sales-disclosure", "riar-sf-ps"]);
  });
});
