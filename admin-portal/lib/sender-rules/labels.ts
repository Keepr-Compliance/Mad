/**
 * Sender rules — words shown to the founder for each signal, surface and list (BACKLOG-4186).
 * Pure: no Supabase, no React.
 */

import type { ListPath, SenderRuleSignal, SenderRuleSurface, SenderRuleMode, ThresholdKey } from './types';

export const SIGNAL_LABELS: Record<SenderRuleSignal, string> = {
  seedAddress: 'Addresses',
  approvedHost: 'Domains',
  localPart: 'Sender names',
  bulkHeaders: 'Bulk headers',
  gmailPromotions: 'Gmail Promotions',
  gmailSocial: 'Gmail Social',
  gmailUpdates: 'Gmail Updates',
};

export const SURFACE_LABELS: Record<SenderRuleSurface, string> = {
  learnQuestions: 'Learn questions',
  addressPass: 'Email matching',
  detector: 'Deal detection',
};

export const MODE_LABELS: Record<SenderRuleMode, string> = {
  off: 'Off',
  measure: 'Measure',
  live: 'Live',
};

export const LIST_LABELS: Record<ListPath, string> = {
  'suppress.exactAddresses': 'Hide mail from: Addresses',
  'suppress.hosts': 'Hide mail from: Domains',
  'suppress.localParts': 'Hide mail from: Sender names',
  'suppress.bulkHeaders.anyKeyPresent': 'Bulk headers',
  'suppress.bulkHeaders.precedenceValues': 'Bulk headers: Precedence values',
  'keep.platformHosts': 'Always keep: Platform domains',
  'keep.platformAddresses': 'Always keep: Platform addresses',
  freeMailDomains: 'Free-mail domains',
};

export const THRESHOLD_LABELS: Record<ThresholdKey, string> = {
  minCensusLinkedEmails: 'Minimum linked emails',
  reportSendIntervalHours: 'Report interval (hours)',
  reportMaxRows: 'Report rows (max 500)',
};

/** A label for any string the server may send; unknown values come back unchanged. */
export function labelOf<K extends string>(table: Record<K, string>, key: unknown): string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key as K]
    : String(key);
}
