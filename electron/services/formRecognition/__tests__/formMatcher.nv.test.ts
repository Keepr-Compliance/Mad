/**
 * BACKLOG-4106 — Nevada controls: GLVAR (title-keyed, adjacent), SNR and NRED (title-keyed, whole
 * line). Every SYNTHETIC input is labelled; every other input is a fixture transcribed from a blank
 * form (see nvHeaders.ts).
 */
import { buildRegistry, DEFAULT_REGISTRY } from "../registry";
import { EVIDENCE_CAP, inferRegion, matchForms } from "../formMatcher";
import { GLVAR_PUBLISHER, NRED_PUBLISHER, NV_FORMS, SNR_PUBLISHER } from "../nvForms";
import type { FormMatch, TitleKeyedHeader } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import {
  NV1_GLVAR_RPA,
  NV2_GLVAR_BBA,
  NV3_GLVAR_ER,
  NV4_SNR_OAA,
  NV5_NRED_524,
  NV6_NRED_525,
  NV7_NRED_525A,
  NV8_NRED_547,
  NV9_NRED_551,
  NV10_NRED_676,
  NV_FIXTURES,
} from "./fixtures/nvHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const pin = (ms: FormMatch[]) => ms.map((m) => [m.formId, m.occurrences, m.revisionSeen]);
const dots = (n: number) => ".".repeat(n);

describe("BACKLOG-4106 GLVAR (title-keyed, adjacent) — positives", () => {
  it("RPA 10/25: every page's footer counts (11), revision captured, firstOffset at the title", () => {
    const ms = matchForms(fixtureText(NV1_GLVAR_RPA));
    expect(pin(ms)).toEqual([["glvar-rpa", 11, "10/25"]]);
    expect(ms[0]).toMatchObject({ publisherId: "glvar", code: null, kind: "purchase_agreement", strength: "footer+title", firstOffset: 0 });
    expect(ms[0].evidence).toBe("Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®");
  });

  it("BBA 01/19: the © line is on the next line and still inside the window (3 pages)", () => {
    expect(pin(matchForms(fixtureText(NV2_GLVAR_BBA)))).toEqual([["glvar-bba", 3, "01/19"]]);
  });

  it("ER 07.24: `.` revision separator; page 10 prints `© 2022` with a space — all 10 pages count", () => {
    const text = fixtureText(NV3_GLVAR_ER);
    expect(text).toContain("Page 10 of 10 © 2022 Greater");
    expect(pin(matchForms(text))).toEqual([["glvar-er", 10, "07.24"]]);
  });
});

describe("BACKLOG-4106 GLVAR — near-misses (SYNTHETIC unless noted)", () => {
  const footer = "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®";

  it("control: the footer line alone matches", () => {
    expect(ids(matchForms(footer))).toEqual(["glvar-rpa"]);
  });

  it("wrong implementation: the title inside body prose does not anchor (title must start a line)", () => {
    expect(matchForms(`See the ${footer} for details.`)).toEqual([]);
  });

  it("wrong implementation: the title without its revision does not match (F4)", () => {
    expect(matchForms("Residential Purchase Agreement ©2025 Greater Las Vegas Association of REALTORS®")).toEqual([]);
    expect(matchForms("Residential Purchase Agreement\nPage 1 of 11\n©2025 Greater Las Vegas Association of REALTORS®")).toEqual([]);
  });

  it("the title and revision without the publisher's © line do not match", () => {
    expect(matchForms("Residential Purchase Agreement Rev. 10/25\nPage 1 of 11")).toEqual([]);
  });

  it("a © line BEFORE the title does not count (windowBefore 0)", () => {
    expect(matchForms("©2025 Greater Las Vegas Association of REALTORS®\nResidential Purchase Agreement Rev. 10/25")).toEqual([]);
  });

  it("an unregistered title with the same footer grammar is invisible (registered titles only)", () => {
    expect(matchForms("Counter Offer Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®")).toEqual([]);
  });
});

