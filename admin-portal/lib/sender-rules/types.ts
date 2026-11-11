/**
 * Sender rule sets — shared types for the admin page (BACKLOG-4186).
 *
 * The rule-set shape is the one stored in public.sender_rule_sets.content and
 * validated by public._sender_rule_set_invalid
 * (supabase/migrations/20261107235503_backlog_4175_sender_rule_sets.sql). The
 * desktop app's copy is electron/utils/senderFilter/bundledRules.ts; the admin
 * portal cannot import from electron/, so the shape is restated here.
 *
 * Pure: no Supabase, no React.
 */

export const SIGNALS = [
  'seedAddress',
  'approvedHost',
  'localPart',
  'bulkHeaders',
  'gmailPromotions',
  'gmailSocial',
  'gmailUpdates',
] as const;
export type SenderRuleSignal = (typeof SIGNALS)[number];

export const SURFACES = ['learnQuestions', 'addressPass', 'detector'] as const;
export type SenderRuleSurface = (typeof SURFACES)[number];

export const MODES = ['off', 'measure', 'live'] as const;
export type SenderRuleMode = (typeof MODES)[number];

/** gmailUpdates is measure-only (4175 migration, modes check). */
export const MEASURE_ONLY_SIGNALS: readonly SenderRuleSignal[] = ['gmailUpdates'];

/** 4175 `_sender_rule_set_str_ok`, kind 'bulkkey'. */
export const BULK_KEYS = [
  'list_unsubscribe',
  'list_unsubscribe_post',
  'precedence',
  'auto_submitted',
] as const;
export type BulkHeaderKey = (typeof BULK_KEYS)[number];

export const THRESHOLD_KEYS = [
  'minCensusLinkedEmails',
  'reportSendIntervalHours',
  'reportMaxRows',
] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export interface LocalPartRule {
  value: string;
  match: 'exact' | 'prefix';
}

export interface SenderRuleSet {
  schema: 1;
  version: number;
  suppress: {
    exactAddresses: string[];
    hosts: string[];
    localParts: LocalPartRule[];
    bulkHeaders: {
      anyKeyPresent: BulkHeaderKey[];
      precedenceValues: string[];
      autoSubmittedCounts: boolean;
    };
  };
  keep: {
    platformHosts: string[];
    platformAddresses: string[];
  };
  freeMailDomains: string[];
  thresholds: Record<ThresholdKey, number>;
  modes: Record<SenderRuleSignal, Record<SenderRuleSurface, SenderRuleMode>>;
}

/** Every list in a rule set, by its dotted path (the release guard's `list` value). */
export const LIST_PATHS = [
  'suppress.exactAddresses',
  'suppress.hosts',
  'suppress.localParts',
  'suppress.bulkHeaders.anyKeyPresent',
  'suppress.bulkHeaders.precedenceValues',
  'keep.platformHosts',
  'keep.platformAddresses',
  'freeMailDomains',
] as const;
export type ListPath = (typeof LIST_PATHS)[number];

/** One row of sender_rule_set_admin_state().versions (BACKLOG-4186 PR A). */
export interface RuleSetVersionRow {
  version: number;
  released: boolean;
  bundled: boolean;
  canary_org: string | null;
  /** NULL when the org was deleted (LEFT JOIN). */
  canary_org_name: string | null;
  published_at: string;
}

/** One row of sender_rule_set_admin_state().pins. */
export interface RuleSetPinRow {
  org_id: string;
  org_name: string | null;
  version: number;
  pinned_at: string;
}

/** sender_rule_set_admin_state(). */
export interface SenderRulesAdminState {
  released_version: number | null;
  /** More than 200 versions exist; `versions` holds the newest 200. */
  truncated: boolean;
  /** Newest first. */
  versions: RuleSetVersionRow[];
  pins: RuleSetPinRow[];
}
