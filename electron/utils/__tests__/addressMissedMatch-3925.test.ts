/**
 * BACKLOG-3925: a cached email whose signature footer reads
 * "4321 Example St., 9th Floor • Springfield • Ontario • A1A 1A1 • Canada" was not
 * queued for a deal stored space-joined, without a comma ("4321 Example St 9th Floor
 * Springfield Ontario A1A 1A1 Canada").
 *
 * Fixtures: fictional addresses in the shape the app stores and the shape the footer
 * had. The email text is also wrapped in marketing-style HTML and run through the real
 * htmlToPlainText.
 *
 * Mechanism: normalizeAddress took the street as everything before the FIRST comma.
 * With no comma, every word after the number became a required street-name word
 * (example, 9th, floor, springfield, ontario, a1a, 1a1, canada), and the address route
 * required all of them as one consecutive run. No email writes that run. The fix ends
 * the street name at the first suffix word (or unit / floor / region / postcode).
 */
import {
  normalizeAddress,
  contentContainsAddress,
  contentContainsAddressAdjacent,
  addressRouteNameWords,
} from "../addressNormalization";
import { isAddressMatchRow } from "../../services/db/addressMatchCandidatesDb";
import { htmlToPlainText } from "../htmlToPlainText";

const FOOTER = "4321 Example St., 9th Floor • Springfield • Ontario • A1A 1A1 • Canada";
const FOOTER_HTML =
  '<table><tr><td style="font-size:12px">4321&nbsp;Example St.,&nbsp;9th Floor &bull; Springfield &bull; Ontario<br>A1A 1A1 &bull; Canada</td></tr></table>';

const addr = (a: string) => {
  const n = normalizeAddress(a);
  if (!n) throw new Error("fixture address did not normalise: " + a);
  return n;
};

describe("BACKLOG-3925 missed match: 4321 Example St footer", () => {
  it("control: the footer matches the same address written with a comma", () => {
    const deal = addr("4321 Example St, Springfield, ON A1A 1A1, Canada");
    expect(contentContainsAddressAdjacent(FOOTER, deal)).toBe(true);
    expect(contentContainsAddressAdjacent(htmlToPlainText(FOOTER_HTML), deal)).toBe(true);
  });

  const stored = "4321 Example St 9th Floor Springfield Ontario A1A 1A1 Canada";

  it("the deal address as stored (no comma) matches the footer, plain text", () => {
    expect(isAddressMatchRow({ id: "e1", subject: "Your trial ends soon!", body_plain: FOOTER }, addr(stored))).toBe(true);
  });

  it("the deal address as stored (no comma) matches the footer, from HTML", () => {
    const body = htmlToPlainText(FOOTER_HTML);
    expect(isAddressMatchRow({ id: "e1", subject: "Your trial ends soon!", body_plain: body }, addr(stored))).toBe(true);
  });

  it("the deal address as stored (no comma) matches a bare '4321 Example St'", () => {
    expect(contentContainsAddressAdjacent("Visit us at 4321 Example St", addr(stored))).toBe(true);
  });
});

