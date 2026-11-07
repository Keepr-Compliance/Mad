/**
 * BACKLOG-4106 — Nevada form-header fixtures. Same rules as nwmlsHeaders.ts: every non-synthetic line
 * is VERBATIM pdfjs text of a BLANK form, cited by source id + .txt line number, copied by script.
 * Only header, title and footer lines are transcribed; bodies are the literal SYNTH line, or a
 * `fill(n)` line of dots (SYNTHETIC layout) where a fixture keeps the source's character offsets
 * (the regulator forms, whose markers sit far from the title). Stamp, contact and address lines fall
 * inside those spans and are never transcribed. A mechanical check (every non-SYNTH line is a whole
 * line of its source text; span fixtures match the source char-for-char outside the dots) runs
 * before each commit; its output is on BACKLOG-4106.
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";
import { fill } from "./caHeaders";

export const NV_SOURCES = {
  NV1: { sha256: "4bf6b521e3bf3b899e266bbd3aa825c68439afb5d6c43e1db7377113250ded4b", what: "GLVAR Residential Purchase Agreement Rev. 10/25, blank, 11 pp." },
  NV2: { sha256: "24e8fec2a3be3df268e8d0afe53918d6da082a88087613b8387a4729286fc678", what: "GLVAR Buyer Brokerage Agreement Rev. 01/19, blank, 3 pp." },
  NV3: { sha256: "ce3d5ce62570b5d7529568ba2a871c46d12fedb75d5323c28923facd04445192", what: "GLVAR Exclusive Right (ER) Listing Agreement Rev. 07.24, blank, 10 pp." },
  NV4: { sha256: "a8542a1d4508b9e4479126b619b5b6094ea11d5e3a6037ef59919bd6aded1f4d", what: "SNR Residential Offer and Acceptance Agreement 03/26, blank, 12 pp." },
  NV5: { sha256: "4914428707ebdd43cd75c68cdada338186c5a919056f9c88770a85179fb3f8ac", what: "NRED 524 Consent to Act, Revised 05/01/05, blank, 1 p." },
  NV6: { sha256: "fd789eec7975c75ff7ebbfff4ad87a73dce480e8f6e4e31c499399041c27e196", what: "NRED 525 Duties Owed, Revised 10/03/2023, blank, 1 p." },
  NV7: { sha256: "cc6ea95bb32111353d9e40f931a4b68fb4bd77c2949a6acbbaee4b19fed42957", what: "NRED 525A Supplemental List of Licensees, Revised 11/7/16, blank, 1 p." },
  NV8: { sha256: "c4792ac842de0946c7d42aa035e620c221632cbe07ef7d6c920a45ace0157d9a", what: "NRED 547 Seller Real Property Disclosure, Revised 6/1/2023, blank, 5 pp." },
  NV9: { sha256: "4a53748c0fa8f1cae99b02d56856fb2a313c11d0e7c87c7d9c0818c091a5e9b6", what: "NRED 551 Open Range Disclosure, Effective July 1, 2010, blank, 1 p." },
  NV10: { sha256: "724c06c98c5662ee7e6458224877fae417ed6b73d41b01fb5b6eef1484c433e8", what: "NRED 676 Waiver and Authorization to Negotiate Directly, Revised 04/23/2025, blank, 2 pp." },
} as const;

export type NvSourceId = keyof typeof NV_SOURCES;
export type NvFixture = TextFixture<NvSourceId>;

/** GLVAR RPA 10/25 — every page's footer line and page line (11 pages). */
export const NV1_GLVAR_RPA: NvFixture = {
  id: "NV1-RPA",
  sources: ["NV1"],
  lines: [
    // NV1 lines 6, 7
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 1 of 11",
    ...BODY,
    // NV1 lines 55, 56
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 2 of 11",
    ...BODY,
    // NV1 lines 120, 121
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 3 of 11",
    ...BODY,
    // NV1 lines 188, 189
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 4 of 11",
    ...BODY,
    // NV1 lines 265, 266
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 5 of 11",
    ...BODY,
    // NV1 lines 334, 335
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 6 of 11",
    ...BODY,
    // NV1 lines 399, 400
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 7 of 11",
    ...BODY,
    // NV1 lines 468, 469
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 8 of 11",
    ...BODY,
    // NV1 lines 564, 565
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 9 of 11",
    ...BODY,
    // NV1 lines 618, 619
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 10 of 11",
    ...BODY,
    // NV1 lines 664, 665
    "Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®",
    "Page 11 of 11",
    ...BODY,
  ],
};

