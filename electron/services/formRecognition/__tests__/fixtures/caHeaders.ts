/**
 * BACKLOG-4106 — California form-header fixtures. Same rules as nwmlsHeaders.ts. C.A.R. pairing
 * depends on how far each page's code line is from its paired token, so the C.A.R. fixtures keep
 * every character OFFSET of the source: the cited lines are verbatim, and each run of lines between
 * them is replaced by one `fill(n)` line of dots spanning exactly the same characters (SYNTHETIC
 * layout; nothing in it is transcribed). Stamp lines (agent names, document ids) fall inside those
 * spans and are never transcribed.
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";

export const CA_SOURCES = {
  CA1: { sha256: "cc05871cc5109a1a1d485a19bf8041f1111310b8bbc8881210294190cbbdc69d", what: "C.A.R. RPA Revised 12/22, blank SAMPLE copy, 16 pp." },
  CA2: { sha256: "e8fb67d4bc37134e89ee1f43c08d8f665103ba1b5b9362489497cc3602c8c3ca", what: "C.A.R. buyer packet 12/24 (AD, BRBC, BIA, BCA, PRBS, CCPA), blank" },
  CA3: { sha256: "ca07d18640c24c397e8140c4b4f52fef7fe3513eb7d8bd287c8c2fa44eeff19b", what: "C.A.R. buyer packet 12/25 (AD, BRBC, PRBS, BCA, BIA, CCPA), blank" },
  CA4: { sha256: "112c3763bf8c8b4bfcbd784ce855598315f41bd59348df55479e0b22e406d87e", what: "DRE RE 882 Rev. 10/10, blank, 3 pp." },
} as const;

export type CaSourceId = keyof typeof CA_SOURCES;
export type CaFixture = TextFixture<CaSourceId>;

/** SYNTHETIC layout filler: n dots, standing in for n characters of untranscribed source text. */
export function fill(n: number): string {
  return ".".repeat(n);
}

/** RPA 12/22 — all 16 pages' code line and paired token at their source offsets. Pages 4-12 print the token at the page bottom: 7 of 16 pages pair. */
export const CA1_RPA: CaFixture = {
  id: "CA1-RPA",
  sources: ["CA1"],
  lines: [
    "SAMPLERPA REVISED 12/22 (PAGE 1 OF 16)", // CA1 line 1
    fill(104), // CA1 lines 2-4: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 1 OF 16)", // CA1 line 5
    fill(9090), // CA1 lines 6-187: same span, not transcribed
    "RPA REVISED 12/22 (PAGE 2 OF 16)", // CA1 line 188
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 2 OF 16)", // CA1 line 189
    fill(188), // CA1 lines 190-191: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 3 OF 16)", // CA1 line 192
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 3 OF 16)", // CA1 line 193
    fill(3950), // CA1 lines 194-288: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 4 OF 16)", // CA1 line 289
    fill(6909), // CA1 lines 290-361: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 4 OF 16)", // CA1 line 362
    fill(191), // CA1 lines 363-365: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 5 OF 16)", // CA1 line 366
    fill(8022), // CA1 lines 367-442: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 5 OF 16)", // CA1 line 443
    fill(190), // CA1 lines 444-446: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 6 OF 16)", // CA1 line 447
    fill(7477), // CA1 lines 448-521: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 6 OF 16)", // CA1 line 522
    fill(188), // CA1 lines 523-524: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 7 OF 16)", // CA1 line 525
    fill(7798), // CA1 lines 526-597: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 7 OF 16)", // CA1 line 598
    fill(188), // CA1 lines 599-600: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 8 OF 16)", // CA1 line 601
    fill(7903), // CA1 lines 602-676: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 8 OF 16)", // CA1 line 677
    fill(188), // CA1 lines 678-679: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 9 OF 16)", // CA1 line 680
    fill(8051), // CA1 lines 681-753: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 9 OF 16)", // CA1 line 754
    fill(188), // CA1 lines 755-756: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 10 OF 16)", // CA1 line 757
    fill(8106), // CA1 lines 758-832: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 10 OF 16)", // CA1 line 833
    fill(188), // CA1 lines 834-835: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 11 OF 16)", // CA1 line 836
    fill(9040), // CA1 lines 837-912: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 11 OF 16)", // CA1 line 913
    fill(188), // CA1 lines 914-915: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 12 OF 16)", // CA1 line 916
    fill(8538), // CA1 lines 917-990: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 12 OF 16)", // CA1 line 991
    fill(8448), // CA1 lines 992-1068: same span, not transcribed
    "RPA REVISED 12/22 (PAGE 13 OF 16)", // CA1 line 1069
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 13 OF 16)", // CA1 line 1070
    fill(188), // CA1 lines 1071-1072: same span, not transcribed
    "SAMPLERPA REVISED 12/22 (PAGE 14 OF 16)", // CA1 line 1073
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 14 OF 16)", // CA1 line 1074
    fill(12297), // CA1 lines 1075-1201: same span, not transcribed
    "RPA REVISED 12/22 (PAGE 15 OF 16)", // CA1 line 1202
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 15 OF 16)", // CA1 line 1203
    fill(5502), // CA1 lines 1204-1256: same span, not transcribed
    "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS (RPA PAGE 16 OF 16)", // CA1 line 1257
    "RPA REVISED 12/22 (PAGE 16 OF 16)", // CA1 line 1258
  ],
};

