/**
 * BACKLOG-4106 — California controls: C.A.R. (code-page + paired token) and DRE (code-page,
 * document marker). Every SYNTHETIC input is labelled; every other input is a fixture transcribed
 * from a blank form (C.A.R. fixtures keep source offsets; see caHeaders.ts).
 */
import { buildRegistry, DEFAULT_REGISTRY } from "../registry";
import { EVIDENCE_CAP, inferRegion, matchForms } from "../formMatcher";
import { CA_FORMS, CAR_PUBLISHER, DRE_PUBLISHER } from "../caForms";
import { NWMLS_PUBLISHER } from "../publishers";
import type { CodePageHeader, FormMatch, FormRow, PublisherRow } from "../formRegistryTypes";
import { BODY, fixtureText } from "./fixtures/nwmlsHeaders";
import { CA1_RPA, CA2_AD, CA2_BRBC, CA2_PACKET, CA3_AD, CA3_BRBC, CA4_RE882, CA_FIXTURES } from "./fixtures/caHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const car = CAR_PUBLISHER.header as CodePageHeader;

describe("BACKLOG-4106 C.A.R. — positives", () => {
  it("R1 pin: RPA 12/22 counts the 7 of 16 pages whose paired token lies in the window", () => {
    const text = fixtureText(CA1_RPA);
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["car-RPA"]);
    expect(ms[0]).toMatchObject({
      publisherId: "car",
      code: "RPA",
      kind: "purchase_agreement",
      strength: "footer+title",
      occurrences: 7,
      revisionSeen: "12/22",
    });
  });

  it("K2: firstOffset skips the glued SAMPLE watermark (page 1 is `SAMPLERPA …`)", () => {
    const text = fixtureText(CA1_RPA);
    expect(text.startsWith("SAMPLERPA REVISED 12/22 (PAGE 1 OF 16)")).toBe(true);
    const [m] = matchForms(text);
    expect(m.firstOffset).toBe(6);
    expect(m.evidence.startsWith("RPA REVISED 12/22 (PAGE 1 OF 16)")).toBe(true);
  });

  it("K3: BRBC 12/24 — initials glued after the page token; all 5 pages", () => {
    const text = fixtureText(CA2_BRBC);
    expect(text).toContain("(PAGE 1 OF 5) Buyer's Initials");
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["car-BRBC"]);
    expect(ms[0]).toMatchObject({ kind: "buyer_agreement", occurrences: 5, revisionSeen: "12/24" });
  });

  it("BRBC 12/25 — all 5 pages", () => {
    const ms = matchForms(fixtureText(CA3_BRBC));
    expect(ids(ms)).toEqual(["car-BRBC"]);
    expect(ms[0]).toMatchObject({ occurrences: 5, revisionSeen: "12/25" });
  });

  it("AD (12/24 packet): both pages pair", () => {
    const ms = matchForms(fixtureText(CA2_AD));
    expect(ids(ms)).toEqual(["car-AD"]);
    expect(ms[0].occurrences).toBe(2);
  });

  it("R1 pin: AD (12/25 packet) — page 1's token is ABOVE its code line and pairs; page 2's is ~6,200 chars away and does not", () => {
    const ms = matchForms(fixtureText(CA3_AD));
    expect(ids(ms)).toEqual(["car-AD"]);
    expect(ms[0].occurrences).toBe(1);
  });

  it("the 12/24 packet returns every C.A.R. form, unregistered codes as ?code", () => {
    const ms = matchForms(fixtureText(CA2_PACKET));
    expect(ms.map((m) => [m.formId ?? `?${m.code}`, m.occurrences, m.revisionSeen])).toEqual([
      ["car-AD", 2, "12/24"],
      ["car-BRBC", 5, "12/24"],
      ["?BIA", 2, "12/21"],
      ["?BCA", 2, "7/24"],
      ["?PRBS", 1, "12/21"],
      ["?CCPA", 1, "12/22"],
    ]);
    expect(ms.filter((m) => m.formId === null).every((m) => m.kind === null)).toBe(true);
  });

  it("K8: revision is captured, never keyed — the 12/24 and 12/25 BRBC give one form", () => {
    const text = [CA2_BRBC, CA3_BRBC].map(fixtureText).join("\n");
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["car-BRBC"]);
    expect(ms[0]).toMatchObject({ occurrences: 10, revisionSeen: "12/24" });
  });
});

