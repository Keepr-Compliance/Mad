/**
 * BACKLOG-3941 — matcher controls C1–C11 (plan §7). Each guard R1–R5 has a minimal-pair
 * near-miss: on whole real documents the guards are redundant, so a whole-document negative
 * cannot show any single guard is load-bearing.
 */
import { inferRegion, matchForms, normalizeFormText } from "../formMatcher";
import { NWMLS_PUBLISHER } from "../publishers";
import {
  NM_PUBLISHER,
  NM_REVISION,
  NM_RIGHTS_RESERVED,
  NM_WHOLE_LINE,
  S10_SAMPLE_22A,
  S1_FORM_41,
  S3A_BULLETIN,
  S3B_BULLETIN,
  S3C_BULLETIN,
  S3D_BULLETIN,
  S4_FORM_1A_SWF,
  S4_FORM_41,
  S4_FORM_41C,
  S4_PACKET,
  S5_FORM_1A,
  S7_FORM_21,
  S8_BUNDLE,
  S8_FORM_17_LAYOUT_B,
  S8_FORM_36,
  S8_FORM_36A,
  fixtureText,
} from "./fixtures/nwmlsHeaders";
import type { FormMatch } from "../formRegistryTypes";

const ids = (ms: FormMatch[]) => ms.map((m) => m.formId ?? `?${m.code}`);

describe("BACKLOG-3941 matchForms — positives", () => {
  it("Form 21 (S7): one match, every page counted, title seen", () => {
    const ms = matchForms(fixtureText(S7_FORM_21));
    expect(ids(ms)).toEqual(["nwmls-21"]);
    expect(ms[0]).toMatchObject({
      publisherId: "nwmls",
      code: "21",
      kind: "purchase_agreement",
      strength: "footer+title",
      occurrences: 6,
      firstOffset: 0,
      revisionSeen: "7/23",
    });
  });

  it("evidence is a verbatim slice of the input at firstOffset, within the window", () => {
    const text = fixtureText(S1_FORM_41);
    const [m] = matchForms(text);
    expect(m.evidence.length).toBeGreaterThan(0);
    expect(m.evidence.length).toBeLessThanOrEqual(NWMLS_PUBLISHER.header.windowChars);
    expect(text.slice(m.firstOffset, m.firstOffset + m.evidence.length)).toBe(m.evidence);
  });
});

describe("BACKLOG-3941 C1–C5 — one near-miss per guard", () => {
  it("control: the unbroken S1 header matches", () => {
    expect(ids(matchForms(fixtureText(S1_FORM_41)))).toEqual(["nwmls-41"]);
  });

  it("C1 (R1): a prose line starting with a registered code is not a code line", () => {
    expect(matchForms(fixtureText(NM_WHOLE_LINE))).toEqual([]);
  });

  it("C1 (R1): a SAMPLE watermark glued onto the code line fails R1 on every page", () => {
    expect(matchForms(fixtureText(S10_SAMPLE_22A))).toEqual([]);
  });

  it("C2 (R2): the whole code token is looked up exactly — 41C, 1A-SWF and 36A are their own rows", () => {
    expect(ids(matchForms(fixtureText(S4_FORM_41C)))).toEqual(["nwmls-41C"]);
    expect(ids(matchForms(fixtureText(S4_FORM_1A_SWF)))).toEqual(["nwmls-1A-SWF"]);
    expect(ids(matchForms(fixtureText(S8_FORM_36A)))).toEqual(["nwmls-36A"]);
    // …and the shorter siblings are still themselves.
    expect(ids(matchForms(fixtureText(S5_FORM_1A)))).toEqual(["nwmls-1A"]);
    expect(ids(matchForms(fixtureText(S8_FORM_36)))).toEqual(["nwmls-36"]);
  });

  it("C3 (R3): the publisher's name only outside the window does not count", () => {
    expect(matchForms(fixtureText(NM_PUBLISHER))).toEqual([]);
  });

  it("C4 (R4): no ALL RIGHTS RESERVED in the window, no match", () => {
    expect(matchForms(fixtureText(NM_RIGHTS_RESERVED))).toEqual([]);
  });

  it("C5 (R5): no Rev. M/YY in the window, no match", () => {
    expect(matchForms(fixtureText(NM_REVISION))).toEqual([]);
  });
});

