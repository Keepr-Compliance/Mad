/**
 * BACKLOG-3941 — form-header fixtures.
 *
 * Every non-synthetic line below is VERBATIM pdfjs output of a BLANK form (or a public bulletin),
 * produced by the same extractor loop as attachmentTextExtractionService.ts, and cited by source id
 * + sha256 + .txt line number. Only header lines are transcribed; form bodies are replaced by the
 * literal SYNTH line. No filled form is a source. A mechanical check (every non-SYNTH line appears
 * as a whole line in its source's text) is run before each commit; its output is on BACKLOG-3941.
 *
 * Near-miss fixtures (NM_*) recompose real lines so that exactly one guard fails; each line still
 * comes from the source named in its comment.
 */

export type SourceId = keyof typeof SOURCES;

export const SOURCES = {
  S1: { sha256: "d7f01baa1e844045f3d8e3a6b7ad5edd4dfce73b3c634d760a983c28b315ab68", what: "NWMLS Form 41 Rev. 8/24, blank, 3 pp." },
  S3a: { sha256: "b1416500a057c8e3697c40520b8bf2aa888c59a733e4d6b5b389bddb43fe2603", what: "NWMLS legal bulletin 219 (2021 forms revisions)" },
  S3b: { sha256: "c2fe0f09d458c13ca61c52573abfaab7a8dbafb612a9f6bc57fc73844e2ba248", what: "NWMLS legal bulletin 216 (2019 forms revisions)" },
  S3c: { sha256: "43f73fe7354e3b2a9adfd064e46563a68167a5e6cbaf39417ec5d6e9894c028e", what: "NWMLS legal bulletin 222 (2022 broker compensation)" },
  S3d: { sha256: "0bd0402f66ea94dd907ed6f08a5f2a19c036d6a1bb5b9515221907c2b5e6a671", what: "NWMLS legal bulletin 223 (2023 forms revisions)" },
  S4: { sha256: "eb48b97935e249b0816b7d6cdb3c8c8b24efc89313d131f92e864938ffd8407d", what: "NWMLS sample packet Rev. 10/22 (41C, 41, 1A-SWF), blank, 6 pp." },
  S5: { sha256: "c9eca32d17438c3dd47adf9b6ad819c5e70f299a5e50d1f3e54a62a258205dc4", what: "NWMLS Form 1A Rev. 3/21, blank, 3 pp." },
  S6: { sha256: "e40520f0efb6c297761f1157a6f5850634f1c5a4b845b1c7c24979b039642fe0", what: "NWMLS Form 1A Rev. 6/13, blank, 2 pp." },
  S7: { sha256: "d604c45b708ebaefd3e04209c92e45603a006d7288a38df19bd42d53a4cb5304", what: "NWMLS Form 21 Rev. 7/23, blank, 6 pp." },
  S8: { sha256: "437e0674b2de2b889f3ef6b578366a4f3e3db4500883b88ca0fe048b73180c46", what: "class handout packet of NWMLS forms, blank, 63 pp. (25 form codes)" },
  S9: { sha256: "47b0920e65afba27901143faeba499a4dd10706b8c0527b402a5da8ff93ccc3c", what: "class listings packet of NWMLS forms, blank, 116 pp." },
  S10: { sha256: "645a252ee6b2e762410a7933b5da44479016bd855a9f149fb8c94ab0983f9888", what: "NWMLS Form 22A Rev. 7/23, blank, SAMPLE-watermarked" },
} as const;

export const SYNTH = "[synthetic body — not form text]";

/** 13 synthetic lines (442 chars) — wider than the 400-char window, so blocks never share one. */
export const BODY: readonly string[] = Array.from({ length: 13 }, () => SYNTH);

export interface TextFixture {
  id: string;
  sources: readonly SourceId[];
  lines: readonly string[];
}

/** The fixture as extractor-shaped text (lines joined with "\n"). */
export function fixtureText(f: TextFixture): string {
  return f.lines.join("\n");
}

