/**
 * Saved-view keys come from the registry (BACKLOG-3728, BACKLOG-4084 PR D).
 *
 * Google Messages Sync no longer shares the iPhone sync key; iPhone's key is
 * unchanged, so its existing views stay where they are.
 */

import { describe, expect, it } from 'vitest';
import { REPORTS, reportViewKey } from '../registry';
import { REPORT_KEY } from '../report-views';
import { GM_SYNC_REPORT_KEY } from '../google-messages-sync-views';
import { SUBMISSIONS_REPORT_KEY } from '../submissions-views';

describe('K1 per-report keys', () => {
  it('each key is its registry slug', () => {
    expect(GM_SYNC_REPORT_KEY).toBe('google-messages-sync');
    expect(SUBMISSIONS_REPORT_KEY).toBe('submissions');
    expect(REPORTS.map((r) => r.slug)).toEqual(expect.arrayContaining([GM_SYNC_REPORT_KEY, SUBMISSIONS_REPORT_KEY]));
  });

  it('Google Messages Sync does not share the iPhone sync key, which is unchanged', () => {
    expect(REPORT_KEY).toBe('iphone-sync');
    expect(GM_SYNC_REPORT_KEY).not.toBe(REPORT_KEY);
    expect(SUBMISSIONS_REPORT_KEY).not.toBe(REPORT_KEY);
  });

  it('an unregistered slug throws', () => {
    expect(() => reportViewKey('not-a-report')).toThrow('Unknown report: not-a-report');
  });
});
