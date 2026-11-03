/**
 * BACKLOG-4106 — California publishers and form rows. Every row ships with a fixture transcribed
 * from a blank copy (see __tests__/fixtures/caHeaders.ts).
 *
 * C.A.R. — code-page. Each page prints a code line at line start
 *   RPA REVISED 12/22 (PAGE 1 OF 16)     (a SAMPLE watermark may be glued in front)
 * and a per-page token `(RPA PAGE 1 OF 16)` near it. The © line prints on only a few pages, so the
 * paired token is the per-page publisher proof. On inner pages of some forms the token sits at the
 * page bottom, far from that page's code line: those pages do not pair and are not counted
 * (window −200/+300; measured on whole files, BACKLOG-4106 SR review R1).
 *
 * DRE — code-page `RE 882 (Rev. 10/10)` on page 1, `RE 882 — Page 2 of 3` after. No name on
 * inner pages; the department's name is a document marker. Unregistered DRE codes are dropped.
 *
 * Held (founder ruling on BACKLOG-4106): rows whose only source is a demo packet (RPA-CA and four
 * listing-side forms) and the SFAR agreement (OCR-only source). RPA-CA still reports as `?RPA-CA`.
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const CAR_PUBLISHER: PublisherRow = {
  id: "car",
  name: "California Association of REALTORS",
  namePattern: /California\s+Association\s+of\s+REALTORS®/i,
  region: { country: "US", state: "CA" },
  header: {
    kind: "code-page",
    // CP1. Group 1 = code, group 2 = revision. `i` absorbs "Revised" and "of"; the code itself must
    // be upper case (codeUpperCase). No `$`: initials and stamps are glued after the page token.
    codePage:
      /^[ \t]*(?:SAMPLE)?([A-Z][A-Z0-9]{1,5}(?:-[A-Z]{2})?) (?:REVISED )?(\d{1,2}\/\d{2}) \(PAGE \d+ OF \d+\)/gim,
    leadingNoise: /^[ \t]*(?:SAMPLE)?/i,
    codeUpperCase: true,
    // CP2. Brackets optional (one publisher layout prints `RIPA PAGE 1 OF 12`). The look-behind
    // stops a longer code's token from proving a shorter one ("(RPA PAGE" never proves "PA").
    pairedToken: (code: string) =>
      new RegExp(`(?<![A-Z0-9-])\\(?${escapeRegExp(code)} PAGE \\d+ OF \\d+\\)?`, "i"),
    requiredMarkers: [],
    revisionRequired: true,
    windowBefore: 200,
    windowAfter: 300,
    reportUnregistered: true,
  },
};

export const DRE_PUBLISHER: PublisherRow = {
  id: "dre",
  name: "California Department of Real Estate",
  namePattern: /Department\s+of\s+Real\s+Estate/i,
  region: { country: "US", state: "CA" },
  header: {
    kind: "code-page",
    // CP5. The revision is printed on page 1 only. Inner pages carry none, so it is looked up in the
    // whole text and is REQUIRED: inner pages plus a prose mention of the department do not match.
    codePage: /^RE (\d{3}[A-Z]?)(?: \(Rev\. (\d{2}\/\d{2})\)| — Page \d+ of \d+)/gm,
    // The text layer splits the letterhead's first letters ("D EPARTMENT OF REAL ESTATE").
    documentMarkers: [/D ?EPARTMENT OF REAL ESTATE|Department of Real Estate/],
    requiredMarkers: [],
    revision: /\(Rev\. (\d{2}\/\d{2})\)/,
    revisionScope: "document",
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 120,
    reportUnregistered: false,
  },
};

export const CA_PUBLISHERS: readonly PublisherRow[] = [CAR_PUBLISHER, DRE_PUBLISHER];

export const CA_FORMS: readonly FormRow[] = [
  {
    id: "car-RPA",
    publisherId: "car",
    code: "RPA",
    kind: "purchase_agreement",
    knownTitles: [/CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS/],
    observedRevisions: ["12/22"],
    sampleProvenance: ["CA1-RPA"],
  },
  {
    id: "car-BRBC",
    publisherId: "car",
    code: "BRBC",
    kind: "buyer_agreement",
    knownTitles: [/BUYER REPRESENTATION AND BROKER COMPENSATION AGREEMENT/],
    observedRevisions: ["12/24", "12/25"],
    sampleProvenance: ["CA2-BRBC", "CA3-BRBC"],
  },
  {
    id: "car-AD",
    publisherId: "car",
    code: "AD",
    kind: "other",
    knownTitles: [/DISCLOSURE REGARDING REAL ESTATE AGENCY RELATIONSHIP/],
    observedRevisions: ["12/24"],
    sampleProvenance: ["CA2-AD", "CA3-AD"],
  },
  {
    id: "dre-RE882",
    publisherId: "dre",
    code: "882",
    kind: "other",
    knownTitles: [/MORTGAGE LOAN D ?ISCLOSURE S ?TATEMENT/],
    observedRevisions: ["10/10"],
    sampleProvenance: ["CA4-RE882"],
  },
];