/** AD 12/24 (packet 12/24) — both pages. */
export const CA2_AD: CaFixture = {
  id: "CA2-AD",
  sources: ["CA2"],
  lines: [
    "AD REVISED 12/24 (PAGE 1 OF 2)", // CA2 line 66
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 1 OF 2)", // CA2 line 67
    fill(11399), // CA2 lines 68-154: same span, not transcribed
    "AD REVISED 12/24 (PAGE 2 OF 2)", // CA2 line 155
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 2 OF 2)", // CA2 line 156
  ],
};

/** BRBC 12/24 (packet 12/24) — all 5 pages; initials glued after the page token. */
export const CA2_BRBC: CaFixture = {
  id: "CA2-BRBC",
  sources: ["CA2"],
  lines: [
    "© 2024, California Association of REALTORS®, Inc.", // CA2 line 221
    "BRBC REVISED 12/24 (PAGE 1 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 222
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 1 OF 5)", // CA2 line 223
    fill(5542), // CA2 lines 224-287: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 2 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 288
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 2 OF 5)", // CA2 line 289
    fill(5911), // CA2 lines 290-349: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 3 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 350
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 3 OF 5)", // CA2 line 351
    fill(6472), // CA2 lines 352-411: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 4 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 412
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 4 OF 5)", // CA2 line 413
    fill(4300), // CA2 lines 414-468: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 5 OF 5)", // CA2 line 469
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 5 OF 5)", // CA2 line 470
  ],
};

/** Packet 12/24 — every code line and paired token, at source offsets (AD, BRBC, then four unregistered codes). */
export const CA2_PACKET: CaFixture = {
  id: "CA2-PACKET",
  sources: ["CA2"],
  lines: [
    "AD REVISED 12/24 (PAGE 1 OF 2)", // CA2 line 66
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 1 OF 2)", // CA2 line 67
    fill(11399), // CA2 lines 68-154: same span, not transcribed
    "AD REVISED 12/24 (PAGE 2 OF 2)", // CA2 line 155
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 2 OF 2)", // CA2 line 156
    fill(3567), // CA2 lines 157-220: same span, not transcribed
    "© 2024, California Association of REALTORS®, Inc.", // CA2 line 221
    "BRBC REVISED 12/24 (PAGE 1 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 222
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 1 OF 5)", // CA2 line 223
    fill(5542), // CA2 lines 224-287: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 2 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 288
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 2 OF 5)", // CA2 line 289
    fill(5911), // CA2 lines 290-349: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 3 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 350
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 3 OF 5)", // CA2 line 351
    fill(6472), // CA2 lines 352-411: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 4 OF 5) Buyer's Initials / Broker/Agent Initials /", // CA2 line 412
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 4 OF 5)", // CA2 line 413
    fill(4300), // CA2 lines 414-468: same span, not transcribed
    "BRBC REVISED 12/24 (PAGE 5 OF 5)", // CA2 line 469
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 5 OF 5)", // CA2 line 470
    fill(5177), // CA2 lines 471-529: same span, not transcribed
    "BIA REVISED 12/21 (PAGE 1 OF 2)", // CA2 line 530
    "BUYER'S INVESTIGATION ADVISORY (BIA PAGE 1 OF 2)", // CA2 line 531
    fill(2642), // CA2 lines 532-560: same span, not transcribed
    "BIA REVISED 12/21 (PAGE 2 OF 2)", // CA2 line 561
    "BUYER'S INVESTIGATION ADVISORY (BIA PAGE 2 OF 2)", // CA2 line 562
    fill(4348), // CA2 lines 563-611: same span, not transcribed
    "BCA 7/24 (PAGE 1 OF 2)", // CA2 line 612
    "BROKER COMPENSATION ADVISORY (BCA PAGE 1 OF 2)", // CA2 line 613
    fill(4848), // CA2 lines 614-668: same span, not transcribed
    "BCA 7/24 (PAGE 2 OF 2)", // CA2 line 669
    "BROKER COMPENSATION ADVISORY (BCA PAGE 2 OF 2)", // CA2 line 670
    fill(5075), // CA2 lines 671-724: same span, not transcribed
    "PRBS REVISED 12/21 (PAGE 1 OF 1)", // CA2 line 725
    "POSSIBLE REPRESENTATION OF MORE THAN ONE BUYER OR SELLER (PRBS PAGE 1 OF 1)", // CA2 line 726
    fill(3883), // CA2 lines 727-766: same span, not transcribed
    "CCPA REVISED 12/22 (PAGE 1 OF 1)", // CA2 line 767
    "CALIFORNIA CONSUMER PRIVACY ACT ADVISORY (CCPA PAGE 1 OF 1)", // CA2 line 768
  ],
};