/** GLVAR BBA 01/19 — every page's footer line and © line (3 pages). */
export const NV2_GLVAR_BBA: NvFixture = {
  id: "NV2-BBA",
  sources: ["NV2"],
  lines: [
    // NV2 lines 1, 2
    "Buyer Brokerage Agreement Rev. 01/19 Page 1 of 3",
    "© 2019 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV2 lines 12, 13
    "Buyer Brokerage Agreement Rev. 01/19 Page 2 of 3",
    "© 2019 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV2 lines 25, 26
    "Buyer Brokerage Agreement Rev. 01/19 Page 3 of 3",
    "© 2019 Greater Las Vegas Association of REALTORS®",
    ...BODY,
  ],
};

/** GLVAR ER listing 07.24 — every page's footer line (10 pages; page 10 prints `© 2022` with a space). */
export const NV3_GLVAR_ER: NvFixture = {
  id: "NV3-ER",
  sources: ["NV3"],
  lines: [
    // NV3 line 3
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 1 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 56
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 2 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 108
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 3 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 164
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 4 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 216
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 5 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 269
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 6 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 325
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 7 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 381
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 8 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 412
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 9 of 10 ©2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
    // NV3 line 460
    "Exclusive Right (ER) Listing Agreement Rev. 07.24 Page 10 of 10 © 2022 Greater Las Vegas Association of REALTORS®",
    ...BODY,
  ],
};

/** SNR OAA 03/26 — the page-1 title, every page's SNR page line, and the SNR line under page 1. */
export const NV4_SNR_OAA: NvFixture = {
  id: "NV4-OAA",
  sources: ["NV4"],
  lines: [
    // NV4 lines 75, 76, 82
    "RESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT",
    "Page 1 of 12 SNR© 03/26",
    "This copyright protected form was created by REALTORS® of SNR.",
    ...BODY,
    // NV4 line 167
    "Page 2 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 264
    "Page 3 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 368
    "Page 4 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 457
    "Page 5 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 568
    "Page 6 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 664
    "Page 7 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 759
    "Page 8 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 853
    "Page 9 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 944
    "Page 10 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 1003
    "Page 11 of 12 SNR© 03/26",
    ...BODY,
    // NV4 line 1102
    "This copyright protected form was created by REALTORS® of SNR.Page 12 of 12 SNR© 03/26",
    ...BODY,
  ],
};

/** NRED 524 — the top block and the title (1 page). */
export const NV5_NRED_524: NvFixture = {
  id: "NV5-524",
  sources: ["NV5"],
  lines: [
    // NV5 lines 1, 2, 3, 4, 5
    "Approved Nevada Real Estate Division",
    "Replaces all previous editions",
    "Page 1 of 1 524",
    "Revised 05/01/05",
    "CONSENT TO ACT",
    ...BODY,
  ],
};

/** NRED 525 — the title and the bottom block at their source offsets (publisher +3557, revision +3629 from the title). */
export const NV6_NRED_525: NvFixture = {
  id: "NV6-525",
  sources: ["NV6"],
  lines: [
    "DUTIES OWED BY A NEVADA REAL ESTATE LICENSEE", // NV6 line 4
    fill(3511), // NV6 lines 5-50: same span, not transcribed
    "Approved Nevada Real Estate Division", // NV6 line 51
    "Replaces all previous versions", // NV6 line 52
    "525", // NV6 line 53
    "Revised 10/03/2023", // NV6 line 54
  ],
};