describe("BACKLOG-4106 C.A.R. — near-misses (SYNTHETIC)", () => {
  const CODE = "BRBC REVISED 12/24 (PAGE 1 OF 5)";
  const TOKEN = "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 1 OF 5)";

  it("control: code line + its token match", () => {
    expect(ids(matchForms([CODE, TOKEN, ...BODY].join("\n")))).toEqual(["car-BRBC"]);
  });

  it("K6: a code line without its paired token does not match", () => {
    expect(matchForms([CODE, ...BODY].join("\n"))).toEqual([]);
  });

  it("wrong implementation: another form's token does not pair (`(AD PAGE …)` never proves BRBC)", () => {
    expect(matchForms([CODE, "(AD PAGE 1 OF 2)", ...BODY].join("\n"))).toEqual([]);
  });

  it("a longer code's token does not prove a shorter code (`(RPA PAGE …)` never proves PA)", () => {
    expect(matchForms(["PA REVISED 12/22 (PAGE 1 OF 16)", "(RPA PAGE 1 OF 16)", ...BODY].join("\n"))).toEqual([]);
  });

  it("K1: a code-page line that does not start the line is not a code line", () => {
    expect(matchForms([`Buyer to sign ${CODE}`, TOKEN, ...BODY].join("\n"))).toEqual([]);
  });

  it("the code must be printed in upper case", () => {
    expect(matchForms(["brbc revised 12/24 (page 1 of 5)", "(brbc page 1 of 5)", ...BODY].join("\n"))).toEqual([]);
  });

  it("K5: REVISED and OF are matched in any case; brackets on the token are optional", () => {
    const text = ["RPA Revised 6/22 (PAGE 10 of 10)", "RIPA PAGE 1 OF 12 / RPA PAGE 10 of 10", ...BODY].join("\n");
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["car-RPA"]);
    expect(ms[0].revisionSeen).toBe("6/22");
  });

  it("K4: the page total is never a key — totals 10, 16 and 17 give one form", () => {
    const page = (n: number, total: number) => [
      `RPA REVISED 12/22 (PAGE ${n} OF ${total})`,
      `CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE ${n} OF ${total})`,
      ...BODY,
    ];
    const ms = matchForms([...page(1, 10), ...page(2, 16), ...page(3, 17)].join("\n"));
    expect(ids(ms)).toEqual(["car-RPA"]);
    expect(ms[0].occurrences).toBe(3);
  });

  describe("K7: RPA-CA is its own code, never RPA", () => {
    const RPA_CA = ["RPA-CA REVISED 12/15 (PAGE 1 OF 10)", "(RPA-CA PAGE 1 OF 10)", ...BODY].join("\n");

    it("the default registry reports it as unregistered ?RPA-CA (the row is held)", () => {
      expect(ids(matchForms(RPA_CA))).toEqual(["?RPA-CA"]);
    });

    it("with an RPA-CA row (built in-test), RPA-CA matches it and RPA 12/22 still matches car-RPA only", () => {
      const rpaCa: FormRow = {
        id: "car-RPA-CA",
        publisherId: "car",
        code: "RPA-CA",
        kind: "purchase_agreement",
        knownTitles: [],
        observedRevisions: [],
        sampleProvenance: ["synthetic"],
      };
      const reg = buildRegistry([CAR_PUBLISHER, DRE_PUBLISHER], [...CA_FORMS, rpaCa]);
      expect(ids(matchForms(RPA_CA, reg))).toEqual(["car-RPA-CA"]);
      expect(ids(matchForms(fixtureText(CA1_RPA), reg))).toEqual(["car-RPA"]);
    });
  });
});

describe("BACKLOG-4106 K25 — C.A.R. window boundary sweep (SYNTHETIC layouts)", () => {
  const registry = buildRegistry([CAR_PUBLISHER], CA_FORMS.filter((f) => f.publisherId === "car"));
  const CODE = "AD REVISED 12/24 (PAGE 1 OF 2)";
  // The token's brackets are optional, so its bracket-less core is what must lie in the window;
  // the sweep uses the core so the boundary is exact.
  const TOKEN = "AD PAGE 1 OF 2";

  it("window is −200/+300", () => {
    expect([car.windowBefore, car.windowAfter]).toEqual([200, 300]);
  });

  it.each([297, 298, 299, 300, 301, 302, 303])("token ending at +%i", (end) => {
    const fill = end - CODE.length - 1 - TOKEN.length - 1;
    const text = `${CODE}\n${".".repeat(fill)}\n${TOKEN}\n`;
    expect(ids(matchForms(text, registry))).toEqual(end <= 300 ? ["car-AD"] : []);
  });

  it.each([197, 198, 199, 200, 201, 202, 203])("token starting at −%i", (start) => {
    const fill = start - TOKEN.length - 2;
    const text = `${TOKEN}\n${".".repeat(fill)}\n${CODE}\n`;
    expect(ids(matchForms(text, registry))).toEqual(start <= 200 ? ["car-AD"] : []);
  });
});