describe("BACKLOG-3941 C6 — a bundle returns every form", () => {
  it("S4 packet: 41C, 41, 1A-SWF in packet order", () => {
    const ms = matchForms(fixtureText(S4_PACKET));
    expect(ids(ms)).toEqual(["nwmls-41C", "nwmls-41", "nwmls-1A-SWF"]);
    expect(ms.map((m) => m.occurrences)).toEqual([1, 2, 3]);
  });

  it("S8 packet: all 25 codes, registered and unregistered, with per-code counts", () => {
    // Expected set derived from the source, not from the matcher:
    //   grep -oE "^Form [0-9][0-9A-Z-]*( ©Copyright [0-9]{4})?$" <S8 .txt> | sort | uniq -c
    // -> 25 distinct codes; Form 17 has 5 layout-A code lines + 1 bare layout-B line.
    const ms = matchForms(fixtureText(S8_BUNDLE));
    expect(ms.map((m) => [m.formId ?? `?${m.code}`, m.occurrences])).toEqual([
      ["?17", 6],
      ["nwmls-21", 6],
      ["?34", 1],
      ["?22A", 3],
      ["?22B", 2],
      ["?39", 1],
      ["?22Q", 1],
      ["?22D", 2],
      ["?22EF", 1],
      ["?22J", 2],
      ["?22K", 1],
      ["?22T", 1],
      ["?22VV", 1],
      ["?22Y", 1],
      ["?35", 2],
      ["?35W", 1],
      ["?35C", 1],
      ["?35R", 1],
      ["?41D", 1],
      ["nwmls-36", 1],
      ["nwmls-36A", 1],
      ["?38A", 1],
      ["nwmls-41C", 1],
      ["?50", 1],
      ["?51", 1],
    ]);
    const unregistered = ms.filter((m) => m.formId === null);
    expect(unregistered.every((m) => m.kind === null)).toBe(true);
  });
});

describe("BACKLOG-3941 C7 — revision and title are never gates", () => {
  it("Form 41 Rev. 10/22 under its old title still matches, at strength footer", () => {
    const [m] = matchForms(fixtureText(S4_FORM_41));
    expect(m).toMatchObject({ formId: "nwmls-41", strength: "footer", revisionSeen: "10/22" });
  });

  it("Form 41 Rev. 8/24 under its current title matches at strength footer+title", () => {
    const [m] = matchForms(fixtureText(S1_FORM_41));
    expect(m).toMatchObject({ formId: "nwmls-41", strength: "footer+title", revisionSeen: "8/24" });
  });

  it("an unseen revision still matches (SYNTHETIC: S1 with Rev. 8/24 rewritten to Rev. 8/26)", () => {
    const bumped = fixtureText(S1_FORM_41).split("Rev. 8/24").join("Rev. 8/26");
    const [m] = matchForms(bumped);
    expect(m).toMatchObject({ formId: "nwmls-41", revisionSeen: "8/26" });
  });
});

describe("BACKLOG-3941 C8 — real negatives", () => {
  it.each([
    ["S3a", S3A_BULLETIN],
    ["S3b", S3B_BULLETIN],
    ["S3c", S3C_BULLETIN],
    ["S3d", S3D_BULLETIN],
    ["S10", S10_SAMPLE_22A],
  ])("%s returns no form", (_id, fx) => {
    expect(matchForms(fixtureText(fx))).toEqual([]);
  });
});

describe("BACKLOG-3941 C9 — inferRegion", () => {
  it("one registered NWMLS form -> WA", () => {
    expect(inferRegion(matchForms(fixtureText(S1_FORM_41)))).toEqual([
      { state: "WA", publisherId: "nwmls", forms: 1 },
    ]);
  });

  it("counts distinct registered forms in a bundle", () => {
    expect(inferRegion(matchForms(fixtureText(S4_PACKET)))).toEqual([
      { state: "WA", publisherId: "nwmls", forms: 3 },
    ]);
  });

  it("unregistered codes alone infer nothing", () => {
    const ms = matchForms(fixtureText(S8_FORM_17_LAYOUT_B));
    expect(ms).toHaveLength(1);
    expect(ms[0].formId).toBeNull();
    expect(inferRegion(ms)).toEqual([]);
  });
});

