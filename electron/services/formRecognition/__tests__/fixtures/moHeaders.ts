/**
 * BACKLOG-4106 — Missouri form-header fixtures. Same rules as nwmlsHeaders.ts: every non-synthetic
 * line is VERBATIM pdfjs text of a BLANK form, cited by source id + .txt line number, copied by
 * script. Only header, title and footer lines are transcribed; bodies are the literal SYNTH line, or
 * a `fill(n)` line of dots (SYNTHETIC layout) where the regulator's form keeps its source offsets
 * (its title prints mid-page, 3,034 chars in, and its prescription line 2,059 chars after it).
 * The DSC-8000 vendor line is not transcribed. A mechanical check (every non-SYNTH line is a whole
 * line of its source text) runs before each commit; its output is on BACKLOG-4106.
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";
import { fill } from "./caHeaders";

export const MO_SOURCES = {
  MO1: { sha256: "a73f36bd2f0df3050a69d61f762f3a55918176650834630f424dd4824e642ae9", what: "MREC Missouri Broker Disclosure Form (portrait), prescribed as of January, 2005, blank" },
  MO2: { sha256: "a1c795126c39418bfb59ab4ca0085a34676590356536a216902180bd92bfa995", what: "MREC Missouri Broker Disclosure Form (landscape), prescribed as of January, 2005, blank" },
  MO3: { sha256: "da0d336c1cf4aa1adf330baa8cce6db953dcd7644c4671bdc798aad2cfe307c7", what: "Missouri REALTORS RES-2000 Contract for Sale of Residential Real Estate, no revision printed, blank, 8 pp. (held)" },
  MO4: { sha256: "75647e035d2662cb7525585b6b1cd9078dfca76f5d150b1a807188b41576d908", what: "Missouri REALTORS DSC-8000 Seller's Disclosure Statement, Last Revised 12/31/09, blank, 6 pp." },
  MO5: { sha256: "20df8ed424a2b92fda8b5adddafdeccfacfff831565d35f494d8b7b4e6016a9b", what: "Missouri REALTORS RES-1010 Seller's Agency Listing Contract, Last Revised 12/31/12, blank, 6 pp." },
  MO6: { sha256: "96807549a2624c260edd5db25a973cd4ad95a40f7ba96b2787a98bfa3f0bb467", what: "KCRAR Residential Real Estate Sale Contract, Last revised September 2020, blank, 16 pp." },
} as const;

export type MoSourceId = keyof typeof MO_SOURCES;
export type MoFixture = TextFixture<MoSourceId>;

/** MREC portrait — the title (offset 3,034) and the prescription line (+2,059) at their source offsets. */
export const MO1_MREC_PORTRAIT: MoFixture = {
  id: "MO1-MREC",
  sources: ["MO1"],
  lines: [
    fill(3033), // MO1 lines 1-35: same span, not transcribed
    "MISSOURI BROKER DISCLOSURE FORM", // MO1 line 36
    fill(2026), // MO1 lines 37-74: same span, not transcribed
    "Prescribed by the Missouri Real Estate Commission as of January, 2005. This additional format prescribed October 2007 and April 2018.", // MO1 line 75
  ],
};

/** MREC landscape — the title (offset 0) and the prescription line (+1,239) at their source offsets. */
export const MO2_MREC_LANDSCAPE: MoFixture = {
  id: "MO2-MREC",
  sources: ["MO2"],
  lines: [
    "MISSOURI BROKER DISCLOSURE FORM", // MO2 line 1
    fill(1206), // MO2 lines 2-19: same span, not transcribed
    "Prescribed by the Missouri Real Estate Commission as of January, 2005", // MO2 line 20
  ],
};

/** RES-2000 — every page line (8 pages) and the © line. It prints no `Last Revised`: held under F4. */
export const MO3_MR_RES_2000: MoFixture = {
  id: "MO3-RES2000",
  sources: ["MO3"],
  lines: [
    // MO3 lines 1, 2, 3
    "Reference (e.g., Seller & Buyer)",
    "RES-2000 PAGE 1 OF 8",
    "Contract for Sale of Residential Real Estate",
    ...BODY,
    // MO3 line 97
    "RES-2000 PAGE 2 OF 8",
    ...BODY,
    // MO3 line 172
    "RES-2000 PAGE 3 OF 8",
    ...BODY,
    // MO3 line 241
    "RES-2000 PAGE 4 OF 8",
    ...BODY,
    // MO3 line 310
    "RES-2000 PAGE 5 OF 8",
    ...BODY,
    // MO3 line 374
    "RES-2000 PAGE 6 OF 8",
    ...BODY,
    // MO3 line 449
    "RES-2000 PAGE 7 OF 8",
    ...BODY,
    // MO3 line 509
    "RES-2000 PAGE 8 OF 8",
    ...BODY,
    // MO3 line 531
    "made. ©2015 Missouri REALTORS®",
    ...BODY,
  ],
};

