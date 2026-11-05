/**
 * BACKLOG-4106 — Oregon controls: OREF (mid-line) and Oregon REALTORS (code-page). Every
 * SYNTHETIC input is labelled; every other input is a fixture transcribed from a blank form.
 */
import { buildRegistry } from "../registry";
import { EVIDENCE_CAP, inferRegion, matchForms } from "../formMatcher";
import { OR_FORMS, OREF_PUBLISHER, ORR_PUBLISHER } from "../orForms";
import type { FormMatch, MidLineHeader, CodePageHeader } from "../formRegistryTypes";
import { BODY, SYNTH, fixtureText } from "./fixtures/nwmlsHeaders";
import {
  OR2_OREF_000B_PAGE_LINE,
  OR2_OREF_001,
  OR2_OREF_003,
  OR2_OREF_009,
  OR2_OREF_057,
  OR3_ORR_1_1,
  OR4_ORR_2_1,
  OR5_ORR_9_3,
  OR6_ORR_9_4,
  OR7_ORR_10_4,
  OR8_ORR_3_1,
  OR_FIXTURES,
} from "./fixtures/orHeaders";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);
const OREF_NAME = "No portion may be reproduced without the express permission of Oregon Real Estate Forms, LLC";

describe("BACKLOG-4106 OREF (mid-line) — positives", () => {
  it("OREF 001: one match, all 15 pages counted, revision captured, title seen", () => {
    const text = fixtureText(OR2_OREF_001);
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["oref-001"]);
    expect(ms[0]).toMatchObject({
      publisherId: "oref",
      code: "001",
      kind: "purchase_agreement",
      strength: "footer+title",
      occurrences: 15,
      revisionSeen: "01/2026",
    });
    expect(text.slice(ms[0].firstOffset).startsWith("OREF 001 | Released 01/2026")).toBe(true);
  });

  it("each OREF row's fixture yields that row only, with its page count", () => {
    const counts = OR_FIXTURES.filter((f) => f.id.startsWith("OR2-0") && f.id !== "OR2-000B-page").map(
      (f) => [f.id, ...matchForms(fixtureText(f)).map((m) => [m.formId, m.occurrences])]
    );
    expect(counts).toEqual([
      ["OR2-001", ["oref-001", 15]],
      ["OR2-003", ["oref-003", 2]],
      ["OR2-004", ["oref-004", 2]],
      ["OR2-015", ["oref-015", 6]],
      ["OR2-050", ["oref-050", 4]],
      ["OR2-052", ["oref-052", 4]],
      ["OR2-057", ["oref-057", 2]],
      ["OR2-009", ["oref-009", 2]],
    ]);
  });

  it("OREF 009: the footer's misspelt name is not needed — the strict name later on the same line holds", () => {
    expect(ids(matchForms(fixtureText(OR2_OREF_009)))).toEqual(["oref-009"]);
  });

  it("K10: OREF 000B prints its page line BELOW the footer — the page segment is optional (SYNTHETIC footer line: host left out)", () => {
    const [title, pageLine] = OR2_OREF_000B_PAGE_LINE.lines;
    const text = [title, "Copyright Oregon Real Estate Forms, LLC 2025 | OREF 000B | Released 01/2026", pageLine].join("\n");
    const ms = matchForms(text);
    expect(ids(ms)).toEqual(["?000B"]);
    expect(ms[0].revisionSeen).toBe("01/2026");
    expect(inferRegion(ms)).toEqual([]);
  });

  it("a packet returns every OREF form in order", () => {
    const text = [OR2_OREF_001, OR2_OREF_003, OR2_OREF_057].map(fixtureText).join("\n");
    expect(ids(matchForms(text))).toEqual(["oref-001", "oref-003", "oref-057"]);
  });
});

