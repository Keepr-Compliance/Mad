/**
 * Learn pilot — the report key, the page path and the share dialog's role lines (BACKLOG-4219).
 *
 * The key is in public.reports (20261112130000); learn_pilot_report_admin_list() answers only a
 * caller with report_my_access('learn-pilot') non-null. Every grant reads; nothing on the page
 * writes. The server is the enforcement.
 */

export const LEARN_PILOT_REPORT_KEY = 'learn-pilot';

/** The page, in the sidebar's AI section (not under Reports). */
export const LEARN_PILOT_PATH = '/dashboard/ai/learn-pilot';

/** Every grant only reads here, so "Can edit" is described as the same as "Can view". */
export const LEARN_PILOT_SHARE_ROLE_DESCRIPTIONS = {
  viewer: 'Sees the pilot numbers',
  editor: 'Same as Can view on this page: sees the pilot numbers',
} as const;
