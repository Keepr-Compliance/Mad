/**
 * Account-page fixtures — BACKLOG-3079.
 *
 * PROVENANCE. The preference SHAPES below are transcribed from production on
 * 2026-09-04: `jsonb_object_keys` over every user_preferences row gave the
 * thirteen top-level keys and their sub-keys, and one representative value per
 * key was read back with jsonb_pretty. So the nesting, the key spellings and
 * the value types are what the desktop actually writes, not what this page
 * hopes it writes — a hand-composed blob would prove the test, not the code.
 *
 * NOTHING IDENTIFYING IS REPRODUCED. Every id and email here is invented; this
 * repository is public and a committed identifier cannot be un-published.
 */

import type { AccountView } from '@/lib/account/accountView';

/** pii-allow-uuid: invented, not from any live row. */
export const ACCOUNT_USER_ID = '00000000-3079-4000-8000-000000000001';
/** pii-allow-uuid: invented, not from any live row. */
export const OTHER_USER_ID = '00000000-3079-4000-8000-000000000002';

/**
 * Every top-level key observed in prod, with a representative value.
 * Thirteen keys: contactSources, export, phone_type, sync, messageImport,
 * messages, contactAutoRole, updates, onboarding, audit, emailCache,
 * integrations, emailSync.
 */
export const FULL_PREFERENCES: Record<string, unknown> = {
  sync: { autoSyncOnLogin: true },
  audit: { startDateDefault: 'manual' },
  export: {
    defaultFormat: 'combined-pdf',
    contentType: 'both',
    attachmentType: 'all',
    emailExportMode: 'individual',
  },
  updates: { autoDownload: true },
  messages: { source: 'macos-native' },
  emailSync: { lookbackMonths: 6 },
  emailCache: { durationMonths: 12 },
  // resumeStep is FREQUENTLY null in prod — the marker is cleared on a normal
  // finish and only set mid-relaunch. Both onboarding paths are hidden from the
  // page (HIDDEN_PREFERENCES), and a filter that dropped only non-null values
  // would pass a non-null fixture while still shipping the bug, so the null is
  // the fixture.
  onboarding: { resumeStep: null, resumeSavedAt: 1784857302158 },
  phone_type: 'android',
  integrations: { iphoneSyncEnabled: true },
  messageImport: {
    filters: { maxMessages: 50000, lookbackMonths: 9 },
    android: { filters: { maxMessages: null, lookbackMonths: null } },
  },
  contactSources: {
    direct: { googleContacts: false, iphoneContacts: true, outlookContacts: false },
    inferred: { outlookEmails: true, messages: false },
  },
  contactAutoRole: { enabled: true },
};

/** The pre-registered count of leaf paths in FULL_PREFERENCES.
 *  A silent edit that drops one would otherwise weaken every assertion built
 *  on "nothing is dropped" without failing anything. */
export const FULL_PREFERENCES_LEAF_COUNT = 24;

/** Leaves FULL_PREFERENCES holds that are in HIDDEN_PREFERENCES:
 *  onboarding.resumeStep and onboarding.resumeSavedAt. */
export const FULL_PREFERENCES_HIDDEN_COUNT = 2;

/** Rows the page renders for FULL_PREFERENCES. Pre-registered separately AND
 *  asserted to equal LEAF - HIDDEN, so neither number can drift alone. */
export const FULL_PREFERENCES_VISIBLE_COUNT = 22;

/** The hidden-marker case on its own: every leaf here must vanish, and the
 *  page must emit no section at all for it. resumeStep is null on purpose. */
export const HIDDEN_ONLY_PREFERENCES: Record<string, unknown> = {
  onboarding: { resumeStep: null, resumeSavedAt: 1784857302158 },
};

/** The sparse case the item names: only phone_type + contactSources. */
export const SPARSE_PREFERENCES: Record<string, unknown> = {
  phone_type: 'iphone',
  contactSources: { direct: { macosContacts: true } },
};

export function makeAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    identity: {
      userId: ACCOUNT_USER_ID,
      displayName: 'Alex Rivera',
      email: 'alex.rivera@example.test',
      authProvider: 'azure',
      role: 'agent',
      organizationName: 'Northwind Realty',
      createdAt: '2026-01-15T10:00:00.000Z',
    },
    preferences: FULL_PREFERENCES,
    preferencesUpdatedAt: '2026-08-30T12:00:00.000Z',
    orgRetentionYears: null,
    isImpersonating: false,
    ...overrides,
  };
}
