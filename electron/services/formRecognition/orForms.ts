/**
 * BACKLOG-4106 — Oregon publishers and form rows. Every row ships with a fixture transcribed from
 * a blank copy (see __tests__/fixtures/orHeaders.ts).
 *
 * OREF (Oregon Real Estate Forms, LLC) — mid-line marker. The footer line reads
 *   …REQUIRE A SIGNATURE AND DATE OREF 001 | Released 01/2026 | Page 1 of 15
 * with the publisher's name on the next line. The page segment is optional: the advisory (000B)
 * prints it on the next line.
 *
 * Oregon REALTORS — code-page. The page line reads
 *   Form 1.1 · <title> · Version 2026-2 Page 1 of 10
 * followed by the publisher's © line. `Form 3.1·` prints no space before the dot.
 *
 * Held: the regulator's own pamphlet (title-only evidence; founder ruling on BACKLOG-4106).
 * knownTitles are written against NORMALISED text (straight apostrophes).
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

export const OREF_PUBLISHER: PublisherRow = {
  id: "oref",
  name: "Oregon Real Estate Forms, LLC",
  namePattern: /Oregon\s+Real\s+Estate\s+Forms,\s+LLC/,
  region: { country: "US", state: "OR" },
  header: {
    kind: "mid-line",
    // ML1. Group 1 = code, group 2 = revision. Literal spaces: the marker never spans lines.
    marker: /OREF (\d{3}[A-Z]?) \| Released (\d{2}\/\d{4})(?: \| Page \d+ of \d+)?/g,
    requiredMarkers: [/Oregon\s+Real\s+Estate\s+Forms,\s+LLC/],
    revisionRequired: true,
    windowBefore: 150,
    windowAfter: 300,
    reportUnregistered: true,
  },
};

export const ORR_PUBLISHER: PublisherRow = {
  id: "orr",
  name: "Oregon REALTORS",
  namePattern: /Oregon\s+REALTORS®/,
  region: { country: "US", state: "OR" },
  header: {
    kind: "code-page",
    // CP4. Group 1 = code, group 2 = Version. `[ ]*` (not `\s*`) so the code line never spans lines.
    codePage: /^Form (\d{1,2}\.\d{1,2}[A-Z]?)[ ]*· .+? · Version (\d{4}-\d) Page \d+ of \d+/gm,
    requiredMarkers: [/Copyright © \d{4} Oregon REALTORS®/],
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 250,
    reportUnregistered: true,
  },
};

export const OR_PUBLISHERS: readonly PublisherRow[] = [OREF_PUBLISHER, ORR_PUBLISHER];

export const OR_FORMS: readonly FormRow[] = [
  {
    id: "oref-001",
    publisherId: "oref",
    code: "001",
    kind: "purchase_agreement",
    knownTitles: [/RESIDENTIAL REAL ESTATE SALE AGREEMENT/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-001"],
  },
  {
    id: "oref-003",
    publisherId: "oref",
    code: "003",
    kind: "counteroffer",
    knownTitles: [/SELLER'S COUNTEROFFER/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-003"],
  },
  {
    id: "oref-004",
    publisherId: "oref",
    code: "004",
    kind: "counteroffer",
    knownTitles: [/BUYER'S COUNTEROFFER/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-004"],
  },
  {
    id: "oref-015",
    publisherId: "oref",
    code: "015",
    kind: "listing_agreement",
    knownTitles: [/LISTING AGREEMENT - EXCLUSIVE/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-015"],
  },
  {
    id: "oref-050",
    publisherId: "oref",
    code: "050",
    kind: "buyer_agreement",
    knownTitles: [/BUYER REPRESENTATION AGREEMENT – EXCLUSIVE/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-050"],
  },
  {
    id: "oref-052",
    publisherId: "oref",
    code: "052",
    kind: "buyer_agreement",
    knownTitles: [/BUYER REPRESENTATION AGREEMENT – NONEXCLUSIVE/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-052"],
  },
  {
    // Terminates the sale agreement, not a representation agreement.
    id: "oref-057",
    publisherId: "oref",
    code: "057",
    kind: "other",
    knownTitles: [/TERMINATION AGREEMENT AND DEPOSIT DISBURSEMENT INSTRUCTIONS/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-057"],
  },
  {
    // Its footer misspells the publisher's name once; the © part of the same line spells it
    // correctly, so the strict required marker still holds (no typo tolerance).
    id: "oref-009",
    publisherId: "oref",
    code: "009",
    kind: "other",
    knownTitles: [/BACK-UP OFFER ADDENDUM/],
    observedRevisions: ["01/2026"],
    sampleProvenance: ["OR2-009"],
  },
  {
    id: "orr-1.1",
    publisherId: "orr",
    code: "1.1",
    kind: "purchase_agreement",
    knownTitles: [/Oregon Residential Real Estate Purchase and Sale Agreement/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR3-1.1"],
  },
  {
    id: "orr-2.1",
    publisherId: "orr",
    code: "2.1",
    kind: "counteroffer",
    knownTitles: [/Counteroffer to Real Estate Purchase and Sale Agreement/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR4-2.1"],
  },
  {
    id: "orr-9.3",
    publisherId: "orr",
    code: "9.3",
    kind: "listing_agreement",
    knownTitles: [/Listing Agreement/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR5-9.3"],
  },
  {
    id: "orr-9.4",
    publisherId: "orr",
    code: "9.4",
    kind: "buyer_agreement",
    knownTitles: [/Buyer Representation Agreement/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR6-9.4"],
  },
  {
    id: "orr-3.1",
    publisherId: "orr",
    code: "3.1",
    kind: "other",
    knownTitles: [/Seller Property Disclosure Statement/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR8-3.1"],
  },
  {
    id: "orr-10.4",
    publisherId: "orr",
    code: "10.4",
    kind: "other",
    knownTitles: [/Initial Agency Disclosure Pamphlet/],
    observedRevisions: ["2026-2"],
    sampleProvenance: ["OR7-10.4"],
  },
];
