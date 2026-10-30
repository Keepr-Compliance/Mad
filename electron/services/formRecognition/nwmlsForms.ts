/**
 * BACKLOG-3941 — NWMLS (Washington) form rows, in priority order: the main transaction forms
 * first (21, 41, 1A, 36), then 1A-SWF, 41C, 36A, 54. Every row ships with a fixture transcribed
 * from a blank copy (see __tests__/fixtures/nwmlsHeaders.ts). Forms 53 and plain 1B are held:
 * no blank copy has been obtained.
 *
 * knownTitles are written against NORMALISED text (straight apostrophes).
 */
import type { FormRow } from "./formRegistryTypes";

export const NWMLS_FORMS: readonly FormRow[] = [
  {
    id: "nwmls-21",
    publisherId: "nwmls",
    code: "21",
    kind: "purchase_agreement",
    knownTitles: [/Residential\s+PSA/],
    observedRevisions: ["7/23"],
    sampleProvenance: ["S7-21"],
  },
  {
    id: "nwmls-41",
    publisherId: "nwmls",
    code: "41",
    kind: "buyer_agreement",
    // Current title only. Rev. 10/22 was titled "Exclusive Buyer's Agency Agreement"; leaving it
    // out keeps the 10/22 fixture as the proof that a title is never a gate.
    knownTitles: [/Buyer\s+Brokerage\s+Services\s+Agreement/],
    observedRevisions: ["8/24", "10/22"],
    sampleProvenance: ["S1-41", "S4-41"],
  },
  {
    id: "nwmls-1A",
    publisherId: "nwmls",
    code: "1A",
    kind: "listing_agreement",
    knownTitles: [/Exclusive\s+Sale/],
    observedRevisions: ["3/21", "6/13"],
    sampleProvenance: ["S5-1A", "S6-1A"],
  },
  {
    id: "nwmls-36",
    publisherId: "nwmls",
    code: "36",
    kind: "counteroffer",
    knownTitles: [/Counteroffer\s+Addendum/],
    observedRevisions: ["8/11"],
    sampleProvenance: ["S8-36"],
  },
  {
    id: "nwmls-1A-SWF",
    publisherId: "nwmls",
    code: "1A-SWF",
    kind: "listing_agreement",
    knownTitles: [/Exclusive\s+Sale/],
    observedRevisions: ["10/22"],
    sampleProvenance: ["S4-1A-SWF"],
  },
  {
    id: "nwmls-41C",
    publisherId: "nwmls",
    code: "41C",
    kind: "other",
    knownTitles: [/Buyer\s+Brokerage\s+Firm's\s+Compensation/],
    observedRevisions: ["10/22", "7/23"],
    sampleProvenance: ["S4-41C", "S8-41C"],
  },
  {
    id: "nwmls-36A",
    publisherId: "nwmls",
    code: "36A",
    kind: "other",
    knownTitles: [/Offer\/Counteroffer\s+Withdrawal/],
    observedRevisions: ["3/21"],
    sampleProvenance: ["S8-36A"],
  },
  {
    id: "nwmls-54",
    publisherId: "nwmls",
    code: "54",
    kind: "representation_termination",
    knownTitles: [/Termination\s+of\s+Seller\s+Rep\.\s+Agreement/],
    observedRevisions: ["3/21"],
    sampleProvenance: ["S9-54"],
  },
];