/** Form 21 Rev. 7/23 — every page's header (6 pages). */
export const S7_FORM_21: TextFixture = {
  id: "S7-21",
  sources: ["S7"],
  lines: [
    // S7 lines 1-4
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 6",
    ...BODY,
    // S7 lines 61-64
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 6",
    ...BODY,
    // S7 lines 181-184
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 3 of 6",
    ...BODY,
    // S7 lines 303-306
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 4 of 6",
    ...BODY,
    // S7 lines 419-422
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 5 of 6",
    ...BODY,
    // S7 lines 531-534
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 6 of 6",
    ...BODY,
  ],
};

/** Form 41 Rev. 8/24 — every page's header (3 pages), current title. */
export const S1_FORM_41: TextFixture = {
  id: "S1-41",
  sources: ["S1"],
  lines: [
    // S1 lines 1-4
    "Form 41 ©Copyright 2024",
    "Buyer Brokerage Services Agreement Northwest Multiple Listing Service",
    "Rev. 8/24 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S1 lines 93-96
    "Form 41 ©Copyright 2024",
    "Buyer Brokerage Services Agreement Northwest Multiple Listing Service",
    "Rev. 8/24 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S1 lines 181-184
    "Form 41 ©Copyright 2024",
    "Buyer Brokerage Services Agreement Northwest Multiple Listing Service",
    "Rev. 8/24 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
  ],
};

/** Form 41 Rev. 10/22 — both pages; older title (not a known title). */
export const S4_FORM_41: TextFixture = {
  id: "S4-41",
  sources: ["S4"],
  lines: [
    // S4 lines 105-108
    "Form 41 ©Copyright 2022",
    "Exclusive Buyer’s Agency Agreement Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S4 lines 223-226
    "Form 41 ©Copyright 2022",
    "Exclusive Buyer’s Agency Agreement Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
  ],
};

/** Form 1A Rev. 3/21 — every page's header (3 pages). */
export const S5_FORM_1A: TextFixture = {
  id: "S5-1A",
  sources: ["S5"],
  lines: [
    // S5 lines 1-4
    "Form 1A ©Copyright 2021",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S5 lines 105-108
    "Form 1A ©Copyright 2021",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S5 lines 208-211
    "Form 1A ©Copyright 2021",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
  ],
};

/** Form 1A Rev. 6/13 — every page's header (2 pages). */
export const S6_FORM_1A: TextFixture = {
  id: "S6-1A",
  sources: ["S6"],
  lines: [
    // S6 lines 1-4
    "Form 1A ©Copyright 2013",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 6/13 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S6 lines 110-113
    "Form 1A ©Copyright 2013",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 6/13 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
  ],
};

/** Form 36 Rev. 8/11 — 1 page, from the S8 packet. */
export const S8_FORM_36: TextFixture = {
  id: "S8-36",
  sources: ["S8"],
  lines: [
    // S8 lines 4282-4285
    "Form 36 ©Copyright 2011",
    "Counteroffer Addendum Northwest Multiple Listing Service",
    "Rev. 8/11 ALL RIGHTS RESERVED",
    "Page 1 of 1 COUNTEROFFER ADDENDUM",
    ...BODY,
  ],
};

/** Form 1A-SWF Rev. 10/22 — every page's header (3 pages). */
export const S4_FORM_1A_SWF: TextFixture = {
  id: "S4-1A-SWF",
  sources: ["S4"],
  lines: [
    // S4 lines 315-318
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S4 lines 445-448
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S4 lines 573-576
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
  ],
};

/** Form 41C Rev. 10/22 — 1 page. */
export const S4_FORM_41C: TextFixture = {
  id: "S4-41C",
  sources: ["S4"],
  lines: [
    // S4 lines 1-4
    "Form 41C ©Copyright 2022",
    "Buyer Brokerage Firm’s Compensation Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
  ],
};