describe("BACKLOG-4106 SNR (title-keyed, whole line)", () => {
  it("OAA 03/26: the title prints once (page 1); its page line carries publisher and revision", () => {
    const ms = matchForms(fixtureText(NV4_SNR_OAA));
    expect(pin(ms)).toEqual([["snr-oaa", 1, "03/26"]]);
    expect(ms[0]).toMatchObject({ kind: "purchase_agreement", firstOffset: 0 });
  });

  it("SNR page lines without the title do not match (SYNTHETIC: title taken out)", () => {
    const lines = NV4_SNR_OAA.lines.filter((l) => l !== "RESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT");
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("the title with a page line that is not SNR's does not match (SYNTHETIC)", () => {
    expect(matchForms("RESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT\nPage 1 of 12")).toEqual([]);
  });
});

describe("BACKLOG-4106 NRED (title-keyed, whole line)", () => {
  it("each NRED fixture yields its row only, with the revision as printed", () => {
    const got = [NV5_NRED_524, NV6_NRED_525, NV7_NRED_525A, NV8_NRED_547, NV9_NRED_551, NV10_NRED_676].map((f) =>
      matchForms(fixtureText(f)).map((m) => [m.formId, m.code, m.occurrences, m.revisionSeen])
    );
    expect(got).toEqual([
      [["nred-524", "524", 1, "05/01/05"]],
      [["nred-525", "525", 1, "10/03/2023"]],
      [["nred-525A", "525A", 1, "11/7/16"]],
      [["nred-547", "547", 1, "6/1/2023"]],
      [["nred-551", "551", 1, "July 1, 2010"]],
      [["nred-676", "676", 1, "04/23/2025"]],
    ]);
  });

  it("K14: 525A's 2-line title contains the 525 title — the longer title wins there (only nred-525A)", () => {
    const text = fixtureText(NV7_NRED_525A);
    expect(text).toContain("\nDUTIES OWED BY A NEVADA REAL ESTATE LICENSEE\n");
    expect(ids(matchForms(text))).toEqual(["nred-525A"]);
  });

  it("R8: TK-W is per place, not per text — a 525 block and a separate 525A block give both rows", () => {
    const text = [fixtureText(NV6_NRED_525), ...BODY, fixtureText(NV7_NRED_525A)].join("\n");
    expect(ids(matchForms(text))).toEqual(["nred-525", "nred-525A"]);
  });

  it("K13: title position is not assumed — 676's only Division marker is the letterhead 142 chars BEFORE the title", () => {
    const text = fixtureText(NV10_NRED_676);
    const [m] = matchForms(text);
    expect(m.firstOffset).toBe(194);
    expect(text.indexOf("REAL ESTATE DIVISION")).toBe(194 - 142);
    expect(text.slice(0, 194)).not.toContain("Nevada Real Estate Division");
  });

  it("K13: 524's marker and revision both print above the title", () => {
    const [m] = matchForms(fixtureText(NV5_NRED_524));
    expect(m.firstOffset).toBe(101);
    expect(m.evidence).toBe("CONSENT TO ACT");
  });

  it("R7: NRED 525 (publisher +3,557) is the first real row past the cap — evidence is 400 chars", () => {
    const [m] = matchForms(fixtureText(NV6_NRED_525));
    expect(m.evidence.length).toBe(EVIDENCE_CAP);
    expect(m.evidence.startsWith("DUTIES OWED BY A NEVADA REAL ESTATE LICENSEE")).toBe(true);
  });

  it("real margin: 525's revision ends at +3,647 of 3,800", () => {
    const t525 = fixtureText(NV6_NRED_525);
    expect(t525.indexOf("Revised 10/03/2023") + "Revised 10/03/2023".length).toBe(3647);
  });

  it("F4: the 524 block without its Revised line does not match (SYNTHETIC: line taken out)", () => {
    const lines = NV5_NRED_524.lines.filter((l) => !/^Revised /.test(l));
    expect(lines.length).toBe(NV5_NRED_524.lines.length - 1);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("the title without any Division marker does not match (SYNTHETIC: a packet cover listing the title)", () => {
    expect(matchForms(["Forms in this packet:", "CONSENT TO ACT", "Revised 05/01/05", ...BODY].join("\n"))).toEqual([]);
  });

  it("K15: the title must be a whole line, upper case as printed (SYNTHETIC)", () => {
    const tail = ["Approved Nevada Real Estate Division", "Revised 05/01/05"];
    expect(ids(matchForms(["CONSENT TO ACT", ...tail].join("\n")))).toEqual(["nred-524"]);
    expect(matchForms(["CONSENT TO ACT FORM", ...tail].join("\n"))).toEqual([]);
    expect(matchForms(["Consent to Act", ...tail].join("\n"))).toEqual([]);
    expect(matchForms(["The licensee must obtain CONSENT TO ACT from both parties.", ...tail].join("\n"))).toEqual([]);
  });

  it("`Nevada Revised Statutes` is not a revision (SYNTHETIC)", () => {
    expect(matchForms(["CONSENT TO ACT", "Approved Nevada Real Estate Division", "see Nevada Revised Statutes 645"].join("\n"))).toEqual([]);
  });
});

describe("BACKLOG-4106 K25 — NV window boundary sweeps (SYNTHETIC layouts)", () => {
  const glvarAt = (end: number) => {
    const title = "Residential Purchase Agreement Rev. 10/25";
    const marker = "©2025 Greater Las Vegas Association of REALTORS®";
    return `${title}\n${dots(end - title.length - 2 - marker.length)}\n${marker}`;
  };
  const snrAfter = (end: number) => {
    const title = "RESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT";
    const marker = "Page 1 of 12 SNR© 03/26";
    return `${title}\n${dots(end - title.length - 2 - marker.length)}\n${marker}`;
  };
  const snrBefore = (start: number) => {
    const marker = "Page 1 of 12 SNR© 03/26";
    return `${marker}\n${dots(start - marker.length - 2)}\nRESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT`;
  };
  const nredAfter = (end: number) => {
    const head = "CONSENT TO ACT\nRevised 05/01/05";
    const marker = "Approved Nevada Real Estate Division";
    return `${head}\n${dots(end - head.length - 2 - marker.length)}\n${marker}`;
  };
  const nredBefore = (start: number) => {
    // The bare name (its regex match), so the sweep measures the marker itself, not a longer line.
    const marker = "Nevada Real Estate Division";
    return `${marker}\n${dots(start - marker.length - 2)}\nCONSENT TO ACT\nRevised 05/01/05`;
  };

  it("windows are GLVAR 0/+200, SNR −120/+120, NRED −300/+3800", () => {
    expect([GLVAR_PUBLISHER, SNR_PUBLISHER, NRED_PUBLISHER].map((p) => {
      const h = p.header as TitleKeyedHeader;
      return [h.windowBefore, h.windowAfter];
    })).toEqual([[0, 200], [120, 120], [300, 3800]]);
  });

  it.each([197, 198, 199, 200])("GLVAR: © line ending at +%i matches", (end) => {
    expect(glvarAt(end).length).toBe(end);
    expect(ids(matchForms(glvarAt(end)))).toEqual(["glvar-rpa"]);
  });
  it.each([201, 202, 203])("GLVAR: © line ending at +%i does not", (end) => {
    expect(matchForms(glvarAt(end))).toEqual([]);
  });

  it.each([118, 119, 120])("SNR: page line ending at +%i matches", (end) => {
    expect(ids(matchForms(snrAfter(end)))).toEqual(["snr-oaa"]);
  });
  it.each([121, 122, 123])("SNR: page line ending at +%i does not", (end) => {
    expect(matchForms(snrAfter(end))).toEqual([]);
  });
  it.each([118, 119, 120])("SNR: page line starting %i before the title matches", (start) => {
    expect(matchForms(snrBefore(start))[0].firstOffset).toBe(start);
  });
  it.each([121, 122, 123])("SNR: page line starting %i before the title does not", (start) => {
    expect(matchForms(snrBefore(start))).toEqual([]);
  });

  it.each([3797, 3798, 3799, 3800])("NRED: Division marker ending at +%i matches", (end) => {
    expect(nredAfter(end).length).toBe(end);
    expect(ids(matchForms(nredAfter(end)))).toEqual(["nred-524"]);
  });
  it.each([3801, 3802, 3803])("NRED: Division marker ending at +%i does not", (end) => {
    expect(matchForms(nredAfter(end))).toEqual([]);
  });
  it.each([298, 299, 300])("NRED: Division marker starting %i before the title matches", (start) => {
    expect(matchForms(nredBefore(start))[0].firstOffset).toBe(start);
  });
  it.each([301, 302, 303])("NRED: Division marker starting %i before the title does not", (start) => {
    expect(matchForms(nredBefore(start))).toEqual([]);
  });
});

describe("BACKLOG-4106 NV — region and registry", () => {
  it("K24: every NV fixture infers NV only", () => {
    for (const f of NV_FIXTURES) {
      const ms = matchForms(fixtureText(f));
      expect(ms.length).toBe(1);
      expect(inferRegion(ms).map((r) => r.state)).toEqual(["NV"]);
    }
  });

  it("a bundle of every NV fixture returns all 10 rows in order", () => {
    const text = NV_FIXTURES.map(fixtureText).join("\n");
    expect(ids(matchForms(text))).toEqual(NV_FORMS.map((f) => f.id));
  });

  it("NV rows are indexed by title, not code (NRED numbers are display only)", () => {
    expect(DEFAULT_REGISTRY.byTitle.get("nred")?.map((f) => f.id)).toEqual([
      "nred-524",
      "nred-525",
      "nred-525A",
      "nred-547",
      "nred-551",
      "nred-676",
    ]);
    expect([...DEFAULT_REGISTRY.byCode.keys()].some((k) => k.startsWith("nred"))).toBe(false);
  });

  it("a registry without the NV publishers sees nothing in NV text", () => {
    const reg = buildRegistry(DEFAULT_REGISTRY.publishers.filter((p) => p.region.state !== "NV"), DEFAULT_REGISTRY.forms.filter((f) => !NV_FORMS.includes(f)));
    expect(matchForms(NV_FIXTURES.map(fixtureText).join("\n"), reg)).toEqual([]);
  });
});