describe("BACKLOG-4106 DRE (code-page, document marker)", () => {
  it("RE 882: all 3 pages; revision printed on page 1 only, found document-wide and required", () => {
    const ms = matchForms(fixtureText(CA4_RE882));
    expect(ids(ms)).toEqual(["dre-RE882"]);
    expect(ms[0]).toMatchObject({ publisherId: "dre", code: "882", kind: "other", occurrences: 3, revisionSeen: "10/10" });
  });

  it("K17: without the department's name anywhere in the text, no match", () => {
    const lines = CA4_RE882.lines.filter((l) => !/EPARTMENT OF REAL ESTATE/.test(l));
    expect(lines.length).toBe(CA4_RE882.lines.length - 1);
    expect(matchForms(lines.join("\n"))).toEqual([]);
  });

  it("inner pages plus a prose mention of the department, with no revision line, do not match (SYNTHETIC)", () => {
    const text = [
      "The Department of Real Estate publishes a mortgage loan disclosure statement for brokers.",
      "RE 882 \u2014 Page 2 of 3",
      "Page 3 of 3",
      ...BODY,
    ].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("an unregistered DRE code is dropped, not reported (SYNTHETIC)", () => {
    const text = [CA4_RE882.lines[1], "RE 851 (Rev. 10/10)", ...BODY].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("a mid-line reference to RE 882 is not a code line (SYNTHETIC)", () => {
    const text = [CA4_RE882.lines[1], "A broker must provide a RE 882 (Rev. 10/10) before signing.", ...BODY].join("\n");
    expect(matchForms(text)).toEqual([]);
  });
});

describe("BACKLOG-4106 CA — region, evidence, cap", () => {
  it("K24: C.A.R. and DRE forms infer CA", () => {
    const text = [CA1_RPA, CA4_RE882].map(fixtureText).join("\n");
    expect(inferRegion(matchForms(text))).toEqual([
      { state: "CA", publisherId: "car", forms: 1 },
      { state: "CA", publisherId: "dre", forms: 1 },
    ]);
  });

  it.each(CA_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: evidence is a verbatim slice at firstOffset, at most EVIDENCE_CAP",
    (_id, fx) => {
      const text = fixtureText(fx);
      const ms = matchForms(text);
      expect(ms.length).toBeGreaterThan(0);
      for (const m of ms) {
        expect(m.evidence.length).toBeGreaterThan(0);
        expect(m.evidence.length).toBeLessThanOrEqual(EVIDENCE_CAP);
        expect(text.slice(m.firstOffset, m.firstOffset + m.evidence.length)).toBe(m.evidence);
      }
    }
  );

  it("R7: evidence is capped at 400 chars even when the window is wider (SYNTHETIC publisher, marker at +600)", () => {
    const wide: PublisherRow = {
      ...CAR_PUBLISHER,
      id: "wide",
      header: { ...car, pairedToken: undefined, requiredMarkers: [/END MARKER/], windowAfter: 1000 },
    };
    const reg = buildRegistry([wide], []);
    const text = `AD REVISED 12/24 (PAGE 1 OF 2)\n${".".repeat(600)}\nEND MARKER\n`;
    const [m] = matchForms(text, reg);
    expect(m.code).toBe("AD");
    expect(m.evidence.length).toBe(EVIDENCE_CAP);
    expect(EVIDENCE_CAP).toBe(400);
  });

  it("the NWMLS publisher is untouched by v2 (still the code-line model)", () => {
    expect(NWMLS_PUBLISHER.header.kind).toBeUndefined();
    expect(DEFAULT_REGISTRY.publishers[0]).toBe(NWMLS_PUBLISHER);
  });
});

describe("BACKLOG-4106 declared revision (SYNTHETIC publisher with a separate revision marker)", () => {
  const base: CodePageHeader = {
    kind: "code-page",
    codePage: /^ZZ (\d{3}) Page \d+ of \d+/gm,
    requiredMarkers: [/ZZ Publisher/],
    revision: /Edition (\d{4})/,
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 200,
    reportUnregistered: true,
  };
  const pub = (h: Partial<CodePageHeader>): PublisherRow => ({
    id: "zz",
    name: "ZZ",
    namePattern: /ZZ Publisher/,
    region: { country: "US", state: "ZZ" },
    header: { ...base, ...h },
  });

  it("gate: no revision in the window -> no match", () => {
    const reg = buildRegistry([pub({})], []);
    expect(matchForms("ZZ 101 Page 1 of 2\nZZ Publisher\n", reg)).toEqual([]);
    expect(matchForms("ZZ 101 Page 1 of 2\nZZ Publisher Edition 2024\n", reg)[0].revisionSeen).toBe("2024");
  });

  it("F4: capture-only (revisionRequired false) is rejected at load", () => {
    expect(() => buildRegistry([pub({ revisionRequired: false })], [])).toThrow(/form registry/);
  });

  it("document scope: the revision may sit anywhere in the text", () => {
    const reg = buildRegistry([pub({ revisionScope: "document" })], []);
    const text = `Edition 2023\n${".".repeat(500)}\nZZ 101 Page 1 of 2\nZZ Publisher\n`;
    expect(matchForms(text, reg)[0].revisionSeen).toBe("2023");
  });
});
