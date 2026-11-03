/**
 * BACKLOG-3941 — registry rows and validation. Every shipped row must be proven by at least one
 * fixture transcribed from a blank copy, and that fixture must match exactly that row.
 */
import { buildRegistry, DEFAULT_REGISTRY } from "../registry";
import { matchForms } from "../formMatcher";
import { NWMLS_FORMS } from "../nwmlsForms";
import { NWMLS_PUBLISHER } from "../publishers";
import type { FormRow, PublisherRow } from "../formRegistryTypes";
import { ALL_FIXTURES, fixtureText } from "./fixtures/nwmlsHeaders";
import { OR_FORMS, OREF_PUBLISHER, ORR_PUBLISHER } from "../orForms";
import { CA_FORMS, CAR_PUBLISHER, DRE_PUBLISHER } from "../caForms";
import { OR_FIXTURES } from "./fixtures/orHeaders";
import { CA_FIXTURES } from "./fixtures/caHeaders";
import type { CodePageHeader, MidLineHeader, TitleKeyedHeader } from "../formRegistryTypes";
import { NV_FORMS } from "../nvForms";
import { NV_FIXTURES } from "./fixtures/nvHeaders";
import { AZ_FORMS } from "../azForms";
import { AZ_FIXTURES } from "./fixtures/azHeaders";

// BACKLOG-4106 PR 2: NV, AZ, RI and MO publishers and rows, in registry order.
const PR2_PUBLISHERS = ["glvar", "snr", "nred", "aar", "par"];
const PR2_TITLE_PUBLISHERS = ["glvar", "snr", "nred", "aar", "par"];
const PR2_ROWS = [...NV_FORMS, ...AZ_FORMS];
const PR2_FORMS = PR2_ROWS.map((f) => f.id);
const PR2_FIXTURES = [...NV_FIXTURES, ...AZ_FIXTURES];

describe("BACKLOG-3941 default registry", () => {
  it("ships eight NWMLS rows in priority order (main transaction forms first)", () => {
    // BACKLOG-4106: the default registry now also holds OR and CA rows; this pin is the NWMLS slice.
    expect(DEFAULT_REGISTRY.forms.filter((f) => f.publisherId === "nwmls").map((f) => f.id)).toEqual([
      "nwmls-21",
      "nwmls-41",
      "nwmls-1A",
      "nwmls-36",
      "nwmls-1A-SWF",
      "nwmls-41C",
      "nwmls-36A",
      "nwmls-54",
    ]);
  });

  it("holds Forms 53 and plain 1B (no blank copy)", () => {
    const codes = DEFAULT_REGISTRY.forms.map((f) => f.code);
    expect(codes).not.toContain("53");
    expect(codes).not.toContain("1B");
  });

  describe.each(NWMLS_FORMS.map((f) => [f.id, f] as const))("%s", (_id, row) => {
    it.each(row.sampleProvenance.map((p) => [p]))("is proven by fixture %s", (fixtureId) => {
      const fx = ALL_FIXTURES.find((f) => f.id === fixtureId);
      expect(fx).toBeDefined();
      const ms = matchForms(fixtureText(fx!));
      expect(ms.map((m) => m.formId)).toEqual([row.id]);
      expect(ms[0].kind).toBe(row.kind);
    });
  });
});

