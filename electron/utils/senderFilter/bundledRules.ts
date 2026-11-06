/**
 * Sender rules shipped with the app — BACKLOG-4175.
 *
 * Data only: no imports, no I/O, no code built from these values. The shape
 * is the final rule-set shape; a later change only replaces where the active
 * set comes from, not the call sites that read it.
 *
 * In use today: `suppress.exactAddresses` and `modes.seedAddress`. Every other
 * field is present for the shape and is read by nothing yet.
 *
 * UNREAD PLACEHOLDERS: `thresholds`, `keep`, `freeMailDomains` and every mode
 * other than `seedAddress`. Their values are not decisions; the PR that first
 * reads each one sets it. In particular `approvedHost` live on `addressPass` is
 * to be confirmed in PR2 / PR4 before any host is approved.
 *
 * Every address and host here is lowercase (a pin test asserts it): matching
 * compares the parsed, lowercased From address with these entries exactly.
 */

export type SenderRuleMode = "off" | "measure" | "live";

export interface SenderRuleModes {
  learnQuestions: SenderRuleMode;
  addressPass: SenderRuleMode;
  detector: SenderRuleMode;
}

export type SenderRuleSignal =
  | "seedAddress"
  | "approvedHost"
  | "localPart"
  | "bulkHeaders"
  | "gmailPromotions"
  | "gmailSocial"
  | "gmailUpdates";

export interface SenderRuleSet {
  schema: 1;
  version: number;
  suppress: {
    exactAddresses: readonly string[];
    hosts: readonly string[];
    localParts: ReadonlyArray<{ value: string; match: "exact" | "prefix" }>;
  };
  keep: {
    platformHosts: readonly string[];
    platformAddresses: readonly string[];
  };
  freeMailDomains: readonly string[];
  thresholds: {
    minCensusLinkedEmails: number;
    reportSendIntervalHours: number;
    reportMaxRows: number;
  };
  modes: Readonly<Record<SenderRuleSignal, SenderRuleModes>>;
}

const MEASURE_ONLY: SenderRuleModes = { learnQuestions: "measure", addressPass: "off", detector: "measure" };
const LIVE: SenderRuleModes = { learnQuestions: "live", addressPass: "live", detector: "live" };

export const BUNDLED_SENDER_RULES: SenderRuleSet = {
  schema: 1,
  version: 1,
  suppress: {
    exactAddresses: ["my-saved-home@mail.zillow.com", "recommendations@mail.zillow.com"],
    hosts: [],
    localParts: [],
  },
  keep: {
    platformHosts: [],
    platformAddresses: [],
  },
  freeMailDomains: [],
  thresholds: {
    minCensusLinkedEmails: 20,
    reportSendIntervalHours: 24,
    reportMaxRows: 500,
  },
  modes: {
    seedAddress: LIVE,
    approvedHost: LIVE,
    localPart: MEASURE_ONLY,
    bulkHeaders: MEASURE_ONLY,
    gmailPromotions: MEASURE_ONLY,
    gmailSocial: MEASURE_ONLY,
    gmailUpdates: MEASURE_ONLY,
  },
};
