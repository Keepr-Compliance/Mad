/**
 * BACKLOG-4106 — Arizona controls: Arizona REALTORS® and Phoenix REALTORS® (both title-keyed,
 * adjacent). Every SYNTHETIC input is labelled; every other input is a fixture transcribed from a
 * blank form (see azHeaders.ts).
 */
import { DEFAULT_REGISTRY } from "../registry";
import { inferRegion, matchForms } from "../formMatcher";
import { AAR_PUBLISHER, PAR_PUBLISHER } from "../azForms";
import type { FormMatch, TitleKeyedHeader } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import { AZ5_AAR_RPC, AZ6_AAR_BBEEA, AZ7_PAR_RPC, AZ_FIXTURES } from "./fixtures/azHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const pin = (ms: FormMatch[]) => ms.map((m) => [m.formId, m.occurrences, m.revisionSeen]);
const dots = (n: number) => ".".repeat(n);
const AAR_COPY = "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.";

describe("BACKLOG-4106 Arizona REALTORS® (title-keyed, adjacent) — positives", () => {
  it("RPC Aug 2024: 10 pages; the `… Contract >>` lines and the cover's own title do not count", () => {
    const text = fixtureText(AZ5_AAR_RPC);
    expect(text).toContain("Residential Resale Real Estate Purchase Contract >>");
    expect(text.startsWith("Buyer Attachment • Updated: August 2024")).toBe(true);
    const ms = matchForms(text);
    expect(pin(ms)).toEqual([["aar-rpc", 10, "August 2024"]]);
    expect(ms[0]).toMatchObject({ publisherId: "aar", code: null, kind: "purchase_agreement", strength: "footer+title" });
    expect(ms[0].evidence).toBe(`Residential Resale Real Estate Purchase Contract • Updated: August 2024\n${AAR_COPY}`);
  });

  it("BBEEA Aug 2024: one-line footer with no `Updated:` (3 pages)", () => {
    const ms = matchForms(fixtureText(AZ6_AAR_BBEEA));
    expect(pin(ms)).toEqual([["aar-bbeea", 3, "August 2024"]]);
    expect(ms[0].kind).toBe("buyer_agreement");
  });
});

describe("BACKLOG-4106 Arizona REALTORS® — near-misses (SYNTHETIC unless noted)", () => {
  const title = "Residential Resale Real Estate Purchase Contract • Updated: August 2024";

  it("control: title line + © line match", () => {
    expect(ids(matchForms(`${title}\n${AAR_COPY}`))).toEqual(["aar-rpc"]);
  });

  it("K18: the © line with a space before the full stop, or broken across lines, still matches", () => {
    expect(ids(matchForms(`${title}\nCopyright © 2024 Arizona Association of REALTORS® . All rights reserved.`))).toEqual(["aar-rpc"]);
    expect(ids(matchForms(`${title}\nCopyright © 2024 Arizona Association of\nREALTORS®. All rights reserved.`))).toEqual(["aar-rpc"]);
  });

  it("real lines: the continuation line (`… Contract >>`, no revision) with the © line does not match", () => {
    // AZ5 lines 139 and 137, recomposed: the title is there, the revision is not (F4).
    expect(matchForms(`Residential Resale Real Estate Purchase Contract >>\n${AAR_COPY}\nPage 2 of 10`)).toEqual([]);
  });

  it("wrong implementation: the title inside body prose does not anchor", () => {
    expect(matchForms(`This Buyer-Broker Exclusive Employment Agreement • August 2024 • ${AAR_COPY}`)).toEqual([]);
  });

  it("title and revision without the © line do not match", () => {
    expect(matchForms(`${title}\nPage 1 of 10`)).toEqual([]);
  });

  it("an unregistered AAR title with the same grammar is invisible (the RPC cover page)", () => {
    expect(matchForms(`Buyer Attachment • Updated: August 2024\n${AAR_COPY}`)).toEqual([]);
  });
});

