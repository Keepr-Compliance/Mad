/**
 * Founder (Windows): keepr://link's code is held for the link box only
 * briefly and taken once. Mutations: taken twice; kept past the limit → red.
 */
import { LINK_PREFILL_MS, rcsImportService } from "../rcsImportService";

describe("the link-code prefill holder", () => {
  it("taken once", () => {
    rcsImportService.holdLinkCodePrefill("123456", 1000);
    expect(rcsImportService.takeLinkCodePrefill(1000)).toBe("123456");
    expect(rcsImportService.takeLinkCodePrefill(1000)).toBeNull();
  });

  it("dropped past LINK_PREFILL_MS; no code holds nothing", () => {
    rcsImportService.holdLinkCodePrefill("123456", 1000);
    expect(rcsImportService.takeLinkCodePrefill(1000 + LINK_PREFILL_MS + 1)).toBeNull();
    rcsImportService.holdLinkCodePrefill("123456", 1000);
    rcsImportService.holdLinkCodePrefill(undefined, 1000);
    expect(rcsImportService.takeLinkCodePrefill(1000)).toBeNull();
  });
});
