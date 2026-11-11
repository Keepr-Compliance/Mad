/**
 * @jest-environment node
 *
 * BACKLOG-4225 — the address extractor stops at the address.
 *
 * Synthetic addresses only (street "Sample", city "Testville", ZIP 00000).
 * "Before" values in comments were transcribed by running the pre-fix
 * extractor (int-portal/release-2.47 @ b1f9d6ae4) on these exact strings.
 */
import svc from "../transactionExtractorService";
import { addressKey, streetKey } from "../learn/dealMatcher";
import { displayAddress, streetPhraseRegex } from "../../../src/components/settings/learn/learnEmailHtml";

function extract(body: string, subject = "Pre-approval"): string[] {
  return svc.analyzeEmail({ subject, bodyPlain: body, date: "2026-11-01" } as never).addresses;
}

const BODY =
  "Could we get a pre-approval letter for 1234 Sample\nRiver Lane\nAnn and Bob are excited to proceed with an offer at $500,000 - thank you!";

describe("BACKLOG-4225 the address ends at the address", () => {
  it("C1 email body: the street, not the next line (before: '1234 sample\\nriver lane\\nann and bob are excited to')", () => {
    expect(extract(BODY)).toEqual(["1234 sample river lane"]);
  });

  it("C1 display: the Learn title and highlight are the street only", () => {
    const [addr] = extract(BODY);
    expect(displayAddress(addr)).toBe("1234 Sample River Lane");
    const re = streetPhraseRegex(addr) as RegExp;
    expect(BODY.match(re)).toEqual(["1234 Sample\nRiver Lane"]);
  });

  it("C1 grouping: the detector / Learn key (groupByProperty) is the street", () => {
    const a = svc.analyzeEmail({ subject: "Pre-approval", bodyPlain: BODY, date: "2026-11-01" } as never);
    expect(Object.keys(svc.groupByProperty([a]))).toEqual(["1234 sample river lane"]);
  });

  it("C1 a period after the suffix: the street (before: no address at all)", () => {
    expect(extract("Pre-approval for 1234 Sample\nRiver Lane.\nAnn and Bob are excited")).toEqual(["1234 sample river lane"]);
  });

  it("C2 attachment-text shape: a 2-letter word that is not a state ends nothing (before: '... west sample yards is')", () => {
    expect(extract("Signed 1234 West Sample Drive West Sample Yards Is\nescrow closing")).toEqual(["1234 west sample drive"]);
  });

  it("C2 subject + body joined with a space (how _getEmailText joins them)", () => {
    expect(extract("West Sample Yards Is ready for signature", "Contract 1234 West Sample Drive")).toEqual([
      "1234 west sample drive",
    ]);
  });

  it("C3 'in' on the next line is not a state (before: '1234 sample river lane\\nbuyers ready to')", () => {
    expect(extract("Inspection booked at 1234 Sample River Lane\nBuyers ready to move in\nThanks")).toEqual([
      "1234 sample river lane",
    ]);
  });

  it("C3 'in' later on the same line is not a state: the city is at most 4 words (before: '... ann and bob are excited to')", () => {
    expect(extract("Offer for 1234 Sample River Lane ann and bob are excited to move in. Thanks")).toEqual([
      "1234 sample river lane",
    ]);
  });

  it("C3 'in' followed by more prose is not a state (before: '1234 sample river lane bob lives in')", () => {
    expect(extract("Offer for 1234 Sample River Lane Bob lives in Ohio escrow")).toEqual(["1234 sample river lane"]);
  });

  it.each([
    ["Offer for 1234 Sample River Lane, Testville, WA 00000 escrow closing", "1234 sample river lane, testville, wa 00000"],
    ["Offer for 1234 Sample River Lane Testville WA 00000 escrow", "1234 sample river lane testville wa 00000"],
    ["Offer for 1234 Sample River Lane, Testville, WA 00000-1234. escrow", "1234 sample river lane, testville, wa 00000-1234"],
    ["Offer for 1234 Sample River Lane, Testville, WA. escrow", "1234 sample river lane, testville, wa"],
  ])("C4 a clean one-line address is unchanged: %s", (body, before) => {
    expect(extract(body)).toEqual([before]);
  });

  it("C5 decision: city, ST and ZIP on the next line stay in the address, on one line (before: '...lane\\ntestville, wa 00000')", () => {
    const [addr] = extract("Offer for 1234 Sample River Lane\nTestville, WA 00000\nescrow closing");
    expect(addr).toBe("1234 sample river lane, testville, wa 00000");
    expect(addressKey(addr)).toBe("1234 sample river|00000");
    expect(displayAddress(addr)).toBe("1234 Sample River Lane, Testville, WA 00000");
  });

  it("C7 an address on the first line is still found (the shared /g pattern's lastIndex is not inherited)", () => {
    // _analyzeSubjectLine runs patterns.address.test() on the first line first.
    expect(extract("Escrow closing next week, buyer offer", "Offer 1234 Sample River Lane, Testville, WA 00000")).toEqual([
      "1234 sample river lane, testville, wa 00000",
    ]);
  });

  it("C6 keys: what an existing Learn answer is stored under does not change", () => {
    // [fixed extractor input, key the pre-fix output had (transcribed)]
    const rows: Array<[string, string]> = [
      [BODY, "1234 sample river|"],
      ["Signed 1234 West Sample Drive West Sample Yards Is\nescrow closing", "1234 sample|"],
      ["Offer for 1234 Sample River Lane, Testville, WA 00000 escrow closing", "1234 sample river|00000"],
      ["Offer for 1234 Sample River Lane Testville WA 00000 escrow", "1234 sample river|00000"],
      ["Offer for 1234 Sample River Lane\nTestville, WA 00000\nescrow closing", "1234 sample river|00000"],
    ];
    for (const [body, key] of rows) expect([body, addressKey(extract(body)[0])]).toEqual([body, key]);
    // and the hand-typed street still matches (dealMatcher streetKey)
    expect(streetKey(extract(BODY)[0])).toBe(streetKey("1234 Sample River Lane"));
    expect(streetKey(extract("Signed 1234 West Sample Drive West Sample Yards Is\nescrow")[0])).toBe(
      streetKey("1234 West Sample Drive"),
    );
  });
});
