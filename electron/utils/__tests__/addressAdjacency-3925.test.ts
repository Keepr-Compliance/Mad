/**
 * BACKLOG-3925: the address-only route's matcher — street number and street name
 * ADJACENT, in either order. The contact route keeps contentContainsAddress.
 */
import { normalizeAddress, contentContainsAddress, contentContainsAddressAdjacent } from "../addressNormalization";

const addr = (a: string) => {
  const n = normalizeAddress(a);
  if (!n) throw new Error("fixture address did not normalise: " + a);
  return n;
};

describe("contentContainsAddressAdjacent", () => {
  const park = addr("12 Park Rd, Springfield");
  const oak = addr("7 Oak St, Springfield");

  it.each([
    ["12 Park Rd", true],
    ["12 Park Road", true],
    ["12 park rd.", true],
    ["Meet at 12 Park Rd, Springfield", true],
    ["12 N Park Rd", true],
    ["12 Park", true],
    ["Park Rd 12", true],
    ["Park Road 12", true],
    ["Park 12", true],
    ["Park Rd N 12", true],
    ["12\nPark Rd", true],
    ["closing at 12 on Park Ave", false],
    ["12 on Park Rd", false],
    ["Park Rd is at 12 miles", false],
    ["112 Park Rd", false],
    ["12 Parkway", false],
    ["Park Rd, 12", false],
    ["12.5 Park Rd", false],
  ])("12 Park Rd vs %j -> %s", (text, expected) => {
    expect(contentContainsAddressAdjacent(text, park)).toBe(expected);
  });

  it.each([
    ["7 Oak St", true],
    ["Oak Street 7", true],
    ["We offered $7,000 over asking on the Oak St listing", false],
    ["$7,000 and Oak St", false],
    ["$7 Oak St", false],
    ["Oak St listed at 7,000", false],
    ["7 sq ft Oak St", false],
    ["Re: offer for 7", false],
  ])("7 Oak St vs %j -> %s", (text, expected) => {
    expect(contentContainsAddressAdjacent(text, oak)).toBe(expected);
  });

  it("multi-word names stay together, in order", () => {
    const mlk = addr("4 Martin Luther King Blvd");
    expect(contentContainsAddressAdjacent("4 Martin Luther King Boulevard", mlk)).toBe(true);
    expect(contentContainsAddressAdjacent("Martin Luther King Blvd 4", mlk)).toBe(true);
    expect(contentContainsAddressAdjacent("4 Martin King Luther", mlk)).toBe(false);
  });

  it("the contact route's rule is untouched: not-adjacent text still matches contentContainsAddress", () => {
    const text = "closing at 12 on Park Ave";
    expect(contentContainsAddress(text, park)).toBe(true);
    expect(contentContainsAddressAdjacent(text, park)).toBe(false);
  });

  it("null / empty content never matches", () => {
    expect(contentContainsAddressAdjacent(null, park)).toBe(false);
    expect(contentContainsAddressAdjacent("", park)).toBe(false);
  });
});
