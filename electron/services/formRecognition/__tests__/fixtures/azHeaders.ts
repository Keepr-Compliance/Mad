/**
 * BACKLOG-4106 — Arizona form-header fixtures. Same rules as nwmlsHeaders.ts: every non-synthetic line
 * is VERBATIM pdfjs text of a BLANK form, cited by source id + .txt line number, copied by script.
 * Only header, title and footer lines are transcribed; bodies are the literal SYNTH line. The
 * agent/brokerage contact line printed on each BBEEA page is never transcribed. A mechanical check
 * (every non-SYNTH line is a whole line of its source text) runs before each commit; its output is
 * on BACKLOG-4106. Held (founder ruling): the regulator's advisories (title-only evidence).
 */
import { BODY, type TextFixture } from "./nwmlsHeaders";

export const AZ_SOURCES = {
  AZ5: { sha256: "c371e5f1ecc375eca8c9deb68d1e92fe303d726fcd665a7ffb7a14584f1f4fbf", what: "Arizona REALTORS Residential Resale Real Estate Purchase Contract, Updated August 2024, blank sample, 10 pp. + cover" },
  AZ6: { sha256: "89c23780b7c0303e1eb0b08f69d4f797126f992cedc8fc192fe1a70f55cd2b7a", what: "Arizona REALTORS Buyer-Broker Exclusive Employment Agreement, August 2024, blank, 3 pp." },
  AZ7: { sha256: "95e4e06db83dbc40a125a214167b4c304c9f4888e6b692c85d17e83306c5bc5a", what: "Phoenix REALTORS Residential Resale Purchase Contract, Dec. 2024, blank example, 12 pp." },
} as const;

export type AzSourceId = keyof typeof AZ_SOURCES;
export type AzFixture = TextFixture<AzSourceId>;

/** AAR RPC Aug 2024 — the cover's footer, then every page's footer block (10 pages) and the `… Purchase Contract >>` continuation lines. */
export const AZ5_AAR_RPC: AzFixture = {
  id: "AZ5-RPC",
  sources: ["AZ5"],
  lines: [
    // AZ5 lines 1, 2
    "Buyer Attachment • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    ...BODY,
    // AZ5 lines 46, 47, 48
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 1 of 10",
    ...BODY,
    // AZ5 lines 136, 137, 138, 139, 140
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 2 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 2 of 10",
    ...BODY,
    // AZ5 lines 274, 275, 276, 277, 278
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 3 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 3 of 10",
    ...BODY,
    // AZ5 lines 379, 380, 381, 382, 383
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 4 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 4 of 10",
    ...BODY,
    // AZ5 lines 496, 497, 498, 499, 500
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 5 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 5 of 10",
    ...BODY,
    // AZ5 lines 620, 621, 622, 623, 624
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 6 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 6 of 10",
    ...BODY,
    // AZ5 lines 739, 740, 741, 742, 743
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 7 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 7 of 10",
    ...BODY,
    // AZ5 lines 864, 865, 866, 867, 868
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 8 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 8 of 10",
    ...BODY,
    // AZ5 lines 918, 919, 920, 921, 922
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 9 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    "Page 9 of 10",
    ...BODY,
    // AZ5 lines 1047, 1048, 1049
    "Residential Resale Real Estate Purchase Contract • Updated: August 2024",
    "Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "Page 10 of 10",
    ...BODY,
    // AZ5 lines 1083, 1084
    "Page 10 of 10",
    "Residential Resale Real Estate Purchase Contract >>",
    ...BODY,
  ],
};

/** AAR BBEEA Aug 2024 — every page's PAGE line and one-line footer (3 pages). */
export const AZ6_AAR_BBEEA: AzFixture = {
  id: "AZ6-BBEEA",
  sources: ["AZ6"],
  lines: [
    // AZ6 lines 1, 2, 3
    "PAGE 1 of 3",
    "Buyer-Broker Exclusive Employment Agreement • August 2024 • Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "PAGE 1 of 3",
    ...BODY,
    // AZ6 lines 86, 87, 88
    "PAGE 2 of 3",
    "Buyer-Broker Exclusive Employment Agreement • August 2024 • Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "PAGE 2 of 3",
    ...BODY,
    // AZ6 lines 180, 181, 182
    "PAGE 3 of 3",
    "Buyer-Broker Exclusive Employment Agreement • August 2024 • Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.",
    "PAGE 3 of 3",
    ...BODY,
  ],
};

/** PAR RPC Dec. 2024 — every page's top line (12 pages) and page 1's watermark + © line. */
export const AZ7_PAR_RPC: AzFixture = {
  id: "AZ7-RPC",
  sources: ["AZ7"],
  lines: [
    // AZ7 line 1
    "Residential Resale Purchase Contract - Dec. 2024 Page 1 of 12",
    ...BODY,
    // AZ7 lines 54, 55, 56
    "RESIDENTIAL RESALE PURCHASE CONTRACTNOT INTENDED FOR USEEXAMPLE FORMSCopyright © Phoenix REALTORS® All Rights Reserved.",
    "Page 1",
    "Residential Resale Purchase Contract - Dec. 2024 Page 2 of 12",
    ...BODY,
    // AZ7 line 111
    "Residential Resale Purchase Contract - Dec. 2024 Page 3 of 12",
    ...BODY,
    // AZ7 line 177
    "Residential Resale Purchase Contract - Dec. 2024 Page 4 of 12",
    ...BODY,
    // AZ7 line 236
    "Residential Resale Purchase Contract - Dec. 2024 Page 5 of 12",
    ...BODY,
    // AZ7 line 297
    "Residential Resale Purchase Contract - Dec. 2024 Page 6 of 12",
    ...BODY,
    // AZ7 line 362
    "Residential Resale Purchase Contract - Dec. 2024 Page 7 of 12",
    ...BODY,
    // AZ7 line 426
    "Residential Resale Purchase Contract - Dec. 2024 Page 8 of 12",
    ...BODY,
    // AZ7 line 492
    "Residential Resale Purchase Contract - Dec. 2024 Page 9 of 12",
    ...BODY,
    // AZ7 line 553
    "Residential Resale Purchase Contract - Dec. 2024 Page 10 of 12",
    ...BODY,
    // AZ7 line 619
    "Residential Resale Purchase Contract - Dec. 2024 Page 11 of 12",
    ...BODY,
    // AZ7 line 675
    "Residential Resale Purchase Contract - Dec. 2024 Page 12 of 12",
    ...BODY,
  ],
};

export const AZ_FIXTURES: readonly AzFixture[] = [AZ5_AAR_RPC, AZ6_AAR_BBEEA, AZ7_PAR_RPC];