describe("BACKLOG-3941 buildRegistry validation", () => {
  const row = (over: Partial<FormRow>): FormRow => ({
    id: "nwmls-x",
    publisherId: "nwmls",
    code: "99",
    kind: "other",
    knownTitles: [],
    observedRevisions: [],
    sampleProvenance: ["synthetic"],
    ...over,
  });

  it("accepts the default rows", () => {
    expect(() => buildRegistry([NWMLS_PUBLISHER], NWMLS_FORMS)).not.toThrow();
  });

  it.each<[string, FormRow[]]>([
    ["duplicate form id", [row({}), row({ code: "98" })]],
    ["duplicate code", [row({}), row({ id: "nwmls-y" })]],
    ["unknown publisher", [row({ publisherId: "nope" })]],
    ["missing code for a code-line publisher", [row({ code: undefined })]],
    ["no sample provenance", [row({ sampleProvenance: [] })]],
  ])("rejects %s", (_name, forms) => {
    expect(() => buildRegistry([NWMLS_PUBLISHER], forms)).toThrow(/form registry/);
  });

  it("rejects a duplicate publisher id", () => {
    expect(() => buildRegistry([NWMLS_PUBLISHER, NWMLS_PUBLISHER], [])).toThrow(/form registry/);
  });

  it("the types permit a title-keyed publisher and row (no code line, no code)", () => {
    // Type-level only: no title-keyed matching is implemented or exercised.
    const pub: PublisherRow = {
      id: "title-keyed",
      name: "Title-keyed publisher",
      namePattern: /Title-keyed/,
      region: { country: "US", state: "NV" },
      header: { requiredMarkers: [], revision: /Rev\.\s*(\d{1,2}\/\d{2})/, windowChars: 400 },
    };
    const form: FormRow = {
      id: "title-keyed-1",
      publisherId: "title-keyed",
      kind: "purchase_agreement",
      knownTitles: [/Purchase\s+Agreement/],
      observedRevisions: [],
      sampleProvenance: ["synthetic"],
    };
    expect(() => buildRegistry([pub], [form])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// BACKLOG-4106 — registry v2 (marker kinds; OR and CA rows)
// ---------------------------------------------------------------------------------------------

describe("BACKLOG-4106 default registry v2", () => {
  it("ships NWMLS, then OR (8 OREF + 6 Oregon REALTORS), then CA (3 C.A.R. + 1 DRE), then the PR 2 states", () => {
    expect(DEFAULT_REGISTRY.publishers.map((p) => p.id)).toEqual(["nwmls", "oref", "orr", "car", "dre", ...PR2_PUBLISHERS]);
    expect(DEFAULT_REGISTRY.forms.filter((f) => f.publisherId !== "nwmls").map((f) => f.id)).toEqual([
      "oref-001",
      "oref-003",
      "oref-004",
      "oref-015",
      "oref-050",
      "oref-052",
      "oref-057",
      "oref-009",
      "orr-1.1",
      "orr-2.1",
      "orr-9.3",
      "orr-9.4",
      "orr-3.1",
      "orr-10.4",
      "car-RPA",
      "car-BRBC",
      "car-AD",
      "dre-RE882",
      ...PR2_FORMS,
    ]);
  });

  it("holds the rows the founder held (demo-only CA sources, OCR-only SFAR, title-only rows)", () => {
    const codes = DEFAULT_REGISTRY.forms.map((f) => f.code);
    for (const held of ["RPA-CA", "RLA", "TDS", "SPQ", "SBSA"]) expect(codes).not.toContain(held);
    const pubs = DEFAULT_REGISTRY.publishers.map((p) => p.id);
    expect(pubs).not.toContain("sfar");
    expect(pubs).not.toContain("orea");
  });

  it("F1: every title-keyed publisher's rows are indexed by title (the matcher handles the kind)", () => {
    const tkPubs = DEFAULT_REGISTRY.publishers.filter((p) => p.header.kind === "title-keyed").map((p) => p.id);
    expect([...DEFAULT_REGISTRY.byTitle.keys()]).toEqual(tkPubs);
    expect(tkPubs).toEqual(PR2_TITLE_PUBLISHERS);
  });

  const v2Fixtures = [...OR_FIXTURES, ...CA_FIXTURES, ...PR2_FIXTURES];
  describe.each([...OR_FORMS, ...CA_FORMS, ...PR2_ROWS].map((f) => [f.id, f] as const))("%s", (_id, row) => {
    it.each(row.sampleProvenance.map((p) => [p]))("is proven by fixture %s", (fixtureId) => {
      const fx = v2Fixtures.find((f) => f.id === fixtureId);
      expect(fx).toBeDefined();
      const ms = matchForms(fixtureText(fx!));
      expect(ms.map((m) => m.formId)).toEqual([row.id]);
      expect(ms[0].kind).toBe(row.kind);
    });
  });
});

describe("BACKLOG-4106 buildRegistry v2 checks", () => {
  const cp = (over: Partial<CodePageHeader> = {}): PublisherRow => ({
    ...CAR_PUBLISHER,
    id: "cp",
    header: { ...(CAR_PUBLISHER.header as CodePageHeader), ...over },
  });
  const ml = (over: Partial<MidLineHeader> = {}): PublisherRow => ({
    ...OREF_PUBLISHER,
    id: "ml",
    header: { ...(OREF_PUBLISHER.header as MidLineHeader), ...over },
  });
  const tkHeader: TitleKeyedHeader = {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [],
    revision: /Rev\. (\d{2}\/\d{2})/,
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 400,
  };
  const tk = (over: Partial<TitleKeyedHeader> = {}): PublisherRow => ({
    id: "tk",
    name: "Title-keyed (synthetic)",
    namePattern: /Synthetic/,
    region: { country: "US", state: "NV" },
    header: { ...tkHeader, ...over },
  });
  const form = (over: Partial<FormRow>): FormRow => ({
    id: "f",
    publisherId: "cp",
    code: "XX",
    kind: "other",
    knownTitles: [],
    observedRevisions: [],
    sampleProvenance: ["synthetic"],
    ...over,
  });
  const twoLine = /FIRST TITLE LINE\nSECOND TITLE LINE/;

  it("accepts the default v2 publishers and rows", () => {
    expect(() =>
      buildRegistry([NWMLS_PUBLISHER, OREF_PUBLISHER, ORR_PUBLISHER, CAR_PUBLISHER, DRE_PUBLISHER], [
        ...NWMLS_FORMS,
        ...OR_FORMS,
        ...CA_FORMS,
      ])
    ).not.toThrow();
  });

  it("accepts a valid title-keyed publisher and indexes its rows by title", () => {
    const reg = buildRegistry([tk()], [form({ publisherId: "tk", code: undefined, titleKey: [twoLine] })]);
    expect(reg.byTitle.get("tk")?.map((f) => f.id)).toEqual(["f"]);
    expect(reg.byCode.size).toBe(0);
  });

  it.each<[string, PublisherRow[], FormRow[]]>([
    ["1: a code-page row without a code", [cp()], [form({ code: undefined })]],
    ["1: a mid-line row without a code", [ml()], [form({ publisherId: "ml", code: undefined })]],
    ["2: a title-keyed row without a titleKey", [tk()], [form({ publisherId: "tk", code: undefined })]],
    [
      "3: two rows of one publisher with the same titleKey",
      [tk()],
      [
        form({ id: "a", publisherId: "tk", titleKey: [twoLine] }),
        form({ id: "b", publisherId: "tk", titleKey: [twoLine] }),
      ],
    ],
    ["4: an adjacent anchorTemplate without {title}", [tk({ placement: "adjacent", anchorTemplate: "Rev\\. (?<rev>\\d{2})" })], []],
    ["4: an adjacent header without an anchorTemplate", [tk({ placement: "adjacent" })], []],
    ["5: a mid-line marker anchored with ^", [ml({ marker: /^OREF (\d{3}) \| Released (\d{2}\/\d{4})/g })], []],
    ["5: a mid-line marker anchored with $", [ml({ marker: /OREF (\d{3}) \| Released (\d{2}\/\d{4})$/g })], []],
    ["7: windowAfter 0", [cp({ windowAfter: 0 })], []],
    ["7: windowBefore negative", [cp({ windowBefore: -1 })], []],
    ["8: a codePage without the m flag", [cp({ codePage: /^(RPA) (\d{1,2}\/\d{2})/g })], []],
    ["9: a code-page publisher with no publisher proof", [cp({ pairedToken: undefined })], []],
    ["9: a mid-line publisher with no publisher proof", [ml({ requiredMarkers: [] })], []],
    ["10 (F4): a code-page header with revisionRequired false", [cp({ revisionRequired: false })], []],
    ["10 (F4): a mid-line header with revisionRequired false", [ml({ revisionRequired: false })], []],
    ["10 (F4): a title-keyed header with revisionRequired false", [tk({ revisionRequired: false })], []],
    ["11: a title-line header without a revision marker", [tk({ revision: undefined })], []],
    [
      "11: an adjacent anchorTemplate without (?<rev>…)",
      [tk({ placement: "adjacent", anchorTemplate: "{title} Rev\\. (\\d{2})" })],
      [],
    ],
  ])("rejects %s", (_name, pubs, forms) => {
    expect(() => buildRegistry(pubs, forms)).toThrow(/form registry/);
  });

  it("a single-line title is accepted (every header gates on its revision; check 6 is out)", () => {
    const single = [form({ publisherId: "tk", code: undefined, titleKey: [/ONE TITLE LINE/] })];
    expect(() => buildRegistry([tk()], single)).not.toThrow();
  });

  it("an adjacent header with {title} and (?<rev>…) is accepted", () => {
    expect(() =>
      buildRegistry([tk({ placement: "adjacent", anchorTemplate: "{title} Rev\\. (?<rev>\\d{2})" })], [])
    ).not.toThrow();
  });

  it("10 (F4): every shipped windowed publisher requires its revision", () => {
    const windowed = DEFAULT_REGISTRY.publishers.filter((p) => p.header.kind !== undefined && p.header.kind !== "code-line");
    expect(windowed.length).toBeGreaterThan(0);
    for (const p of windowed) expect((p.header as { revisionRequired: boolean }).revisionRequired).toBe(true);
  });

  it("windowBefore 0 is allowed", () => {
    expect(() => buildRegistry([cp({ windowBefore: 0 })], [])).not.toThrow();
  });
});
