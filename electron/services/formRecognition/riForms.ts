/**
 * BACKLOG-4106 — Rhode Island publishers and form rows. Every row ships with a fixture transcribed
 * from a blank copy (see __tests__/fixtures/riHeaders.ts). RIAR prints no form code, so it is
 * title-keyed (whole line).
 *
 * Held (founder ruling on BACKLOG-4106): the Real Estate Commission's mandatory relationship
 * disclosure and its team addendum. They print a title and `Rev. 03/22` but no publisher or © line,
 * so they do not meet the title + revision + publisher rule and ship no row; their fixtures
 * (riHeaders.ts) back the negative pins.
 *
 * Rhode Island Association of REALTORS® (RIAR) — page 1 prints the page token and the revision on
 * one line, in either order and glued or spaced (`Rev 05/19 Page 1 of 6`, `Page 1 of 4Rev. 01/19`),
 * then the title, then the publisher's name. All three must lie within ±150 of the title.
 *
 * A revision followed by another `/` or digit (`Rev. 07/15/24`, a handout date) is not a revision.
 * Held: Seller's Lead Disclosure (filled copy only) and the MLS listing agreement (nothing banked).
 * Revision: every row requires it (founder ruling F4 on BACKLOG-4106).
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

export const RIAR_PUBLISHER: PublisherRow = {
  id: "riar",
  name: "Rhode Island Association of REALTORS",
  namePattern: /Rhode\s+Island\s+Association\s+of\s+REALTORS®/,
  region: { country: "US", state: "RI" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [
      /Rhode Island Association of REALTORS®/,
      /Page \d+ of \d+ ?Rev\.? ?\d{2}\/\d{2}|Rev\.? ?\d{2}\/\d{2} Page \d+ of \d+/,
    ],
    revision: /Rev\.? ?(\d{2}\/\d{2})(?![\d/])/,
    revisionRequired: true,
    windowBefore: 150,
    windowAfter: 150,
  },
};

export const RI_PUBLISHERS: readonly PublisherRow[] = [RIAR_PUBLISHER];

export const RI_FORMS: readonly FormRow[] = [
  {
    id: "riar-sales-disclosure",
    publisherId: "riar",
    kind: "other",
    titleKey: [/RHODE ISLAND REAL ESTATE SALES DISCLOSURE FORM/],
    knownTitles: [],
    observedRevisions: ["05/19"],
    sampleProvenance: ["RI3-SD"],
  },
  {
    id: "riar-sf-ps",
    publisherId: "riar",
    kind: "purchase_agreement",
    titleKey: [/SINGLE FAMILY PURCHASE AND SALES AGREEMENT/],
    knownTitles: [],
    observedRevisions: ["01/19"],
    sampleProvenance: ["RI4-PS"],
  },
];