describe("BACKLOG-3941 C10 — empty / scanned", () => {
  it.each([[""], ["   "], ["\n\n  \t\n"]])("%j returns []", (text) => {
    expect(matchForms(text)).toEqual([]);
  });
});

describe("BACKLOG-3941 C11 — window: 400 chars from the start of the code line", () => {
  const W = NWMLS_PUBLISHER.header.windowChars;
  const CODE = "Form 41 ©Copyright 2024";

  it("window is 400", () => {
    expect(W).toBe(400);
  });

  // SYNTHETIC layout: the code line, the other two markers on the next line, filler, then the
  // swept marker positioned so its match ENDS at `end` chars from the start of the code line.
  function placed(others: string, marker: string, end: number): string {
    const head = `${CODE}\n${others}\n`;
    const fill = end - head.length - marker.length - 1;
    if (fill < 0) throw new Error("sweep out of range");
    return `${head}${".".repeat(fill)}\n${marker}\n`;
  }

  const cases: Array<[string, string, string]> = [
    ["publisher", "Rev. 8/24 ALL RIGHTS RESERVED", "Northwest Multiple Listing Service"],
    ["rights", "Northwest Multiple Listing Service Rev. 8/24", "ALL RIGHTS RESERVED"],
    ["revision", "Northwest Multiple Listing Service ALL RIGHTS RESERVED", "Rev. 8/24"],
  ];

  describe.each(cases)("%s marker", (_name, others, marker) => {
    it.each([W - 3, W - 2, W - 1, W, W + 1, W + 2, W + 3])("ending at %i", (end) => {
      const ms = matchForms(placed(others, marker, end));
      expect(ids(ms)).toEqual(end <= W ? ["nwmls-41"] : []);
    });
  });

  it("real margin: every header block of the 41-block S8 packet matches, the longest ending at 128 of 400", () => {
    // Measured over every blank source in the bank at W=800: no header block's furthest
    // required marker ends past 128 chars; no bulletin or SAMPLE page matches at any width
    // from 150 to 800. The sweep is recorded on BACKLOG-3941.
    const ms = matchForms(fixtureText(S8_BUNDLE));
    expect(ms.reduce((n, m) => n + m.occurrences, 0)).toBe(41);
    expect(Math.max(...ms.map((m) => m.evidence.length))).toBe(128);
  });

  it("real margin: layout B (one item per line, truncated ©Copyright) matches, ending at 116", () => {
    const [m] = matchForms(fixtureText(S8_FORM_17_LAYOUT_B));
    expect(m.code).toBe("17");
    expect(m.evidence.length).toBe(116);
  });
});

describe("BACKLOG-3941 normalisation — length-preserving, newlines untouched", () => {
  it("never changes length and keeps every newline", () => {
    const s = "a‘b’c“d”e f g h\ti\n  j\n\nk";
    const n = normalizeFormText(s);
    expect(n.length).toBe(s.length);
    expect(n.split("\n").length).toBe(s.split("\n").length);
    expect(n).toBe("a'b'c\"d\"e f g h i\n  j\n\nk");
  });

  it("firstOffset indexes the ORIGINAL text when NBSP, tabs and double spaces precede the header", () => {
    const prefix = "Cover  note:\t\tsee  attached\n“quoted”   line\n";
    const text = prefix + fixtureText(S1_FORM_41);
    const [m] = matchForms(text);
    expect(m.firstOffset).toBe(prefix.length);
    expect(text.slice(m.firstOffset).startsWith("Form 41 ©Copyright 2024")).toBe(true);
  });

  it("NBSP inside the code line and a curly apostrophe in the title are tolerated", () => {
    const text = fixtureText(S1_FORM_41).replace("Form 41 ©", "Form 41 ©");
    expect(ids(matchForms(text))).toEqual(["nwmls-41"]);
    // The S4 41C title is printed with a curly apostrophe; the known title uses a straight one.
    expect(matchForms(fixtureText(S4_FORM_41C))[0].strength).toBe("footer+title");
  });
});
