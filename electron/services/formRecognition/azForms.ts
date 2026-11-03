/**
 * BACKLOG-4106 — Arizona publishers and form rows. Every row ships with a fixture transcribed from a
 * blank copy (see __tests__/fixtures/azHeaders.ts). Neither publisher prints a form code, so both are
 * title-keyed (adjacent: the title starts a line and the revision follows on that line).
 *
 * Arizona REALTORS® (AAR) — `<title> • Updated: August 2024` (RPC; © line on the next line) or
 * `<title> • August 2024 • Copyright © 2024 Arizona Association of REALTORS®. All rights reserved.`
 * (BBEEA; one line). The © guard tolerates a space before the full stop and a line break inside.
 *
 * Phoenix REALTORS® (PAR) — `<title> - Dec. 2024 Page 1 of 12` on every page; the publisher's ©
 * line prints with a watermark glued in front, once per page, so it is a document marker.
 *
 * Held (founder ruling on BACKLOG-4106): the regulator's advisories (title-only evidence) and the
 * AAR listing contract (no blank copy). Revision: every row requires it (ruling F4).
 */
import type { FormRow, PublisherRow } from "./formRegistryTypes";

export const AAR_PUBLISHER: PublisherRow = {
  id: "aar",
  name: "Arizona Association of REALTORS",
  namePattern: /Arizona\s+Association\s+of\s+REALTORS®/,
  region: { country: "US", state: "AZ" },
  header: {
    kind: "title-keyed",
    placement: "adjacent",
    anchorTemplate: "{title} • (?:Updated: )?(?<rev>[A-Z][a-z]+ \\d{4})",
    requiredMarkers: [
      /Copyright ©\s?\d{4}\s+Arizona\s+Association\s+of\s+REALTORS®\s?\.\s+All\s+rights\s+reserved\./,
    ],
    revisionRequired: true,
    // 0, not the plan's 50: the title starts a line and the © line (72 chars) cannot fit wholly in
    // 50 chars above it, so 50 would read as a guard and do nothing.
    windowBefore: 0,
    windowAfter: 300,
  },
};

export const PAR_PUBLISHER: PublisherRow = {
  id: "par",
  name: "Phoenix REALTORS",
  namePattern: /Phoenix\s+REALTORS®/,
  region: { country: "US", state: "AZ" },
  header: {
    kind: "title-keyed",
    placement: "adjacent",
    anchorTemplate: "{title} - (?<rev>[A-Z][a-z]{2}\\. \\d{4}) Page \\d+ of \\d+",
    documentMarkers: [/Copyright © Phoenix REALTORS® All Rights Reserved/],
    requiredMarkers: [],
    revisionRequired: true,
    windowBefore: 0,
    windowAfter: 100,
  },
};

export const AZ_PUBLISHERS: readonly PublisherRow[] = [AAR_PUBLISHER, PAR_PUBLISHER];

export const AZ_FORMS: readonly FormRow[] = [
  {
    id: "aar-rpc",
    publisherId: "aar",
    kind: "purchase_agreement",
    titleKey: [/Residential Resale Real Estate Purchase Contract/],
    knownTitles: [],
    observedRevisions: ["August 2024"],
    sampleProvenance: ["AZ5-RPC"],
  },
  {
    id: "aar-bbeea",
    publisherId: "aar",
    kind: "buyer_agreement",
    titleKey: [/Buyer-Broker Exclusive Employment Agreement/],
    knownTitles: [],
    observedRevisions: ["August 2024"],
    sampleProvenance: ["AZ6-BBEEA"],
  },
  {
    id: "par-rpc",
    publisherId: "par",
    kind: "purchase_agreement",
    titleKey: [/Residential Resale Purchase Contract/],
    knownTitles: [],
    observedRevisions: ["Dec. 2024"],
    sampleProvenance: ["AZ7-RPC"],
  },
];
