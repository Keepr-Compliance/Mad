/**
 * BACKLOG-3925: the address-only route's matcher — street number and street name
 * ADJACENT, in either order. The contact route keeps contentContainsAddress.
 */
import {
  normalizeAddress,
  contentContainsAddress,
  contentContainsAddressAdjacent,
  addressRouteNameWords,
} from "../addressNormalization";

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

/**
 * SR review c2182933 (fix round 2): the false negatives against "rather more than less".
 * Each deal address must match its own text; the negatives SR listed stay negative.
 */
describe("SR fix round 2 — suffix runs, periods, units, ranges", () => {
  it.each([
    // [deal, email text, expected]
    ["10 St Charles Ave", "10 St Charles Ave", true],
    ["10 St Charles Ave", "Showing at 10 St. Charles Avenue today", true],
    ["10 St Charles Ave", "St Charles Ave 10", true],
    ["1234 Avenue of the Americas", "1234 Avenue of the Americas", true],
    ["1234 Avenue of the Americas", "1234 Ave of the Americas, 5th floor", true],
    ["12 Elm St", "12 E Elm St", true],
    ["12 Elm St", "12 E. Elm St", true],
    ["12 E Elm St", "12 E. Elm St", true],
    ["12 E Elm St", "12 E Elm St", true],
    ["7 Oak St", "Oak St. 7", true],
    ["7 Oak St", "Oak St 7", true],
    ["1428 Maple Ave Unit 4, Springfield", "1428 Maple Ave Unit 4", true],
    ["1428 Maple Ave Unit 4, Springfield", "1428 Maple Ave", true],
    ["1428 Maple Ave Apt 4B", "1428 Maple Ave Apt 4B", true],
    ["1428 Maple Ave Suite 200", "Suite 200, 1428 Maple Ave", true],
    ["1428 Maple Ave #4", "1428 Maple Ave #4", true],
    ["1428 Maple Ave # 4", "1428 Maple Ave # 4", true],
    ["1428 Maple Ave #4", "Unit #4, 1428 Maple Ave", true],
    ["1428 Maple Ave", "1428-1430 Maple Ave", true],
    ["1430 Maple Ave", "1428-1430 Maple Ave", true],
    ["1428 Maple Ave", "1428 - 1430 Maple Ave", true],
    ["1428 Maple Ave", "Maple Ave 1426-1428", true],
    ["1428 Maple Ave", "1428 Maple Ave #4", true],
    ["3414 Sapp Road SW", "3414 SW Sapp Rd", true],
    ["3414 Sapp Road SW", "Sapp Rd SW 3414", true],
    ["3414 Sapp Road SW", "3414 Southwest Sapp", true],
    ["100 Martin Luther King Jr Blvd", "100 Martin Luther King Jr Blvd", true],
    ["100 Martin Luther King Jr Blvd", "Martin Luther King Jr. Blvd 100", true],
    ["500 East West Hwy", "500 East West Hwy", true],
    ["500 East West Hwy", "500 East West Highway", true],
    ["100 Court St", "100 Court Street", true],
    ["12 Park Rd", "12 Park Ave", true],
    ["12 Park Rd", "12 Park Place", true],
    // the negatives SR listed as correct, kept correct
    ["12 Park Rd", "12 Parkway", false],
    ["12 Park Rd", "12th Park Rd", false],
    ["12 Park Rd", "Park Rd 12th", false],
    ["12 Park Rd", "closing at 12 on Park Ave", false],
    ["7 Oak St", "We offered $7,000 over asking on the Oak St listing", false],
    ["7 Oak St", "$7 Oak St", false],
    // a period joins only after an abbreviation, never after a number or a name word
    ["12 Park Rd", "Item 12. Park Rd is closed", false],
    ["7 Oak St", "We met at Oak. 7 people came", false],
    // a hyphen joins two NUMBERS only
    ["1428 Maple Ave", "1428-Maple Ave", false],
    ["1428 Maple Ave", "1427-1429 Maple Ave", false],
    // the unit is dropped from the deal, not the number
    ["1428 Maple Ave Unit 4", "4 Maple Ave", false],
    // a word between a suffix run and the name still breaks it
    ["10 St Charles Ave", "10 St and Charles Ave", false],
  ])("deal %j vs %j -> %s", (deal, text, expected) => {
    expect(contentContainsAddressAdjacent(text, addr(deal))).toBe(expected);
  });

  it("the address route requires the street name without the unit", () => {
    expect(addressRouteNameWords(addr("1428 Maple Ave Unit 4, Springfield"))).toEqual(["maple"]);
    expect(addressRouteNameWords(addr("1428 Maple Ave #4"))).toEqual(["maple"]);
    expect(addressRouteNameWords(addr("1428 Maple Ave Apt 4B"))).toEqual(["maple"]);
    expect(addressRouteNameWords(addr("1234 Avenue of the Americas"))).toEqual(["of", "the", "americas"]);
    expect(addressRouteNameWords(addr("10 St Charles Ave"))).toEqual(["charles"]);
  });

  it("the contact route's normaliser is unchanged: it still carries the unit", () => {
    expect(addr("1428 Maple Ave Unit 4").requiredNameWords).toEqual(["maple", "unit", "4"]);
  });
});
