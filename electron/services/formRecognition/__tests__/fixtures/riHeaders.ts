/**
 * BACKLOG-4106 — Rhode Island form-header fixtures. Same rules as nwmlsHeaders.ts: every non-synthetic
 * line is VERBATIM pdfjs text of a BLANK form (or a forms handout used as a negative), cited by source
 * id + .txt line number, copied by script. Only header, title and footer lines are transcribed;
 * bodies are the literal SYNTH line, or a `fill(n)` line of dots (SYNTHETIC layout) where the team
 * addendum keeps its source offsets (its only revision is the last line, +3,626 from the title).
 * The purchase agreement's footer lines carry a vendor stamp and are not transcribed. A mechanical
 * check (every non-SYNTH line is a whole line of its source text) runs before each commit; its
 * output is on BACKLOG-4106.
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";
import { fill } from "./caHeaders";

export const RI_SOURCES = {
  RI1: { sha256: "2a987fc5770298ce0619d0ee99dd48399eabf0697fb8da725b8b2d0b448a8d60", what: "RI Mandatory Real Estate Relationship Disclosure, Rev. 03/22, blank, 2 pp." },
  RI2: { sha256: "48756d5c35f91920c24408390840a5fd430d3f3034f4ccb2d7ee3221e1dad383", what: "Addendum to the RI Mandatory Relationship Disclosure for Real Estate Teams, Rev. 03/22, blank, 1 p." },
  RI3: { sha256: "1927d5aae13a3c2b76c8b45ccb80563034aeced5300e5fcd3f3ba7eff04322e5", what: "RIAR Real Estate Sales Disclosure Form, Rev 05/19, blank, 6 pp." },
  RI4: { sha256: "04c2a3393abe9ec6f253c0e3dc30ed8511805eff516cfe28dcb944bd7c4f8d4b", what: "RIAR Single Family Purchase and Sales Agreement, Rev. 01/19, blank, 4 pp." },
  RI5: { sha256: "04f67e21b54c5bca89a36124f5e84c03fd1e532865d47bc0854baf542b6e2ffd", what: "RIAR new and revised forms handout, Rev. 07/15/24 (not a form; negative)" },
} as const;

export type RiSourceId = keyof typeof RI_SOURCES;
export type RiFixture = TextFixture<RiSourceId>;

/** MRED 03/22 — page 1's page/revision line, title and bare draft date; page 2's page/revision line. */
export const RI1_MRED: RiFixture = {
  id: "RI1-MRED",
  sources: ["RI1"],
  lines: [
    // RI1 lines 1, 2, 3
    "Page 1 of 2Rev. 03/22",
    "RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE",
    "3-18-22",
    ...BODY,
    // RI1 line 49
    "Page 2 of 2Rev. 03/22",
    ...BODY,
  ],
};

/** Team addendum 03/22 — the 2-line title and the last line (its only revision) at their source offsets. */
export const RI2_MRED_TEAM: RiFixture = {
  id: "RI2-TEAM",
  sources: ["RI2"],
  lines: [
    "ADDENDUM TO RI MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE", // RI2 line 1
    "FOR REAL ESTATE TEAMS", // RI2 line 2
    fill(3542), // RI2 lines 3-44: same span, not transcribed
    "Rev. 03/22", // RI2 line 45
  ],
};

/** RIAR Sales Disclosure 05/19 — page 1's revision/page line, title and publisher line; every later page's footer and revision/page line (`Rev` first, no dot). */
export const RI3_RIAR_SALES_DISCLOSURE: RiFixture = {
  id: "RI3-SD",
  sources: ["RI3"],
  lines: [
    // RI3 lines 1, 2, 3
    "Rev 05/19 Page 1 of 6",
    "RHODE ISLAND REAL ESTATE SALES DISCLOSURE FORM",
    "Rhode Island Association of REALTORS®",
    ...BODY,
    // RI3 lines 61, 62
    "BUYER’S INITIALS __________ SELLER’S INITIALS ___________ Copyright© 2019 Rhode Island Association of REALTORS®",
    "Rev 05/19 Page 2 of 6",
    ...BODY,
    // RI3 lines 121, 122
    "BUYER’S INITIALS __________ SELLER’S INITIALS ___________ Copyright© 2019 Rhode Island Association of REALTORS®",
    "Rev 05/19 Page 3 of 6",
    ...BODY,
    // RI3 lines 175, 176
    "BUYER’S INITIALS __________ SELLER’S INITIALS ___________ Copyright© 2019 Rhode Island Association of REALTORS®",
    "Rev 05/19 Page 4 of 6",
    ...BODY,
    // RI3 lines 230, 231
    "BUYER’S INITIALS __________ SELLER’S INITIALS ___________ Copyright© 2019 Rhode Island Association of REALTORS®",
    "Rev 05/19 Page 5 of 6",
    ...BODY,
    // RI3 lines 289, 290
    "BUYER’S INITIALS __________ SELLER’S INITIALS ___________ Copyright© 2019 Rhode Island Association of REALTORS®",
    "Rev 05/19 Page 6 of 6",
    ...BODY,
  ],
};

/** RIAR Single Family P&S 01/19 — page 1's page/revision line (glued), title and publisher line; every later page's page/revision line. */
export const RI4_RIAR_SF_PS: RiFixture = {
  id: "RI4-PS",
  sources: ["RI4"],
  lines: [
    // RI4 lines 1, 2, 3
    "Page 1 of 4Rev. 01/19",
    "SINGLE FAMILY PURCHASE AND SALES AGREEMENT",
    "Rhode Island Association of REALTORS®",
    ...BODY,
    // RI4 line 65
    "Page 2 of 4Rev. 01/19",
    ...BODY,
    // RI4 line 125
    "Page 3 of 4Rev. 01/19",
    ...BODY,
    // RI4 line 189
    "Page 4 of 4Rev. 01/19",
    ...BODY,
  ],
};

/** NEGATIVE: the forms handout's title, its `Rev. 07/15/24` date and a heading naming a RIAR form. */
export const RI5_HANDOUT: RiFixture = {
  id: "RI5-HANDOUT",
  sources: ["RI5"],
  lines: [
    // RI5 lines 1, 2
    "NEW AND REVISED FORMS",
    "Rev. 07/15/24",
    ...BODY,
    // RI5 line 174
    "CHANGES TO RIAR PURCHASE AND SALES AGREEMENTS",
    ...BODY,
  ],
};

export const RI_FIXTURES: readonly RiFixture[] = [RI1_MRED, RI2_MRED_TEAM, RI3_RIAR_SALES_DISCLOSURE, RI4_RIAR_SF_PS, RI5_HANDOUT];