/** Form 41C Rev. 7/23 — 1 page, from the S8 packet. */
export const S8_FORM_41C: TextFixture = {
  id: "S8-41C",
  sources: ["S8"],
  lines: [
    // S8 lines 4432-4435
    "Form 41C ©Copyright 2023",
    "Buyer Brokerage Firm’s Compensation Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
  ],
};

/** Form 36A Rev. 3/21 — 1 page, from the S8 packet. */
export const S8_FORM_36A: TextFixture = {
  id: "S8-36A",
  sources: ["S8"],
  lines: [
    // S8 lines 4337-4340
    "Form 36A ©Copyright 2021",
    "Offer/Counteroffer Withdrawal Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1 WITHDRAWAL OF OFFER OR COUNTEROFFER",
    ...BODY,
  ],
};

/** Form 54 Rev. 3/21 — 1 page, from the S9 packet. */
export const S9_FORM_54: TextFixture = {
  id: "S9-54",
  sources: ["S9"],
  lines: [
    // S9 lines 5526-5529
    "Form 54 ©Copyright 2021",
    "Termination of Seller Rep. Agreement Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1 TERMINATION OF SELLER",
    ...BODY,
  ],
};

/** S4 as one attachment: 41C, 41 (2 pp.), 1A-SWF (3 pp.), in packet order. */
export const S4_PACKET: TextFixture = {
  id: "S4-packet",
  sources: ["S4"],
  lines: [
    // S4 lines 1-4
    "Form 41C ©Copyright 2022",
    "Buyer Brokerage Firm’s Compensation Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S4 lines 105-108
    "Form 41 ©Copyright 2022",
    "Exclusive Buyer’s Agency Agreement Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S4 lines 223-226
    "Form 41 ©Copyright 2022",
    "Exclusive Buyer’s Agency Agreement Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
    // S4 lines 315-318
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S4 lines 445-448
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S4 lines 573-576
    "Form 1A-SWF ©Copyright 2022",
    "Exclusive Sale Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
  ],
};

