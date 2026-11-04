/**
 * @jest-environment node
 *
 * BACKLOG-3943 — the BACKLOG-3941 matcher reads Vision OCR output unmodified.
 *
 * C1: accurate-level output of two blank forms is recognised (code line, publisher, rights,
 *     revision guards all pass).
 * C2: fast-level output of the same page is NOT recognised — the reason the product uses
 *     the accurate level only (founder ruling 6).
 *
 * Fixtures: fixtures/ocrHeaders.ts (one captured run each, cited line by line).
 */
import { matchForms } from "../../formRecognition/formMatcher";
import { OCR_S1_P1, OCR_S1_P1_FAST, OCR_S7_P1 } from "./fixtures/ocrHeaders";

const text = (lines: readonly string[]): string => lines.join("\n");

describe("C1 — accurate-level OCR output is recognised", () => {
  it("Form 41 Rev. 8/24 (S1 page 1, image-only raster)", () => {
    const m = matchForms(text(OCR_S1_P1));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ formId: "nwmls-41", code: "41", strength: "footer+title", revisionSeen: "8/24" });
  });

  it("Form 21 Rev. 7/23 (S7 page 1)", () => {
    const m = matchForms(text(OCR_S7_P1));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ formId: "nwmls-21", code: "21", strength: "footer+title", revisionSeen: "7/23" });
  });
});

describe("C2 — fast-level OCR output of the same page is not recognised", () => {
  it("S1 page 1 at the fast level -> no match", () => {
    expect(matchForms(text(OCR_S1_P1_FAST))).toEqual([]);
  });
});
