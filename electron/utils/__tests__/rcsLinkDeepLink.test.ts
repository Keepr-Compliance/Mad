/**
 * C1: keepr://link only opens the link screen; parameters change nothing.
 * Mutation: another keepr:// path accepted, or a non-keepr URL → red.
 */
import { isRcsLinkDeepLink } from "../rcsLinkDeepLink";

describe("keepr://link", () => {
  it("opens the link screen whatever its parameters", () => {
    expect(isRcsLinkDeepLink("keepr://link")).toBe(true);
    expect(isRcsLinkDeepLink("keepr://link?code=123456&user=x")).toBe(true);
    expect(isRcsLinkDeepLink("keepr:///link")).toBe(true);
  });

  it("nothing else", () => {
    expect(isRcsLinkDeepLink("keepr://callback?access_token=x")).toBe(false);
    expect(isRcsLinkDeepLink("keepr://payment-callback")).toBe(false);
    expect(isRcsLinkDeepLink("https://link")).toBe(false);
    expect(isRcsLinkDeepLink("not a url")).toBe(false);
  });
});