/** S8 as one attachment: every code line's header block (41 blocks, 25 codes), in packet order. */
export const S8_BUNDLE: TextFixture = {
  id: "S8-bundle",
  sources: ["S8"],
  lines: [
    // S8 lines 598-601
    "Form 17 ©Copyright 2021",
    "Seller Disclosure Statement Northwest Multiple Listing Service",
    "Rev. 8/21 ALL RIGHTS RESERVED",
    "Page 1 of 6",
    ...BODY,
    // S8 lines 713-716
    "Form 17 ©Copyright 2021",
    "Seller Disclosure Statement Northwest Multiple Listing Service",
    "Rev. 8/21 ALL RIGHTS RESERVED",
    "Page 2 of 6 (Continued)",
    ...BODY,
    // S8 lines 817-820
    "Form 17 ©Copyright 2021",
    "Seller Disclosure Statement Northwest Multiple Listing Service",
    "Rev. 8/21 ALL RIGHTS RESERVED",
    "Page 3 of 6 (Continued)",
    ...BODY,
    // S8 lines 921-924
    "Form 17 ©Copyright 2021",
    "Seller Disclosure Statement Northwest Multiple Listing Service",
    "Rev. 8/21 ALL RIGHTS RESERVED",
    "Page 4 of 6 (Continued)",
    ...BODY,
    // S8 lines 1133-1139
    "Form 17",
    "Seller Disclosure Statement",
    "Rev. 8/21",
    "©Copyright 20\u0015\u0014",
    "Northwest Multiple Listing Service",
    "ALL RIGHTS RESERVED",
    "Page 5 of 6 (Continued)",
    ...BODY,
    // S8 lines 1140-1143
    "Form 17 ©Copyright 2021",
    "Seller Disclosure Statement Northwest Multiple Listing Service",
    "Rev. 8/21 ALL RIGHTS RESERVED",
    "Page 6 of 6 (Continued)",
    ...BODY,
    // S8 lines 1244-1247
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 6",
    ...BODY,
    // S8 lines 1307-1310
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 6",
    ...BODY,
    // S8 lines 1427-1430
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 3 of 6",
    ...BODY,
    // S8 lines 1549-1552
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 4 of 6",
    ...BODY,
    // S8 lines 1665-1668
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 5 of 6",
    ...BODY,
    // S8 lines 1777-1780
    "Form 21 ©Copyright 2023",
    "Residential PSA Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 6 of 6",
    ...BODY,
    // S8 lines 1845-1848
    "Form 34 ©Copyright 2010",
    "Addendum/Amendment to P&S Northwest Multiple Listing Service",
    "Rev. 7/10 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 1892-1895
    "Form 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S8 lines 1988-1991
    "Form 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S8 lines 2094-2097
    "Form 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
    // S8 lines 2174-2177
    "Form 22B ©Copyright 2023",
    "Buyer’s Property Contingency Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S8 lines 2271-2274
    "Form 22B ©Copyright 2023",
    "Buyer’s Property Contingency Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
    // S8 lines 2358-2361
    "Form 39 ©Copyright 2023",
    "Second Buyer’s Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 2452-2455
    "Form 22Q ©Copyright 2017",
    "Buyer’s Pending Sale Northwest Multiple Listing Service",
    "Rev. 2/17 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 2526-2529
    "Form 22D ©Copyright 2021",
    "Optional Clauses Addendum Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S8 lines 2613-2616
    "Form 22D ©Copyright 2021",
    "Optional Clauses Addendum Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
    // S8 lines 2824-2827
    "Form 22EF ©Copyright 2023",
    "Evidence of Funds Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 2958-2961
    "Form 22J ©Copyright 2023",
    "Lead Based Paint Disclosure Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S8 lines 3027-3030
    "Form 22J ©Copyright 2023",
    "Lead Based Paint Disclosure Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
    // S8 lines 3117-3120
    "Form 22K ©Copyright 2021",
    "Identification of Utilities Addendum Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 3635-3638
    "Form 22T ©Copyright 2023",
    "Title Contingency Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 3694-3697
    "Form 22VV ©Copyright 2015",
    "Homeowner Insurance Addendum Northwest Multiple Listing Service",
    "Rev. 7/15 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 3745-3748
    "Form 22Y ©Copyright 2017",
    "Modification of Closing Date Northwest Multiple Listing Service",
    "Rev. 2/17 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 3804-3807
    "Form 35 ©Copyright 2023",
    "Inspection Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 2",
    ...BODY,
    // S8 lines 3905-3908
    "Form 35 ©Copyright 2023",
    "Inspection Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 2",
    ...BODY,
    // S8 lines 4012-4015
    "Form 35W ©Copyright 2021",
    "Inspection Waiver Addendum Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4105-4108
    "Form 35C ©Copyright 2023",
    "Seller Request – Inspection Report Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4137-4140
    "Form 35R ©Copyright 2023",
    "Inspection Response for Form 35 Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4231-4234
    "Form 41D ©Copyright 2010",
    "Inspector Referral Disclosure Northwest Multiple Listing Service",
    "Rev. 7/10 ALL RIGHTS RESERVED",
    "Page 1 of 1 INSPECTOR REFERRAL DISCLOSURE",
    ...BODY,
    // S8 lines 4282-4285
    "Form 36 ©Copyright 2011",
    "Counteroffer Addendum Northwest Multiple Listing Service",
    "Rev. 8/11 ALL RIGHTS RESERVED",
    "Page 1 of 1 COUNTEROFFER ADDENDUM",
    ...BODY,
    // S8 lines 4337-4340
    "Form 36A ©Copyright 2021",
    "Offer/Counteroffer Withdrawal Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1 WITHDRAWAL OF OFFER OR COUNTEROFFER",
    ...BODY,
    // S8 lines 4362-4365
    "Form 38A ©Copyright 2021",
    "Back-Up Addendum Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4432-4435
    "Form 41C ©Copyright 2023",
    "Buyer Brokerage Firm’s Compensation Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4514-4517
    "Form 50 ©Copyright 2021",
    "Authorization to Disburse Earnest Money Northwest Multiple Listing Service",
    "Rev. 3/21 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
    // S8 lines 4560-4563
    "Form 51 ©Copyright 2022",
    "Rescission Agreement Northwest Multiple Listing Service",
    "Rev. 10/22 ALL RIGHTS RESERVED",
    "Page 1 of 1 RESCISSION AGREEMENT",
    ...BODY,
  ],
};