describe("BACKLOG-4106 OREF (mid-line) — near-misses", () => {
  it("K9: a footer-shaped line without the OREF token is not a marker (SYNTHETIC)", () => {
    const text = ["Form 123 | Released 01/2026 | Page 1 of 2", OREF_NAME, ...BODY].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("a body reference to an OREF form (no `| Released`) is not a marker (SYNTHETIC)", () => {
    const text = ["Seller shall deliver the OREF 042 disclosure.", OREF_NAME, ...BODY].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("wrong implementation: the marker never spans a line break (SYNTHETIC)", () => {
    const text = ["LINES WITH THIS SYMBOL REQUIRE A SIGNATURE AND DATE OREF 001 |", "Released 01/2026 | Page 1 of 15", OREF_NAME].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("the publisher's name only outside the window does not count (SYNTHETIC: name 301+ chars after)", () => {
    const text = ["OREF 001 | Released 01/2026 | Page 1 of 15", ".".repeat(300), OREF_NAME].join("\n");
    expect(matchForms(text)).toEqual([]);
  });

  it("K12: the marker is found mid-line (the real footer starts with other text)", () => {
    const line = OR2_OREF_001.lines[1];
    expect(line.startsWith("OREF")).toBe(false);
    expect(ids(matchForms(fixtureText(OR2_OREF_001)))).toEqual(["oref-001"]);
  });
});

describe("BACKLOG-4106 Oregon REALTORS (code-page) — positives", () => {
  it.each([
    [OR3_ORR_1_1, "orr-1.1", "purchase_agreement", 10],
    [OR4_ORR_2_1, "orr-2.1", "counteroffer", 1],
    [OR5_ORR_9_3, "orr-9.3", "listing_agreement", 4],
    [OR6_ORR_9_4, "orr-9.4", "buyer_agreement", 3],
    [OR8_ORR_3_1, "orr-3.1", "other", 6],
    [OR7_ORR_10_4, "orr-10.4", "other", 5],
  ] as const)("%#: %s", (fx, id, kind, pages) => {
    const text = fixtureText(fx);
    const ms = matchForms(text);
    expect(ids(ms)).toEqual([id]);
    expect(ms[0]).toMatchObject({ kind, occurrences: pages, revisionSeen: "2026-2", strength: "footer+title" });
    expect(text.slice(ms[0].firstOffset).startsWith("Form ")).toBe(true);
  });

  it("3.1 prints no space before the dot (`Form 3.1·`) and still matches; its 3.1A attachment header has no page token and is not counted", () => {
    expect(OR8_ORR_3_1.lines[0].startsWith("Form 3.1·")).toBe(true);
    expect(matchForms(fixtureText(OR8_ORR_3_1))[0].occurrences).toBe(6);
  });
});

describe("BACKLOG-4106 Oregon REALTORS (code-page) — near-misses", () => {
  const [code, copyright] = OR4_ORR_2_1.lines.slice(0, 2);

  it("control: the 2.1 header matches", () => {
    expect(ids(matchForms([code, copyright].join("\n")))).toEqual(["orr-2.1"]);
  });

  it("no © line in the window, no match", () => {
    expect(matchForms([code, ...BODY].join("\n"))).toEqual([]);
  });

  it("the © line BEFORE the code line does not count (windowBefore 0)", () => {
    expect(matchForms([copyright, code, ...BODY].join("\n"))).toEqual([]);
  });

  it("K1: a code-page line that does not start the line is not a code line (SYNTHETIC)", () => {
    expect(matchForms([`See ${code}`, copyright].join("\n"))).toEqual([]);
  });

  it("a body reference to an Oregon REALTORS form is not a code line (SYNTHETIC)", () => {
    expect(matchForms(["Form 2.6 and Form 5.3 apply to this sale.", copyright].join("\n"))).toEqual([]);
  });

  it("the page total is never a key (SYNTHETIC: 1.1 with two pages' totals rewritten to 12 and 17)", () => {
    const lines = [...OR3_ORR_1_1.lines];
    const p2 = lines.findIndex((l) => l.includes("Page 2 of 10"));
    const p3 = lines.findIndex((l) => l.includes("Page 3 of 10"));
    lines[p2] = lines[p2].replace("of 10", "of 12");
    lines[p3] = lines[p3].replace("of 10", "of 17");
    const ms = matchForms(lines.join("\n"));
    expect(ids(ms)).toEqual(["orr-1.1"]);
    expect(ms[0].occurrences).toBe(10);
  });
});

describe("BACKLOG-4106 OR — region and evidence", () => {
  it("K24: OREF and Oregon REALTORS forms infer OR", () => {
    const text = [OR2_OREF_001, OR3_ORR_1_1].map(fixtureText).join("\n");
    expect(inferRegion(matchForms(text))).toEqual([
      { state: "OR", publisherId: "oref", forms: 1 },
      { state: "OR", publisherId: "orr", forms: 1 },
    ]);
  });

  it("10.4 (the agency pamphlet wrapped by Oregon REALTORS) yields orr-10.4 only: the regulator's own row is held", () => {
    expect(ids(matchForms(fixtureText(OR7_ORR_10_4)))).toEqual(["orr-10.4"]);
  });

  it.each(OR_FIXTURES.filter((f) => f.id !== "OR2-000B-page").map((f) => [f.id, f] as const))(
    "%s: evidence is a verbatim slice at firstOffset, at most EVIDENCE_CAP",
    (_id, fx) => {
      const text = fixtureText(fx);
      for (const m of matchForms(text)) {
        expect(m.evidence.length).toBeGreaterThan(0);
        expect(m.evidence.length).toBeLessThanOrEqual(EVIDENCE_CAP);
        expect(text.slice(m.firstOffset, m.firstOffset + m.evidence.length)).toBe(m.evidence);
      }
    }
  );

  it("real margin: the furthest required marker ends at 188 (OREF, of 300) and 133 (Oregon REALTORS, of 250)", () => {
    const oref = OR_FIXTURES.filter((f) => f.id.startsWith("OR2-0") && f.id !== "OR2-000B-page");
    const orr = OR_FIXTURES.filter((f) => !f.id.startsWith("OR2-"));
    const longest = (fxs: typeof OR_FIXTURES) =>
      Math.max(...fxs.flatMap((f) => matchForms(fixtureText(f)).map((m) => m.evidence.length)));
    expect(longest(oref)).toBe(188);
    expect(longest(orr)).toBe(133);
  });
});

describe("BACKLOG-4106 K25 — OR window boundary sweeps (SYNTHETIC layouts)", () => {
  const registry = buildRegistry([OREF_PUBLISHER, ORR_PUBLISHER], OR_FORMS);
  const oref = OREF_PUBLISHER.header as MidLineHeader;
  const orr = ORR_PUBLISHER.header as CodePageHeader;

  it("windows are OREF −150/+300 and Oregon REALTORS 0/+250", () => {
    expect([oref.windowBefore, oref.windowAfter]).toEqual([150, 300]);
    expect([orr.windowBefore, orr.windowAfter]).toEqual([0, 250]);
  });

  /** `anchor` at offset `pad`; `marker` ending at `end` chars from the anchor (negative = before it). */
  function after(anchor: string, marker: string, end: number): string {
    const head = `${anchor}\n`;
    const fill = end - head.length - marker.length - 1;
    if (fill < 0) throw new Error("sweep out of range");
    return `${head}${".".repeat(fill)}\n${marker}\n`;
  }
  function before(anchor: string, marker: string, startBefore: number): string {
    // marker starts `startBefore` chars before the anchor.
    const fill = startBefore - marker.length - 2;
    if (fill < 0) throw new Error("sweep out of range");
    return `${marker}\n${".".repeat(fill)}\n${anchor}\n`;
  }

  const OREF_LINE = "OREF 001 | Released 01/2026 | Page 1 of 15";
  const OREF_MARK = "Oregon Real Estate Forms, LLC";
  it.each([297, 298, 299, 300, 301, 302, 303])("OREF name ending at +%i", (end) => {
    expect(ids(matchForms(after(OREF_LINE, OREF_MARK, end), registry))).toEqual(end <= 300 ? ["oref-001"] : []);
  });
  it.each([147, 148, 149, 150, 151, 152, 153])("OREF name starting at −%i", (start) => {
    expect(ids(matchForms(before(OREF_LINE, OREF_MARK, start), registry))).toEqual(start <= 150 ? ["oref-001"] : []);
  });

  const ORR_LINE = "Form 2.1 · Counteroffer to Real Estate Purchase and Sale Agreement · Version 2026-2 Page 1 of 1";
  const ORR_MARK = "Copyright © 2023 Oregon REALTORS®";
  it.each([247, 248, 249, 250, 251, 252, 253])("Oregon REALTORS © ending at +%i", (end) => {
    expect(ids(matchForms(after(ORR_LINE, ORR_MARK, end), registry))).toEqual(end <= 250 ? ["orr-2.1"] : []);
  });
});

describe("BACKLOG-4106 OR — whole-registry negatives", () => {
  it.each([
    ["an overlay-only page (SYNTHETIC)", "DocuSign Envelope ID: 00000000-0000-0000-0000-000000000000"],
    ["an OCR page token alone (SYNTHETIC)", "Page l of7"],
    ["body lines only", [SYNTH, SYNTH].join("\n")],
  ])("%s returns no form", (_name, text) => {
    expect(matchForms(text)).toEqual([]);
  });
});
