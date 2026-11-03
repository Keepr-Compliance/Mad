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

describe("BACKLOG-3941 default registry", () => {
  it("ships eight NWMLS rows in priority order (main transaction forms first)", () => {
    expect(DEFAULT_REGISTRY.forms.map((f) => f.id)).toEqual([
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