/** Layout B (one item per line, truncated ©Copyright line) — the longest real header block; unregistered code 17. */
export const S8_FORM_17_LAYOUT_B: TextFixture = {
  id: "S8-17-layoutB",
  sources: ["S8"],
  lines: [
    // S8 lines 1133-1139
    "Form 17",
    "Seller Disclosure Statement",
    "Rev. 8/21",
    "©Copyright 20\u0015\u0014",
    "Northwest Multiple Listing Service",
    "ALL RIGHTS RESERVED",
    "Page 5 of 6 (Continued)",
    ...BODY,
  ],
};

/** Bulletin: names the publisher and lists form codes in prose. */
export const S3A_BULLETIN: TextFixture = {
  id: "S3a-neg",
  sources: ["S3a"],
  lines: [
    // S3a lines 1, 2, 3, 4, 5, 6
    "Page 1 of 12",
    "Northwest Multiple Listing Service",
    "Legal Bulletin 219 – 2/2021",
    "Legal Bulletin No. 219",
    "2021 Forms Revisions",
    "By Northwest Multiple Listing Service",
    // S3a lines 18, 19, 20, 21
    " Listing Agreements (Form 1A and 1B)",
    " Purchase and Sale Agreements (Form 20, 21, 23, 25, and 28)",
    " Financing Addendum (Form 22A)",
    " Increased Down Payment for Low Appraisal Addendum (Form 22AD)",
  ],
};

/** Bulletin: names the publisher and lists form codes in prose. */
export const S3B_BULLETIN: TextFixture = {
  id: "S3b-neg",
  sources: ["S3b"],
  lines: [
    // S3b lines 1, 2, 3, 4, 5, 6
    "Page 1 of 5",
    "Northwest Multiple Listing Service",
    "Legal Bulletin 216 – 6/2019",
    "Legal Bulletin 216",
    "2019 Forms Revisions",
    "By Northwest Multiple Listing Service",
    // S3b lines 16, 17, 18, 19
    " Listing Agreements (Form 1A and 1B)",
    " Seller Disclosure Statements (Form 17 and 17C)",
    " Purchase and Sale Agreements (Form 20, 21, 23, 25, and 28)",
    " Financing Addendum (Form 22A)",
  ],
};

/** Bulletin: publisher + a prose line that STARTS with a registered code (`Form 41C may be used …`). */
export const S3C_BULLETIN: TextFixture = {
  id: "S3c-neg",
  sources: ["S3c"],
  lines: [
    // S3c lines 1, 2, 3, 4, 5, 6
    "STATEWIDE FORMS",
    "Page 1 of 5",
    "Legal Bulletin 222",
    "Statewide Forms",
    "Broker Compensation",
    "By Northwest Multiple Listing Service",
    // S3c lines 66, 67, 70
    "b. Buyer Brokerage Compensation Agreement (Form 41C)",
    "The Buyer Brokerage Firm’s Compensation Addendum (Form 41C) will be revised to",
    "Form 41C may be used to modify the buyer broker’s compensation.",
  ],
};

/** Bulletin: names the publisher and lists form codes in prose. */
export const S3D_BULLETIN: TextFixture = {
  id: "S3d-neg",
  sources: ["S3d"],
  lines: [
    // S3d lines 1, 2, 3, 4
    "Legal Bulletin No. 223",
    "2023 Forms Revisions",
    "By Northwest Multiple Listing Service",
    "June 20, 2023",
    // S3d lines 14, 15, 16, 17
    "• Listing Agreements/Addenda (Form 1A, 1B, 1C, 16A, 16B, 16C, 63, 63A)",
    "• Purchase and Sale Agreements (Form 20, 21, 23, 25, 28)",
    "• Financing Addendum (Form 22A)",
    "• Appraisal Addendum (Form 22AA)",
  ],
};

