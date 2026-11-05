/**
 * BACKLOG-4106 — Oregon form-header fixtures. Same rules as nwmlsHeaders.ts: every non-synthetic
 * line is VERBATIM pdfjs text of a BLANK form, cited by source id + .txt line number. Only header
 * and footer lines are transcribed; bodies are the literal SYNTH line. The licensee sentence and
 * the licence-terms line under each OREF footer are not transcribed. A mechanical check (every
 * non-SYNTH line is a whole line of its source text) runs before each commit; its output is on
 * BACKLOG-4106. The OREF footer carries a private-use glyph (U+F0E7) between "SYMBOL " and
 * " REQUIRE", written as an escape.
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";

export const OR_SOURCES = {
  OR2: { sha256: "50e0c646b9f9cfe05e8dd9de45fd97dd79535712be57052ef59724a83d29f79b", what: "OREF 2026 annual-update sample packet, blank, 120 pp." },
  OR3: { sha256: "653d3a4b3984f4316d95b914f6faba52f91fcd09e0396a6d2489e9eccbabe255", what: "Oregon REALTORS Form 1.1 Version 2026-2, blank" },
  OR4: { sha256: "6bbaf1e87c776826d4807f1e3a30e2c16b45dfcf14060d04dc7697998dd598a5", what: "Oregon REALTORS Form 2.1 Version 2026-2, blank" },
  OR5: { sha256: "ebbb7ba2500cef225521f1dc2406eb2585ee30b2437197d70d4ca93027869ab6", what: "Oregon REALTORS Form 9.3 Version 2026-2, blank" },
  OR6: { sha256: "4f11247bc63a4037e95c3c15489b3dc9e3f4241210ec1e7db3a4f4d5be2fca56", what: "Oregon REALTORS Form 9.4 Version 2026-2, blank" },
  OR7: { sha256: "ee2769b573c8e34b37898d20c46bffe365aa91dc5b7af836fdfc613ce00b745f", what: "Oregon REALTORS Form 10.4 Version 2026-2, blank" },
  OR8: { sha256: "4782003b2a823ba49f4a9ed3b0730490698a9274c3fd631171498f3f298a0311", what: "Oregon REALTORS Form 3.1 Version 2026-2 (+3.1A), blank" },
} as const;

export type OrSourceId = keyof typeof OR_SOURCES;
export type OrFixture = TextFixture<OrSourceId>;

/** OREF 001 — every page's title line, footer line and © line (15 pages). */
export const OR2_OREF_001: OrFixture = {
  id: "OR2-001",
  sources: ["OR2"],
  lines: [
    // OR2 lines 1005, 1006, 1007
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 1 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1053, 1054, 1055
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 2 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1102, 1103, 1104
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 3 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1151, 1152, 1153
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 4 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1199, 1200, 1201
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 5 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1246, 1247, 1248
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 6 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1299, 1300, 1301
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 7 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1351, 1352, 1353
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 8 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1402, 1403, 1404
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 9 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1452, 1453, 1454
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 10 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1502, 1503, 1504
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 11 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1550, 1551, 1552
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 12 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1600, 1601, 1602
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 13 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1647, 1648, 1649
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 14 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1689, 1690, 1691
    "RESIDENTIAL REAL ESTATE SALE AGREEMENT",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 15 of 15",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 003 — every page's title line, footer line and © line (2 pages). */
export const OR2_OREF_003: OrFixture = {
  id: "OR2-003",
  sources: ["OR2"],
  lines: [
    // OR2 lines 1734, 1735, 1736
    "SELLER’S COUNTEROFFER NO. _____",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 003 | Released 01/2026 | Page 1 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1786, 1787, 1788
    "SELLER’S COUNTEROFFER NO. _____",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 003 | Released 01/2026 | Page 2 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 004 — every page's title line, footer line and © line (2 pages). */
export const OR2_OREF_004: OrFixture = {
  id: "OR2-004",
  sources: ["OR2"],
  lines: [
    // OR2 lines 1815, 1816, 1817
    "BUYER’S COUNTEROFFER NO. _____",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 004 | Released 01/2026 | Page 1 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1867, 1868, 1869
    "BUYER’S COUNTEROFFER NO. _____",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 004 | Released 01/2026 | Page 2 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 015 — every page's title line, footer line and © line (6 pages). */
export const OR2_OREF_015: OrFixture = {
  id: "OR2-015",
  sources: ["OR2"],
  lines: [
    // OR2 lines 2810, 2811, 2812
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 1 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
    // OR2 lines 2860, 2861, 2862
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 2 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
    // OR2 lines 2908, 2909, 2910
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 3 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
    // OR2 lines 2953, 2954, 2955
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 4 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
    // OR2 lines 3003, 3004, 3005
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 5 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
    // OR2 lines 3055, 3056, 3057
    "LISTING AGREEMENT - EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 015 | Released 01/2026 | Page 6 of 6",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2025",
    ...BODY,
  ],
};

/** OREF 050 — every page's title line, footer line and © line (4 pages). */
export const OR2_OREF_050: OrFixture = {
  id: "OR2-050",
  sources: ["OR2"],
  lines: [
    // OR2 lines 3690, 3691, 3692
    "BUYER REPRESENTATION AGREEMENT – EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 050 | Released 01/2026 | Page 1 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 3740, 3741, 3742
    "BUYER REPRESENTATION AGREEMENT – EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 050 | Released 01/2026 | Page 2 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 3786, 3787, 3788
    "BUYER REPRESENTATION AGREEMENT – EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 050 | Released 01/2026 | Page 3 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 3835, 3836, 3837
    "BUYER REPRESENTATION AGREEMENT – EXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 050 | Released 01/2026 | Page 4 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 052 — every page's title line, footer line and © line (4 pages). */
export const OR2_OREF_052: OrFixture = {
  id: "OR2-052",
  sources: ["OR2"],
  lines: [
    // OR2 lines 3880, 3881, 3882
    "BUYER REPRESENTATION AGREEMENT – NONEXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 052 | Released 01/2026 | Page 1 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2024",
    ...BODY,
    // OR2 lines 3929, 3930, 3931
    "BUYER REPRESENTATION AGREEMENT – NONEXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 052 | Released 01/2026 | Page 2 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2024",
    ...BODY,
    // OR2 lines 3974, 3975, 3976
    "BUYER REPRESENTATION AGREEMENT – NONEXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 052 | Released 01/2026 | Page 3 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2024",
    ...BODY,
    // OR2 lines 4024, 4025, 4026
    "BUYER REPRESENTATION AGREEMENT – NONEXCLUSIVE",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 052 | Released 01/2026 | Page 4 of 4",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2024",
    ...BODY,
  ],
};

/** OREF 057 — every page's title line, footer line and © line (2 pages). */
export const OR2_OREF_057: OrFixture = {
  id: "OR2-057",
  sources: ["OR2"],
  lines: [
    // OR2 lines 4288, 4289, 4290
    "TERMINATION AGREEMENT AND DEPOSIT DISBURSEMENT INSTRUCTIONS",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 057 | Released 01/2026 | Page 1 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 4332, 4333, 4334
    "TERMINATION AGREEMENT AND DEPOSIT DISBURSEMENT INSTRUCTIONS",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 057 | Released 01/2026 | Page 2 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Forms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 009 — every page's title line, footer line and © line (2 pages). */
export const OR2_OREF_009: OrFixture = {
  id: "OR2-009",
  sources: ["OR2"],
  lines: [
    // OR2 lines 1897, 1898, 1899
    "BACK-UP OFFER ADDENDUM",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 009 | Released 01/2026 | Page 1 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Foms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
    // OR2 lines 1946, 1947, 1948
    "BACK-UP OFFER ADDENDUM",
    "LINES WITH THIS SYMBOL \uf0e7 REQUIRE A SIGNATURE AND DATE OREF 009 | Released 01/2026 | Page 2 of 2",
    "No portion of this form may be reproduced without the express permission of Oregon Real Estate Foms, LLC | Copyright Oregon Real Estate Forms, LLC 2022",
    ...BODY,
  ],
};

/** OREF 000B advisory — title and the page line printed BELOW its footer (lines 2 and 4; line 3 is rebuilt in the test as SYNTHETIC). */
export const OR2_OREF_000B_PAGE_LINE: OrFixture = {
  id: "OR2-000B-page",
  sources: ["OR2"],
  lines: [
    // OR2 line 2
    "Advisory for Buyers and Sellers of Real Estate",
    // OR2 line 4
    "No portion may be reproduced without the express permission of Oregon Real Estate Forms, LLC Page 1 of 12",
  ],
};

/** ORR 1.1 — every page's code line and © line (10 pages). */
export const OR3_ORR_1_1: OrFixture = {
  id: "OR3-1.1",
  sources: ["OR3"],
  lines: [
    // OR3 lines 52, 53
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 1 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 109, 110
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 2 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 165, 166
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 3 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 223, 224
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 4 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 281, 282
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 5 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 339, 340
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 6 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 396, 397
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 7 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 454, 455
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 8 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 513, 514
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 9 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR3 lines 570, 571
    "Form 1.1 · Oregon Residential Real Estate Purchase and Sale Agreement · Version 2026-2 Page 10 of 10",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

/** ORR 2.1 — code line and © line (1 page). */
export const OR4_ORR_2_1: OrFixture = {
  id: "OR4-2.1",
  sources: ["OR4"],
  lines: [
    // OR4 lines 2, 3
    "Form 2.1 · Counteroffer to Real Estate Purchase and Sale Agreement · Version 2026-2 Page 1 of 1",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

/** ORR 9.3 — every page's code line and © line (4 pages). */
export const OR5_ORR_9_3: OrFixture = {
  id: "OR5-9.3",
  sources: ["OR5"],
  lines: [
    // OR5 lines 3, 4
    "Form 9.3 · Listing Agreement · Version 2026-2 Page 1 of 4",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR5 lines 54, 55
    "Form 9.3 · Listing Agreement · Version 2026-2 Page 2 of 4",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR5 lines 106, 107
    "Form 9.3 · Listing Agreement · Version 2026-2 Page 3 of 4",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR5 lines 159, 160
    "Form 9.3 · Listing Agreement · Version 2026-2 Page 4 of 4",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

/** ORR 9.4 — every page's code line and © line (3 pages). */
export const OR6_ORR_9_4: OrFixture = {
  id: "OR6-9.4",
  sources: ["OR6"],
  lines: [
    // OR6 lines 3, 4
    "Form 9.4 · Buyer Representation Agreement · Version 2026-2 Page 1 of 3",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR6 lines 57, 58
    "Form 9.4 · Buyer Representation Agreement · Version 2026-2 Page 2 of 3",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR6 lines 110, 111
    "Form 9.4 · Buyer Representation Agreement · Version 2026-2 Page 3 of 3",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

/** ORR 3.1 — six pages' code line and © line, then the 3.1A attachment's header (no page token: not a code-page line). */
export const OR8_ORR_3_1: OrFixture = {
  id: "OR8-3.1",
  sources: ["OR8"],
  lines: [
    // OR8 lines 3, 4
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 1 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 45, 46
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 2 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 93, 94
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 3 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 145, 146
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 4 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 197, 198
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 5 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 249, 250
    "Form 3.1· Seller Property Disclosure Statement · Version 2026-2 Page 6 of 6",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR8 lines 297, 298
    "Form 3.1A Seller Property Disclosure Statement Attachment Version 2026-2",
    "Copyright © 2023 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

/** ORR 10.4 — every page's code line and © line (5 pages). */
export const OR7_ORR_10_4: OrFixture = {
  id: "OR7-10.4",
  sources: ["OR7"],
  lines: [
    // OR7 lines 2, 3
    "Form 10.4 · Initial Agency Disclosure Pamphlet · Version 2026-2 Page 1 of 5",
    "Copyright © 2025 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR7 lines 32, 33
    "Form 10.4 · Initial Agency Disclosure Pamphlet · Version 2026-2 Page 2 of 5",
    "Copyright © 2025 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR7 lines 65, 66
    "Form 10.4 · Initial Agency Disclosure Pamphlet · Version 2026-2 Page 3 of 5",
    "Copyright © 2025 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR7 lines 101, 102
    "Form 10.4 · Initial Agency Disclosure Pamphlet · Version 2026-2 Page 4 of 5",
    "Copyright © 2025 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
    // OR7 lines 136, 137
    "Form 10.4 · Initial Agency Disclosure Pamphlet · Version 2026-2 Page 5 of 5",
    "Copyright © 2025 Oregon REALTORS®. This form is for use exclusively by Oregon REALTORS®",
    ...BODY,
  ],
};

export const OR_FIXTURES: readonly OrFixture[] = [
  OR2_OREF_001,
  OR2_OREF_003,
  OR2_OREF_004,
  OR2_OREF_015,
  OR2_OREF_050,
  OR2_OREF_052,
  OR2_OREF_057,
  OR2_OREF_009,
  OR3_ORR_1_1,
  OR4_ORR_2_1,
  OR5_ORR_9_3,
  OR6_ORR_9_4,
  OR8_ORR_3_1,
  OR7_ORR_10_4,
  OR2_OREF_000B_PAGE_LINE,
];
