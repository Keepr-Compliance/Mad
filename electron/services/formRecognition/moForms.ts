/**
 * BACKLOG-4106 — Missouri publishers and form rows. Every row ships with a fixture transcribed from a
 * blank copy (see __tests__/fixtures/moHeaders.ts).
 *
 * MREC (Missouri Real Estate Commission) — title-keyed, whole line. The title may print mid-page
 * (portrait layout: 3,034 chars in) and the `Prescribed by the Missouri Real Estate Commission as of
 * January, 2005` line up to 2,059 chars after it, so the window is ±2600.
 *
 * Missouri REALTORS® (MR) — code-page. Each page starts a line with `RES-1010 Page 1 of 6` (upper or
 * mixed case); no `$`, so text glued after the page token is allowed. The publisher's name and the
 * `Last Revised 12/31/12.` line print once, near the end, so both are looked up in the whole text.
 *
 * KCRAR (Kansas City Regional Association of REALTORS®) — title-keyed, whole line. Every page prints
 * the title with the page line right under it; the publisher's name and `Last revised September
 * 2020.` print once, at the end (document scope).
 *
 * Held: RES-2000 (its blank prints no revision; founder ruling F4 on BACKLOG-4106: every match
 * carries its revision) and RES-1020 (nothing banked). Revision: every row requires it.
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

export const MREC_PUBLISHER: PublisherRow = {
  id: "mrec",
  name: "Missouri Real Estate Commission",
  namePattern: /Missouri\s+Real\s+Estate\s+Commission/,
  region: { country: "US", state: "MO" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [/Prescribed by the Missouri Real Estate Commission as of/],
    revision: /as of ([A-Z][a-z]+, \d{4})/,
    revisionRequired: true,
    windowBefore: 2600,
    windowAfter: 2600,
  },
};

export const MR_PUBLISHER: PublisherRow = {
  id: "mr",
  name: "Missouri REALTORS",
  namePattern: /Missouri\s+(?:Association\s+of\s+)?(?:REALTORS®|Realtors)/,
  region: { country: "US", state: "MO" },
  header: {
    kind: "code-page",
    // CP3. Group 1 = code. The page total is matched and discarded.
    codePage: /^[ \t]*([A-Z]{3}-\d{4}) (?:PAGE|Page) \d+ (?:OF|of) \d+/gm,
    documentMarkers: [/Missouri (?:Association of )?(?:REALTORS®|Realtors)/],
    requiredMarkers: [],
    revision: /Last Revised (\d{1,2}\/\d{1,2}\/\d{2})\./,
    revisionScope: "document",
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 60,
    reportUnregistered: true,
  },
};

export const KCRAR_PUBLISHER: PublisherRow = {
  id: "kcrar",
  name: "Kansas City Regional Association of REALTORS",
  namePattern: /Kansas\s+City\s+Regional\s+Association\s+of\s+REALTORS®/,
  region: { country: "US", state: "MO" },
  header: {
    kind: "title-keyed",
    placement: "line",
    requiredMarkers: [/^Page \d+ of \d+/m],
    documentMarkers: [/Kansas City Regional Association of REALTORS®/],
    revision: /Last revised ([A-Z][a-z]+ \d{4})\./,
    revisionScope: "document",
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 60,
  },
};

export const MO_PUBLISHERS: readonly PublisherRow[] = [MREC_PUBLISHER, MR_PUBLISHER, KCRAR_PUBLISHER];

export const MO_FORMS: readonly FormRow[] = [
  {
    id: "mrec-broker-disclosure",
    publisherId: "mrec",
    kind: "other",
    titleKey: [/MISSOURI BROKER DISCLOSURE FORM/],
    knownTitles: [],
    observedRevisions: ["January, 2005"],
    sampleProvenance: ["MO1-MREC", "MO2-MREC"],
  },
  {
    id: "mr-RES-1010",
    publisherId: "mr",
    code: "RES-1010",
    kind: "listing_agreement",
    knownTitles: [/Seller's Agency Listing Contract/],
    observedRevisions: ["12/31/12"],
    sampleProvenance: ["MO5-RES1010"],
  },
  {
    id: "mr-DSC-8000",
    publisherId: "mr",
    code: "DSC-8000",
    kind: "other",
    knownTitles: [/Seller's Disclosure Statement for Residential Property/],
    observedRevisions: ["12/31/09"],
    sampleProvenance: ["MO4-DSC8000"],
  },
  {
    id: "kcrar-sale-contract",
    publisherId: "kcrar",
    kind: "purchase_agreement",
    titleKey: [/Residential Real Estate Sale Contract/],
    knownTitles: [],
    observedRevisions: ["September 2020"],
    sampleProvenance: ["MO6-KCRAR"],
  },
];
