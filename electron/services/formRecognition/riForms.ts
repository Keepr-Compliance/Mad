/**
 * BACKLOG-4106 — Rhode Island publishers and form rows. Every row ships with a fixture transcribed
 * from a blank copy (see __tests__/fixtures/riHeaders.ts). Neither publisher prints a form code, so
 * both are title-keyed (whole line).
 *
 * Real Estate Commission (the mandatory relationship disclosure and its team addendum) — the
 * revision `Rev. 03/22` is the only marker besides the title: no publisher line is printed. The
 * disclosure prints it just above its title (`Page 1 of 2Rev. 03/22`), the team addendum as its last
 * line (+3,626), hence the window −80/+3800. A bare draft date (`3-18-22`) under the disclosure's
 * title is not a revision.
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

export const RI_COMMISSION_PUBLISHER: PublisherRow = {
  id: "ri-commission",
  name: "Rhode Island Real Estate Commission",
  namePattern: /Rhode\s+Island\s+Real\s+Estate\s+Commission/,
  region: { country: "US", state: "RI" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [],
    revision: /Rev\. ?(\d{2}\/\d{2})(?![\d/])/,
    revisionRequired: true,
    windowBefore: 80,
    windowAfter: 3800,
  },
};

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

export const RI_PUBLISHERS: readonly PublisherRow[] = [RI_COMMISSION_PUBLISHER, RIAR_PUBLISHER];

export const RI_FORMS: readonly FormRow[] = [
  {
    id: "ri-mred",
    publisherId: "ri-commission",
    kind: "other",
    titleKey: [/RHODE ISLAND MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE/],
    knownTitles: [],
    observedRevisions: ["03/22"],
    sampleProvenance: ["RI1-MRED"],
  },
  {
    id: "ri-mred-team",
    publisherId: "ri-commission",
    kind: "other",
    titleKey: [/ADDENDUM TO RI MANDATORY REAL ESTATE RELATIONSHIP DISCLOSURE\nFOR REAL ESTATE TEAMS/],
    knownTitles: [],
    observedRevisions: ["03/22"],
    sampleProvenance: ["RI2-TEAM"],
  },
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
