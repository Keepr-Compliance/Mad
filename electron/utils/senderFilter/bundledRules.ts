/**
 * Sender rules shipped with the app — BACKLOG-4175.
 *
 * Data only: no value imports, no I/O, no code built from these values. The shape
 * is the final rule-set shape; a later change only replaces where the active
 * set comes from, not the call sites that read it.
 *
 * Every rule VALUE lives here (or in a downloaded set of the same shape,
 * validated by ruleSetSchema.ts): addresses, hosts, local parts, header
 * names and values, thresholds and the per-surface modes. senderFilter.ts holds
 * the precedence and the matching only.
 *
 * Still unread: `thresholds.reportSendIntervalHours` and `reportMaxRows` (the
 * domain report, a later change). `approvedHost` live on `addressPass` is to be
 * confirmed before any host is approved; `suppress.hosts` ships empty.
 *
 * Every address and host here is lowercase (a pin test asserts it): matching
 * compares the parsed, lowercased From address with these entries exactly.
 */

import type { SingleValueKey } from "../bulkMailHeaders";

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

/** Header keys S3 may test: the single-valued retained keys (never Authentication-Results). */
export type BulkHeaderKey = SingleValueKey;

export interface SenderRuleSet {
  schema: 1;
  version: number;
  suppress: {
    exactAddresses: readonly string[];
    hosts: readonly string[];
    localParts: ReadonlyArray<{ value: string; match: "exact" | "prefix" }>;
    /** S3. What counts as bulk in `emails.bulk_mail_headers` (keys of bulkMailHeaders.ts). */
    bulkHeaders: {
      /** Any of these keys present (non-empty) counts. Never `authentication_results`. */
      anyKeyPresent: readonly BulkHeaderKey[];
      /** `precedence` values (compared lowercased, trimmed) that count. */
      precedenceValues: readonly string[];
      /** Whether an `auto_submitted` value other than "no" counts. */
      autoSubmittedCounts: boolean;
    };
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
    bulkHeaders: {
      anyKeyPresent: ["list_unsubscribe", "list_unsubscribe_post"],
      precedenceValues: ["bulk", "list", "junk"],
      autoSubmittedCounts: false,
    },
  },
  keep: {
    // Deal-platform sending hosts confirmed so far; other vendors stay empty
    // until confirmed.
    platformHosts: ["docusign.net", "docusign.com", "springcm.net", "showingtime.com", "showingtime.net"],
    platformAddresses: [],
  },
  // Major public free-mail and ISP mail domains (source: the providers listed
  // at https://en.wikipedia.org/wiki/Comparison_of_webmail_providers, plus the
  // large US ISP mail domains). A contact's domain in this list never becomes a
  // per-user keep domain (K3).
  freeMailDomains: [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "rocketmail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.net",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "fastmail.com",
    "comcast.net",
    "verizon.net",
    "att.net",
    "sbcglobal.net",
    "bellsouth.net",
    "cox.net",
    "charter.net",
    "earthlink.net",
  ],
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
