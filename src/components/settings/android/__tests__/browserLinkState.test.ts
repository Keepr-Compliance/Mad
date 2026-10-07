/**
 * Live (0.3.76): one rule for how the browser link is shown (the Sync Android
 * modal and Settings › Google Messages). Mutations: a saved link shown as
 * not linked; "no link here" ignored; no "checking" window → red.
 */
import { browserLinkView } from "../browserLinkState";

describe("browserLinkView", () => {
  it("proven → linked; saved and not disowned → checking, then linked; else not linked", () => {
    expect(browserLinkView({ extensionPaired: true }, false)).toBe("linked");
    expect(browserLinkView({ extensionPaired: false, pairingSaved: true, linkNotHere: false }, false)).toBe("checking");
    expect(browserLinkView({ extensionPaired: false, pairingSaved: true, linkNotHere: false }, true)).toBe("linked");
    expect(browserLinkView({ extensionPaired: false, pairingSaved: true, linkNotHere: true }, true)).toBe("notLinked");
    expect(browserLinkView({ extensionPaired: false, pairingSaved: false }, true)).toBe("notLinked");
    expect(browserLinkView(null, false)).toBe("notLinked");
  });
});