/** DSC-8000 — the title, pages 1-5's page lines and the Last Revised line (page 6's page line is a vendor stamp: 5 of 6). */
export const MO4_MR_DSC_8000: MoFixture = {
  id: "MO4-DSC8000",
  sources: ["MO4"],
  lines: [
    // MO4 lines 1, 2
    "Seller's Disclosure Statement for Residential Property",
    "DSC-8000 Page 1 of 6",
    ...BODY,
    // MO4 line 52
    "DSC-8000 Page 2 of 6",
    ...BODY,
    // MO4 line 118
    "DSC-8000 Page 3 of 6",
    ...BODY,
    // MO4 line 185
    "DSC-8000 Page 4 of 6",
    ...BODY,
    // MO4 line 252
    "DSC-8000 Page 5 of 6",
    ...BODY,
    // MO4 line 394
    "Last Revised 12/31/09. ®2003 Missouri Association of Realtors",
    ...BODY,
  ],
};

/** RES-1010 — the title, every page line (6 pages) and the Last Revised line. */
export const MO5_MR_RES_1010: MoFixture = {
  id: "MO5-RES1010",
  sources: ["MO5"],
  lines: [
    // MO5 lines 2, 3, 4
    "Seller's Agency Listing Contract (Exclusive Right to Sell)",
    "This document has legal consequences. If you do not understand it, consult your attorney.",
    "RES-1010 Page 1 of 6",
    ...BODY,
    // MO5 line 126
    "RES-1010 Page 2 of 6",
    ...BODY,
    // MO5 line 267
    "RES-1010 Page 3 of 6",
    ...BODY,
    // MO5 line 412
    "RES-1010 Page 4 of 6",
    ...BODY,
    // MO5 line 455
    "amendments to this Listing Contract be made. Last Revised 12/31/12. ©2011 Missouri Association of REALTORS®",
    ...BODY,
    // MO5 line 595
    "RES-1010 Page 5 of 6",
    ...BODY,
    // MO5 line 649
    "RES-1010 Page 6 of 6",
    ...BODY,
  ],
};

/** KCRAR sale contract — every page's title and page line (16 pages), then the publisher and Last revised lines. */
export const MO6_KCRAR_SALE: MoFixture = {
  id: "MO6-KCRAR",
  sources: ["MO6"],
  lines: [
    // MO6 lines 1, 2
    "Residential Real Estate Sale Contract",
    "Page 1 of 16",
    ...BODY,
    // MO6 lines 55, 56
    "Residential Real Estate Sale Contract",
    "Page 2 of 16",
    ...BODY,
    // MO6 lines 109, 110
    "Residential Real Estate Sale Contract",
    "Page 3 of 16",
    ...BODY,
    // MO6 lines 167, 168
    "Residential Real Estate Sale Contract",
    "Page 4 of 16",
    ...BODY,
    // MO6 lines 223, 224
    "Residential Real Estate Sale Contract",
    "Page 5 of 16",
    ...BODY,
    // MO6 lines 278, 279
    "Residential Real Estate Sale Contract",
    "Page 6 of 16",
    ...BODY,
    // MO6 lines 338, 339
    "Residential Real Estate Sale Contract",
    "Page 7 of 16",
    ...BODY,
    // MO6 lines 395, 396
    "Residential Real Estate Sale Contract",
    "Page 8 of 16",
    ...BODY,
    // MO6 lines 453, 454
    "Residential Real Estate Sale Contract",
    "Page 9 of 16",
    ...BODY,
    // MO6 lines 508, 509
    "Residential Real Estate Sale Contract",
    "Page 10 of 16",
    ...BODY,
    // MO6 lines 567, 568
    "Residential Real Estate Sale Contract",
    "Page 11 of 16",
    ...BODY,
    // MO6 lines 629, 630
    "Residential Real Estate Sale Contract",
    "Page 12 of 16",
    ...BODY,
    // MO6 lines 688, 689
    "Residential Real Estate Sale Contract",
    "Page 13 of 16",
    ...BODY,
    // MO6 lines 752, 753
    "Residential Real Estate Sale Contract",
    "Page 14 of 16",
    ...BODY,
    // MO6 lines 809, 810
    "Residential Real Estate Sale Contract",
    "Page 15 of 16",
    ...BODY,
    // MO6 lines 867, 868
    "Residential Real Estate Sale Contract",
    "Page 16 of 16",
    ...BODY,
    // MO6 line 920
    "Approved by Legal Counsel of the Kansas City Regional Association of REALTORS® for exclusive use by its REALTOR® members. No",
    ...BODY,
    // MO6 line 923
    "this Contract be made. Last revised September 2020. All previous versions of this document may no longer be valid. Copyright January 2021.",
    ...BODY,
  ],
};

export const MO_FIXTURES: readonly MoFixture[] = [MO1_MREC_PORTRAIT, MO2_MREC_LANDSCAPE, MO3_MR_RES_2000, MO4_MR_DSC_8000, MO5_MR_RES_1010, MO6_KCRAR_SALE];