describe("BACKLOG-3925 street name ends at the first suffix / unit / tail", () => {
  const route = (a: string) => addressRouteNameWords(addr(a));

  it("comma and no-comma deal addresses give the same street", () => {
    const withComma = "4321 Example St, 9th Floor, Springfield, ON A1A 1A1";
    const without = "4321 Example St 9th Floor Springfield ON A1A 1A1";
    expect(route(without)).toEqual(route(withComma));
    expect(route(without)).toEqual(["example"]);
  });

  it.each([
    ["4321 Example St Floor 10 Springfield", ["example"]],
    ["4321 Example Fl 10", ["example"]],
    ["4321 Example Suite 200", ["example"]],
    ["4321 Example Ste 200", ["example"]],
    ["4321 Example Unit 4", ["example"]],
    ["4321 Example Apt 2B", ["example"]],
    ["4321 Example # 4", ["example"]],
    ["4321 Example #4", ["example"]],
    ["4321 Example #4 Springfield ON", ["example"]],
    ["100 Ponce de Leon Ave Atlanta GA", ["ponce", "de", "leon"]],
    ["100 Rue de la Montagne", ["rue", "de", "la", "montagne"]],
    ["100 Old Mt Vernon Rd", ["old", "mt", "vernon"]],
    ["4321 Example Room 12", ["example"]],
    ["4321 Example 9th Floor", ["example"]],
    ["4321 Example Springfield ON A1A 1A1", ["example", "springfield"]],
    ["4321 Example ON A1A 1A1 Canada", ["example"]],
    ["4321 Example CA 90210", ["example"]],
    ["4321 Example 90210", ["example"]],
    ["4321 Example Canada", ["example"]],
  ])("%j -> street %j", (deal, expected) => {
    expect(route(deal)).toEqual(expected);
  });

  it("multi-word names before the suffix still need the full name run", () => {
    expect(route("10 St Charles Ave Springfield ON")).toEqual(["charles"]);
    expect(route("1600 Martin Luther King Jr Blvd Springfield")).toEqual(["martin", "luther", "king", "jr"]);
    const mlk = addr("1600 Martin Luther King Jr Blvd Springfield ON");
    expect(contentContainsAddressAdjacent("1600 Martin Luther King Jr Blvd", mlk)).toBe(true);
    expect(contentContainsAddressAdjacent("1600 Martin Luther Blvd", mlk)).toBe(false);
    expect(contentContainsAddressAdjacent("1600 Martin Blvd", mlk)).toBe(false);
    expect(route("1234 Avenue of the Americas, New York NY")).toEqual(["of", "the", "americas"]);
    // Known limit, pinned: with no comma and no suffix, a city name cannot be told from the street.
    expect(route("1234 Avenue of the Americas New York NY")).toEqual(["of", "the", "americas", "new", "york"]);
    const sa = addr("10 St Charles Ave Springfield ON");
    expect(contentContainsAddressAdjacent("10 St Charles Ave", sa)).toBe(true);
    expect(contentContainsAddressAdjacent("10 St and Charles Ave", sa)).toBe(false);
  });

  it("1234 Avenue of the Americas still matches itself", () => {
    const a = addr("1234 Avenue of the Americas, New York NY 10036");
    expect(contentContainsAddressAdjacent("1234 Avenue of the Americas", a)).toBe(true);
    expect(contentContainsAddressAdjacent("1234 Ave of the Americas, Floor 9", a)).toBe(true);
  });

  it("accepted looseness, pinned: '12 Park Place Dr' matches '12 Park Place' and '12 Park'", () => {
    const a = addr("12 Park Place Dr Springfield ON");
    expect(route("12 Park Place Dr Springfield ON")).toEqual(["park"]);
    expect(contentContainsAddressAdjacent("12 Park Place", a)).toBe(true);
    expect(contentContainsAddressAdjacent("12 Park", a)).toBe(true);
    expect(contentContainsAddressAdjacent("12 Park Place Dr", a)).toBe(true);
  });

  it("earlier rejections still reject, for a comma-free deal address", () => {
    const park = addr("12 Park Rd Springfield ON A1A 1A1");
    expect(contentContainsAddressAdjacent("12 Parkway", park)).toBe(false);
    expect(contentContainsAddressAdjacent("at 12 on Park", park)).toBe(false);
    expect(contentContainsAddressAdjacent("closing at 12 on Park Ave", park)).toBe(false);
    const oak = addr("7 Oak St Springfield ON");
    expect(contentContainsAddressAdjacent("We offered $7,000 over on the Oak St listing", oak)).toBe(false);
    const twelfth = addr("12 Oak St Springfield ON");
    expect(contentContainsAddressAdjacent("the 12th of Oak St", twelfth)).toBe(false);
  });

  it("a region code or country word inside a street name does not end it", () => {
    const cases: Array<[string, string, string]> = [
      ["100 Ponce de Leon Ave Atlanta GA", "100 Ponce de Leon Ave", "Ponce de Leon Ave 100"],
      ["100 Rue de la Montagne", "100 Rue de la Montagne", "Rue de la Montagne 100"],
      ["100 Old Mt Vernon Rd", "100 Old Mt Vernon Rd", "Old Mt Vernon Rd 100"],
    ];
    for (const [deal, numberFirst, nameFirst] of cases) {
      const a = addr(deal);
      expect(contentContainsAddressAdjacent(numberFirst, a)).toBe(true);
      expect(contentContainsAddressAdjacent(nameFirst, a)).toBe(true);
    }
    expect(contentContainsAddressAdjacent("100 rue Sherbrooke", addr("100 Rue de la Montagne"))).toBe(false);
    expect(contentContainsAddressAdjacent("100 Old Town Rd", addr("100 Old Mt Vernon Rd"))).toBe(false);
  });

  it("the contact route keeps every word of a comma-free address required", () => {
    const stored = addr("4321 Example St 9th Floor Springfield Ontario");
    expect(stored.requiredNameWords).toEqual(["example", "9th", "floor", "springfield", "ontario"]);
    expect(contentContainsAddress("4321 Example St", stored)).toBe(false);
    expect(contentContainsAddress("4321 Example 9th floor Springfield Ontario", stored)).toBe(true);
  });
});