/** SAMPLE watermark glued onto the code line — fails R1 on every page. */
export const S10_SAMPLE_22A: TextFixture = {
  id: "S10-neg",
  sources: ["S10"],
  lines: [
    // S10 lines 1-4
    "SAMPLEForm 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S10 lines 96-99
    "SAMPLEForm 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 2 of 3",
    ...BODY,
    // S10 lines 202-205
    "SAMPLEForm 22A ©Copyright 2023",
    "Financing Addendum Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 3 of 3",
    ...BODY,
  ],
};

/** Near-miss R1: prose line starting with a registered code, then a real 41C header's remaining lines. */
export const NM_WHOLE_LINE: TextFixture = {
  id: "nm-wholeLine",
  sources: ["S3c", "S8"],
  lines: [
    // S3c line 70 — prose, not a code line
    "Form 41C may be used to modify the buyer broker’s compensation.",
    // S8 lines 4433, 4434, 4435 — Form 41C header minus its code line
    "Buyer Brokerage Firm’s Compensation Northwest Multiple Listing Service",
    "Rev. 7/23 ALL RIGHTS RESERVED",
    "Page 1 of 1",
    ...BODY,
  ],
};

/** Near-miss R3: Form 41 header without its title/publisher line; the publisher's name appears only past the window. */
export const NM_PUBLISHER: TextFixture = {
  id: "nm-pub",
  sources: ["S1", "S3a"],
  lines: [
    // S1 lines 1, 3, 4 — Form 41 header minus line 2
    "Form 41 ©Copyright 2024",
    "Rev. 8/24 ALL RIGHTS RESERVED",
    "Page 1 of 3",
    ...BODY,
    // S3a line 6 — publisher name, outside the window
    "By Northwest Multiple Listing Service",
  ],
};

/** Near-miss R4: Form 41 header whose Rev. line carries no ALL RIGHTS RESERVED. */
export const NM_RIGHTS_RESERVED: TextFixture = {
  id: "nm-arr",
  sources: ["S1", "S8"],
  lines: [
    // S1 lines 1, 2
    "Form 41 ©Copyright 2024",
    "Buyer Brokerage Services Agreement Northwest Multiple Listing Service",
    // S8 line 1135 — Rev. without ALL RIGHTS RESERVED
    "Rev. 8/21",
    // S1 line 4
    "Page 1 of 3",
    ...BODY,
  ],
};

/** Near-miss R5: Form 41 header whose ALL RIGHTS RESERVED line carries no Rev. */
export const NM_REVISION: TextFixture = {
  id: "nm-rev",
  sources: ["S1", "S8"],
  lines: [
    // S1 lines 1, 2
    "Form 41 ©Copyright 2024",
    "Buyer Brokerage Services Agreement Northwest Multiple Listing Service",
    // S8 line 1138 — ALL RIGHTS RESERVED without Rev.
    "ALL RIGHTS RESERVED",
    // S1 line 4
    "Page 1 of 3",
    ...BODY,
  ],
};

/** Every fixture, keyed by id (registry rows cite these ids in sampleProvenance). */
export const ALL_FIXTURES: readonly TextFixture[] = [
  S7_FORM_21,
  S1_FORM_41,
  S4_FORM_41,
  S5_FORM_1A,
  S6_FORM_1A,
  S8_FORM_36,
  S4_FORM_1A_SWF,
  S4_FORM_41C,
  S8_FORM_41C,
  S8_FORM_36A,
  S9_FORM_54,
  S4_PACKET,
  S8_BUNDLE,
  S8_FORM_17_LAYOUT_B,
  S3A_BULLETIN,
  S3B_BULLETIN,
  S3C_BULLETIN,
  S3D_BULLETIN,
  S10_SAMPLE_22A,
  NM_WHOLE_LINE,
  NM_PUBLISHER,
  NM_RIGHTS_RESERVED,
  NM_REVISION,
];