/** AD 12/24 (packet 12/25) — page 1 prints the token ABOVE the code line; page 2's token is ~6,200 chars away, so 1 of 2 pages pairs. */
export const CA3_AD: CaFixture = {
  id: "CA3-AD",
  sources: ["CA3"],
  lines: [
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 1 OF 2)", // CA3 line 5
    "AD REVISED 12/24 (PAGE 1 OF 2)", // CA3 line 6
    fill(6166), // CA3 lines 7-71: same span, not transcribed
    "AD REVISED 12/24 (PAGE 2 OF 2)", // CA3 line 72
    fill(11293), // CA3 lines 73-157: same span, not transcribed
    "DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP (AD PAGE 2 OF 2)", // CA3 line 158
  ],
};

/** BRBC 12/25 (packet 12/25) — all 5 pages. */
export const CA3_BRBC: CaFixture = {
  id: "CA3-BRBC",
  sources: ["CA3"],
  lines: [
    "BRBC REVISED 12/25 (PAGE 1 OF 5)", // CA3 line 160
    fill(146), // CA3 lines 161-164: same span, not transcribed
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 1 OF 5)", // CA3 line 165
    fill(10385), // CA3 lines 166-295: same span, not transcribed
    "BRBC REVISED 12/25 (PAGE 2 OF 5)", // CA3 line 296
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 2 OF 5)", // CA3 line 297
    fill(6135), // CA3 lines 298-359: same span, not transcribed
    "BRBC REVISED 12/25 (PAGE 3 OF 5)", // CA3 line 360
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 3 OF 5)", // CA3 line 361
    fill(7055), // CA3 lines 362-424: same span, not transcribed
    "BRBC REVISED 12/25 (PAGE 4 OF 5)", // CA3 line 425
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 4 OF 5)", // CA3 line 426
    fill(282), // CA3 lines 427-428: same span, not transcribed
    "BRBC REVISED 12/25 (PAGE 5 OF 5)", // CA3 line 429
    "BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT (BRBC PAGE 5 OF 5)", // CA3 line 430
  ],
};

/** DRE RE 882 Rev. 10/10 — letterhead, title and code line (p. 1), then the page lines of pp. 2-3. */
export const CA4_RE882: CaFixture = {
  id: "CA4-RE882",
  sources: ["CA4"],
  lines: [
    // CA4 lines 2, 3, 4, 5
    "S TATE OF CALIFORNIA",
    "D EPARTMENT OF REAL ESTATE",
    "MORTGAGE LOAN D ISCLOSURE S TATEMENT (TRADITIONAL )",
    "RE 882 (Rev. 10/10)",
    ...BODY,
    // CA4 line 62
    "RE 882 — Page 2 of 3",
    ...BODY,
    // CA4 line 136
    "RE 882 — Page 3 of 3",
    ...BODY,
  ],
};

export const CA_FIXTURES: readonly CaFixture[] = [
  CA1_RPA,
  CA2_AD,
  CA2_BRBC,
  CA2_PACKET,
  CA3_AD,
  CA3_BRBC,
  CA4_RE882,
];
