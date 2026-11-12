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
import { displayAddress, streetPhraseRegex, streetTokenRegex } from "../../../src/components/settings/learn/learnEmailHtml";
import { pickQuestionAttachmentId, streetTokens } from "../learn/questionAttachment";
import corpus from "./fixtures/addressOverrun-4225.corpus.json";

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

  it("C1 a period after the suffix: still no address (the pre-fix extractor found none; detection is unchanged)", () => {
    expect(extract("Pre-approval for 1234 Sample\nRiver Lane.\nAnn and Bob are excited")).toEqual([]);
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

  it("C8 prose: a number and a far-off suffix word are not an address (none before the fix either)", () => {
    expect(extract("2 of the 3 offers came in. We can meet at the court tomorrow, escrow closing buyer")).toEqual([]);
  });

  it("C8 a money amount is not a street number", () => {
    expect(extract(BODY.replace("thank you!", "see you on the way"))).toEqual(["1234 sample river lane"]);
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

  it("C3 a real state code on the next line does not join it (before: '1234 sample river lane\\nbuyers move in')", () => {
    expect(extract("Inspection booked at 1234 Sample River Lane\nBuyers move in\nThanks")).toEqual(["1234 sample river lane"]);
  });

  it("C3 the kept tail is never longer than what was detected (before: '1234 sample river lane bob is')", () => {
    expect(extract("Offer for 1234 Sample River Lane Bob is in. Thanks")).toEqual(["1234 sample river lane"]);
  });

  it("C3 a 5-word 'city' before a state code is not a city (before: '... ann and bob were excited in')", () => {
    expect(extract("Offer for 1234 Sample River Lane Ann and Bob were excited in. Thanks")).toEqual(["1234 sample river lane"]);
  });

  it("C11 two detected matches that trim to one street still count as two (before: 2 addresses)", () => {
    expect(extract("Offer for 1234 Sample River Lane Bob lives in Ohio. Again 1234 Sample River Lane Ann is ok")).toEqual([
      "1234 sample river lane",
      "1234 sample river lane",
    ]);
  });

  it("C9 corpus: every email gets the same NUMBER of addresses as before, and the same real-estate flag", () => {
    // Inputs: everything the extractor and Learn suites pass to the real
    // analyzeEmail, the same with state ZZ, and the synthetic cases above.
    // old* fields are transcribed pre-fix output (see the fixture's _source).
    const rows = corpus.rows as Array<{ email: Record<string, string>; oldRealEstate: boolean; oldAddresses: string[] }>;
    expect(rows.length).toBeGreaterThan(70);
    const para = "Escrow update for 4120 Canarytest Lane Testville ZZ 00000 buyer offer inspection 12345 and 67890 a1 b2 c3. ";
    const all = [
      ...rows,
      // the 400 KB timing-guard body (learnScoringPure-4120), rebuilt here
      { email: { subject: "x", bodyPlain: para.repeat(Math.ceil((400 * 1024) / para.length)) }, oldRealEstate: true, oldAddresses: ["4120 canarytest lane testville zz 00000"] },
    ];
    const got = all.map((r) => svc.analyzeEmail({ ...r.email, date: "2026-11-01" } as never));
    const shape = (a: { isRealEstateRelated: boolean; addresses: string[] }) => [a.isRealEstateRelated, a.addresses.length];
    expect(got.map(shape)).toEqual(all.map((r) => [r.oldRealEstate, r.oldAddresses.length]));

    // Grouping (groupByProperty): the same emails are grouped, and each old
    // group is inside one new group. Groups only merge where the shown
    // addresses are now the same street.
    const groupOf = (keys: Array<string | undefined>) => {
      const m = new Map<string, number[]>();
      keys.forEach((k, i) => {
        if (k !== undefined) m.set(k, [...(m.get(k) ?? []), i]);
      });
      return m;
    };
    const before = groupOf(all.map((r) => r.oldAddresses[0]));
    const after = groupOf(got.map((a) => a.addresses[0]));
    expect([...after.values()].flat().sort((a, b) => a - b)).toEqual([...before.values()].flat().sort((a, b) => a - b));
    const newKeyOf = new Map<number, string>();
    for (const [k, ids] of after) for (const i of ids) newKeyOf.set(i, k);
    for (const ids of before.values()) expect(new Set(ids.map((i) => newKeyOf.get(i))).size).toBe(1);
  });

  it("C10 attachment path: the PDF pick and the PDF highlight use the same address, so they end at the street too", () => {
    const [addr] = extract("Signed 1234 West Sample Drive West Sample Yards Is\nescrow closing");
    expect(streetTokens(addr)).toEqual(["1234", "west", "sample", "drive"]);
    expect(String(streetTokenRegex(addr))).not.toMatch(/yards/);
    // The first PDF names only a word of the old over-run tail.
    const emails = [{ attachments: [
      { id: "a-tail", filename: "Yards survey.pdf", mimeType: "application/pdf" },
      { id: "a-deal", filename: "Purchase 1234 contract.pdf", mimeType: "application/pdf" },
    ] }];
    expect(pickQuestionAttachmentId(emails as never, addr)).toBe("a-deal");
    // the pre-fix address (transcribed) picked the tail's PDF
    expect(pickQuestionAttachmentId(emails as never, "1234 west sample drive west sample yards is")).toBe("a-tail");
  });
});
