/**
 * Email Sync Timing — its report key (BACKLOG-4130).
 *
 * The registry slug, which is also the public.reports catalog key that
 * report_my_access() and the sync_outcomes read policy check
 * (20261105160000). Throws at import if the slug is not registered.
 */

import { reportViewKey } from './registry';

export const EP_REPORT_KEY = reportViewKey('email-precache');