describe("BACKLOG-4106 Phoenix REALTORS® (title-keyed, adjacent, document marker)", () => {
  it("RPC Dec. 2024: all 12 pages", () => {
    const ms = matchForms(fixtureText(AZ7_PAR_RPC));
    expect(pin(ms)).toEqual([["par-rpc", 12, "Dec. 2024"]]);
    expect(ms[0]).toMatchObject({ publisherId: "par", kind: "purchase_agreement", firstOffset: 0 });
  });

  it("K17: without the Phoenix REALTORS® © line anywhere in the text, no match (SYNTHETIC: line taken out)", () => {
    const lines = AZ7_PAR_RPC.lines.filter((l) => !/Phoenix REALTORS/.test(l));
    expect(lines.length).toBe(AZ7_PAR_RPC.lines.length - 1);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("the revision must be printed as `Mon. YYYY` before the page token (SYNTHETIC)", () => {
    const copy = "RESIDENTIAL RESALE PURCHASE CONTRACTNOT INTENDED FOR USEEXAMPLE FORMSCopyright © Phoenix REALTORS® All Rights Reserved.";
    expect(ids(matchForms(`Residential Resale Purchase Contract - Dec. 2024 Page 1 of 12\n${copy}`))).toEqual(["par-rpc"]);
    expect(matchForms(`Residential Resale Purchase Contract - December 2024 Page 1 of 12\n${copy}`)).toEqual([]);
    expect(matchForms(`Residential Resale Purchase Contract Page 1 of 12\n${copy}`)).toEqual([]);
  });
});

describe("BACKLOG-4106 K25 — AZ window boundary sweeps (SYNTHETIC layouts)", () => {
  const title = "Residential Resale Real Estate Purchase Contract • Updated: August 2024";
  const after = (end: number) => `${title}\n${dots(end - title.length - 2 - AAR_COPY.length)}\n${AAR_COPY}`;
  const before = (start: number) => `${AAR_COPY}\n${dots(start - AAR_COPY.length - 2)}\n${title}`;

  it("windows are AAR 0/+300, PAR 0/+100", () => {
    expect([AAR_PUBLISHER, PAR_PUBLISHER].map((p) => [(p.header as TitleKeyedHeader).windowBefore, (p.header as TitleKeyedHeader).windowAfter])).toEqual([
      [0, 300],
      [0, 100],
    ]);
  });

  it.each([297, 298, 299, 300])("AAR: © line ending at +%i matches", (end) => {
    expect(after(end).length).toBe(end);
    expect(ids(matchForms(after(end)))).toEqual(["aar-rpc"]);
  });
  it.each([301, 302, 303])("AAR: © line ending at +%i does not", (end) => {
    expect(matchForms(after(end))).toEqual([]);
  });
  it.each([74, 100, 300])("AAR: a © line ending %i chars above the title does not count (windowBefore 0)", (start) => {
    expect(matchForms(before(start))).toEqual([]);
  });
});

describe("BACKLOG-4106 AZ — region and registry", () => {
  it("K24: every AZ fixture infers AZ only", () => {
    for (const f of AZ_FIXTURES) {
      const ms = matchForms(fixtureText(f));
      expect(ms.length).toBe(1);
      expect(inferRegion(ms).map((r) => r.state)).toEqual(["AZ"]);
    }
  });

  it("the two RPC titles never cross: AAR text gives aar-rpc only, PAR text par-rpc only", () => {
    const text = [fixtureText(AZ5_AAR_RPC), ...BODY, fixtureText(AZ7_PAR_RPC)].join("\n");
    expect(ids(matchForms(text))).toEqual(["aar-rpc", "par-rpc"]);
  });

  it("holds the regulator's title-only rows: no adre publisher", () => {
    expect(DEFAULT_REGISTRY.publishers.map((p) => p.id)).not.toContain("adre");
  });
});
