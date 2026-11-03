/**
 * BACKLOG-4106 — Rhode Island controls: RIAR (title-keyed, whole line) and the held Real Estate
 * Commission disclosure forms (negative pins). Every SYNTHETIC input is labelled; every other input is a fixture
 * transcribed from a blank form (see riHeaders.ts).
 */
import { DEFAULT_REGISTRY } from "../registry";
import { inferRegion, matchForms } from "../formMatcher";
import { RIAR_PUBLISHER } from "../riForms";
import type { FormMatch, TitleKeyedHeader } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import { NV2_GLVAR_BBA } from "./fixtures/nvHeaders";
import {
  RI1_MRED,
  RI2_MRED_TEAM,
  RI3_RIAR_SALES_DISCLOSURE,
  RI4_RIAR_SF_PS,
  RI5_HANDOUT,
} from "./fixtures/riHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const pin = (ms: FormMatch[]) => ms.map((m) => [m.formId, m.occurrences, m.revisionSeen]);
const dots = (n: number) => ".".repeat(n);

describe("BACKLOG-4106 RI Real Estate Commission rows are held (no publisher or © line printed)", () => {
  it("the relationship disclosure blank returns no output at all", () => {
    const text = fixtureText(RI1_MRED);
    expect(text).toContain("Rev. 03/22");
    expect(matchForms(text)).toEqual([]);
  });

  it("the team addendum blank returns no output at all", () => {
    const text = fixtureText(RI2_MRED_TEAM);
    expect(text.indexOf("Rev. 03/22")).toBe(3626);
    expect(matchForms(text)).toEqual([]);
  });

  it("neither the publisher nor either row is in the default registry", () => {
    expect(DEFAULT_REGISTRY.publishers.map((p) => p.id)).not.toContain("ri-commission");
    expect(DEFAULT_REGISTRY.forms.map((f) => f.id)).not.toEqual(expect.arrayContaining(["ri-mred"]));
    expect(DEFAULT_REGISTRY.forms.map((f) => f.id)).not.toEqual(expect.arrayContaining(["ri-mred-team"]));
  });

  it("a title with a nearby revision and no publisher line matches nothing (SYNTHETIC packet index)", () => {
    const title = "RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE";
    expect(matchForms([title, "Packet checklist", "Packet checklist Rev. 01/24", ...BODY].join("\n"))).toEqual([]);
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

describe("BACKLOG-4106 K25 — RIAR window boundary sweeps (SYNTHETIC layouts)", () => {
  const PS = "SINGLE FAMILY PURCHASE AND SALES AGREEMENT";
  const NAME = "Rhode Island Association of REALTORS®";
  const riarAfter = (end: number) => `Rev 05/19 Page 1 of 6\n${PS}\n${dots(end - PS.length - 2 - NAME.length)}\n${NAME}`;
  const riarBefore = (start: number) => `${NAME}\n${dots(start - NAME.length - 2)}\n${PS}\nRev 05/19 Page 1 of 6`;
  const firstOffset = (t: string) => matchForms(t)[0]?.firstOffset;

  it("window is RIAR ±150", () => {
    const h = RIAR_PUBLISHER.header as TitleKeyedHeader;
    expect([h.windowBefore, h.windowAfter]).toEqual([150, 150]);
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
  it("K24: every shipped RI form fixture infers RI only", () => {
    for (const f of [RI3_RIAR_SALES_DISCLOSURE, RI4_RIAR_SF_PS]) {
      const ms = matchForms(fixtureText(f));
      expect(ms.length).toBe(1);
      expect(inferRegion(ms).map((r) => r.state)).toEqual(["RI"]);
    }
  });

  it("a bundle of the four blanks returns the two RIAR rows in order (the Commission pair is held)", () => {
    const text = [RI1_MRED, RI2_MRED_TEAM, RI3_RIAR_SALES_DISCLOSURE, RI4_RIAR_SF_PS].map(fixtureText).join("\n");
    expect(ids(matchForms(text))).toEqual(["riar-sales-disclosure", "riar-sf-ps"]);
  });

  it("holds the Seller's Lead Disclosure (filled copy only): no such title row", () => {
    const riar = DEFAULT_REGISTRY.byTitle.get("riar") ?? [];
    expect(riar.map((f) => f.id)).toEqual(["riar-sales-disclosure", "riar-sf-ps"]);
  });
});