/** NRED 525A — the top block and its 2-line title, whose second line is the 525 title. */
export const NV7_NRED_525A: NvFixture = {
  id: "NV7-525A",
  sources: ["NV7"],
  lines: [
    // NV7 lines 1, 2, 3, 4
    "Approved Nevada Real Estate Division 525A",
    "Replaces all previous versions Revised 11/7/16",
    "SUPPLEMENTAL LIST OF LICENSEES PARTY TO THE",
    "DUTIES OWED BY A NEVADA REAL ESTATE LICENSEE",
    ...BODY,
  ],
};

/** NRED 547 — every page's block (5 pages); the title prints on page 1 only. Page 4 and 5 print the page line beside the code. */
export const NV8_NRED_547: NvFixture = {
  id: "NV8-547",
  sources: ["NV8"],
  lines: [
    // NV8 lines 1, 2, 3, 4, 5
    "Nevada Real Estate Division Page 1 of 5",
    "Replaces all previous versions",
    "Seller Real Property Disclosure Form 547",
    "Revised 6/1/2023",
    "SELLER’S REAL PROPERTY DISCLOSURE FORM",
    ...BODY,
    // NV8 lines 71, 72, 73, 74
    "Nevada Real Estate Division Page 2 of 5",
    "Replaces all previous versions",
    "Seller Real Property Disclosure Form 547",
    "Revised 6/1/2023",
    ...BODY,
    // NV8 lines 128, 129, 130, 131
    "Nevada Real Estate Division Page 3 of 5",
    "Replaces all previous versions",
    "Seller Real Property Disclosure Form 547",
    "Revised 6/1/2023",
    ...BODY,
    // NV8 lines 135, 136, 137, 138
    "Nevada Real Estate Division",
    "Replaces all previous versions",
    "Page 4 of 5 Seller Real Property Disclosure Form 547",
    "Revised 6/1/2023",
    ...BODY,
    // NV8 lines 212, 213, 214, 215
    "Nevada Real Estate Division",
    "Replaces all previous versions",
    "Page 5 of 5 Seller Real Property Disclosure Form 547",
    "Revised 6/1/2023",
    ...BODY,
  ],
};

/** NRED 551 — the title and the footer line at their source offsets (+2941). */
export const NV9_NRED_551: NvFixture = {
  id: "NV9-551",
  sources: ["NV9"],
  lines: [
    "OPEN RANGE DISCLOSURE", // NV9 line 1
    fill(2918), // NV9 lines 2-46: same span, not transcribed
    "Nevada Real Estate Division - Form 551 Effective July 1, 2010", // NV9 line 47
  ],
};

/** NRED 676 — letterhead (−142 from the title), title, and both pages' footer lines at their source offsets; the contact line is inside a fill span. */
export const NV10_NRED_676: NvFixture = {
  id: "NV10-676",
  sources: ["NV10"],
  lines: [
    "STATE OF NEVADA", // NV10 line 1
    "DEPARTMENT OF BUSINESS AND INDUSTRY", // NV10 line 2
    "REAL ESTATE DIVISION", // NV10 line 3
    fill(120), // NV10 lines 4-5: same span, not transcribed
    "WAIVER AND AUTHORIZATION TO NEGOTIATE DIRECTLY WITH THE CLIENT FORM", // NV10 line 6
    fill(2184), // NV10 lines 7-36: same span, not transcribed
    "Revised: 04/23/2025 Page 1 of 2 676", // NV10 line 37
    fill(2558), // NV10 lines 38-69: same span, not transcribed
    "Revised: 03/12/2025 Page 2 of 2 676", // NV10 line 70
  ],
};

export const NV_FIXTURES: readonly NvFixture[] = [NV1_GLVAR_RPA, NV2_GLVAR_BBA, NV3_GLVAR_ER, NV4_SNR_OAA, NV5_NRED_524, NV6_NRED_525, NV7_NRED_525A, NV8_NRED_547, NV9_NRED_551, NV10_NRED_676];
