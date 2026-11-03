/**
 * BACKLOG-4106 — Nevada publishers and form rows. Every row ships with a fixture transcribed from a
 * blank copy (see __tests__/fixtures/nvHeaders.ts). None of these publishers prints a form code in
 * a header the matcher could key on, so every row is title-keyed.
 *
 * GLVAR (Greater Las Vegas Association of REALTORS®) — title-keyed, adjacent. One line per page:
 *   Residential Purchase Agreement Rev. 10/25 ©2025 Greater Las Vegas Association of REALTORS®
 * (the © part may sit on the next line, and one page prints `© 2022` with a space).
 *
 * SNR (Sierra Nevada REALTORS®) — title-keyed, whole line. The page-1 title is followed by the page
 * line `Page 1 of 12 SNR© 03/26`.
 *
 * NRED (Nevada Real Estate Division) — title-keyed, whole line(s). The title is an upper-case line;
 * the Division's name and the `Revised …` / `Effective …` date sit in a block above or far below it
 * (525: +3,557 chars), so the window is −300/+3800. Form 676 prints only the state letterhead
 * (`REAL ESTATE DIVISION` as its own line). The form number is display only (`code`).
 *
 * Revision: every row requires it (founder ruling F4 on BACKLOG-4106).
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

export const GLVAR_PUBLISHER: PublisherRow = {
  id: "glvar",
  name: "Greater Las Vegas Association of REALTORS",
  namePattern: /Greater\s+Las\s+Vegas\s+Association\s+of\s+REALTORS®/,
  region: { country: "US", state: "NV" },
  header: {
    kind: "title-keyed",
    placement: "adjacent",
    // TK-A. Revision separator is `/` or `.` (`Rev. 07.24`).
    anchorTemplate: "{title} Rev\\. (?<rev>\\d{2}[./]\\d{2})",
    requiredMarkers: [/©\s?\d{4}\s+Greater\s+Las\s+Vegas\s+Association\s+of\s+REALTORS®/],
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 200,
  },
};

export const SNR_PUBLISHER: PublisherRow = {
  id: "snr",
  name: "Sierra Nevada REALTORS",
  namePattern: /SNR©/,
  region: { country: "US", state: "NV" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [/Page \d+ of \d+ SNR©/],
    revision: /SNR© (\d{2}\/\d{2})/,
    revisionRequired: true,
    windowBefore: 120,
    windowAfter: 120,
  },
};

export const NRED_PUBLISHER: PublisherRow = {
  id: "nred",
  name: "Nevada Real Estate Division",
  namePattern: /Nevada\s+Real\s+Estate\s+Division/,
  region: { country: "US", state: "NV" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [/Nevada Real Estate Division|^REAL ESTATE DIVISION$/m],
    // One capture group for both forms of the date ("Revised: 04/23/2025", "Effective July 1, 2010").
    revision: /(?:Revised:? |Effective )(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2}, \d{4})/,
    revisionRequired: true,
    windowBefore: 300,
    windowAfter: 3800,
  },
};

export const NV_PUBLISHERS: readonly PublisherRow[] = [GLVAR_PUBLISHER, SNR_PUBLISHER, NRED_PUBLISHER];

export const NV_FORMS: readonly FormRow[] = [
  {
    id: "glvar-rpa",
    publisherId: "glvar",
    kind: "purchase_agreement",
    titleKey: [/Residential Purchase Agreement/],
    knownTitles: [],
    observedRevisions: ["10/25"],
    sampleProvenance: ["NV1-RPA"],
  },
  {
    id: "glvar-bba",
    publisherId: "glvar",
    kind: "buyer_agreement",
    titleKey: [/Buyer Brokerage Agreement/],
    knownTitles: [],
    observedRevisions: ["01/19"],
    sampleProvenance: ["NV2-BBA"],
  },
  {
    id: "glvar-er",
    publisherId: "glvar",
    kind: "listing_agreement",
    titleKey: [/Exclusive Right \(ER\) Listing Agreement/],
    knownTitles: [],
    observedRevisions: ["07.24"],
    sampleProvenance: ["NV3-ER"],
  },
  {
    id: "snr-oaa",
    publisherId: "snr",
    kind: "purchase_agreement",
    titleKey: [/RESIDENTIAL OFFER AND ACCEPTANCE AGREEMENT/],
    knownTitles: [],
    observedRevisions: ["03/26"],
    sampleProvenance: ["NV4-OAA"],
  },
  {
    id: "nred-524",
    publisherId: "nred",
    code: "524",
    kind: "other",
    titleKey: [/CONSENT TO ACT/],
    knownTitles: [],
    observedRevisions: ["05/01/05"],
    sampleProvenance: ["NV5-524"],
  },
  {
    id: "nred-525",
    publisherId: "nred",
    code: "525",
    kind: "other",
    titleKey: [/DUTIES OWED BY A NEVADA REAL ESTATE LICENSEE/],
    knownTitles: [],
    observedRevisions: ["10/03/2023"],
    sampleProvenance: ["NV6-525"],
  },
  {
    // Its 2-line title contains the 525 title as line 2: the longer title wins there (TK-W).
    id: "nred-525A",
    publisherId: "nred",
    code: "525A",
    kind: "other",
    titleKey: [/SUPPLEMENTAL LIST OF LICENSEES PARTY TO THE\nDUTIES OWED BY A NEVADA REAL ESTATE LICENSEE/],
    knownTitles: [],
    observedRevisions: ["11/7/16"],
    sampleProvenance: ["NV7-525A"],
  },
  {
    // The title prints with a curly apostrophe; titles match normalised text.
    id: "nred-547",
    publisherId: "nred",
    code: "547",
    kind: "other",
    titleKey: [/SELLER'S REAL PROPERTY DISCLOSURE FORM/],
    knownTitles: [],
    observedRevisions: ["6/1/2023"],
    sampleProvenance: ["NV8-547"],
  },
  {
    id: "nred-551",
    publisherId: "nred",
    code: "551",
    kind: "other",
    titleKey: [/OPEN RANGE DISCLOSURE/],
    knownTitles: [],
    observedRevisions: ["July 1, 2010"],
    sampleProvenance: ["NV9-551"],
  },
  {
    id: "nred-676",
    publisherId: "nred",
    code: "676",
    kind: "other",
    titleKey: [/WAIVER AND AUTHORIZATION TO NEGOTIATE DIRECTLY WITH THE CLIENT FORM/],
    knownTitles: [],
    observedRevisions: ["04/23/2025"],
    sampleProvenance: ["NV10-676"],
  },
];
