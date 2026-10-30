/**
 * User Activity report — render tests (BACKLOG-3720)
 *
 * Static render, no router: `UserActivityReport` takes navigation as a prop.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildUserActivityReport, LATEST_ONLY_NOTE } from '@/lib/reports/user-activity';
import {
  ALICE,
  CAROL,
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  ORGS,
  STAFF,
  STAFF_IDS,
  USERS,
} from '@/lib/reports/__tests__/user-activity.fixture';
import {
  EVENTS_FAILED_TEXT,
  STAFF_INCOMPLETE_TEXT,
  UserActivityReport,
  type UserActivityReportProps,
} from '../UserActivityReport';

const REPORT = buildUserActivityReport({
  users: USERS,
  devices: DEVICES,
  events: EVENTS,
  memberships: MEMBERSHIPS,
  orgs: ORGS,
  staffIds: STAFF_IDS,
});

function html(over: Partial<UserActivityReportProps> = {}) {
  return renderToStaticMarkup(
    <UserActivityReport report={REPORT} period={LAST_WEEK} rowCap={20000} {...over} />
  );
}

const tileValue = (markup: string, id: string) =>
  markup.match(new RegExp(`data-tile-value="${id}"[^>]*>(\\d+)<`))?.[1];

describe('banners', () => {
  it('a failed events read says it is not a true zero (C14)', () => {
    expect(html()).not.toContain('data-banner="events-failed"');
    const markup = html({ eventsFailed: true });
    expect(markup).toContain('data-banner="events-failed"');
    expect(markup).toContain(EVENTS_FAILED_TEXT.split(' — ')[0]);
  });

  it('incomplete staff exclusion is announced, never claimed (C18)', () => {
    expect(html()).not.toContain('data-banner="staff-incomplete"');
    const markup = html({ staffExclusionIncomplete: true });
    expect(markup).toContain('data-banner="staff-incomplete"');
    expect(STAFF_INCOMPLETE_TEXT).toContain('staff may be included');
  });

  it('the truncation notice renders only when truncated (C15)', () => {
    expect(html()).not.toMatch(/at most 20000 events/);
    expect(html({ truncated: true })).toMatch(/at most 20000 events/);
  });
});

describe('cards (C16)', () => {
  it('users active in period equals the fixture count, staff excluded', () => {
    const markup = html();
    expect(tileValue(markup, 'active-users')).toBe('2');
    expect(tileValue(markup, 'created')).toBe('2');
    expect(tileValue(markup, 'submissions')).toBe('1');
    expect(tileValue(markup, 'active-devices')).toBe('3');
  });

  it('prints the definitions under the cards (R7)', () => {
    const markup = html();
    expect(markup).toContain('At least one recorded app event in the period.');
    expect(markup).toContain('Distinct transactions each user created in the period');
  });
});

describe('table', () => {
  it('says latest columns are not period-filtered (C17)', () => {
    expect(html()).toContain(LATEST_ONLY_NOTE);
    expect(LATEST_ONLY_NOTE).toContain('not affected by period');
  });

  it('lists customers, links to the user page, and never lists staff', () => {
    const markup = html();
    expect(markup).toContain(`data-user-row="${ALICE}"`);
    expect(markup).toContain(`data-user-row="${CAROL}"`);
    expect(markup).not.toContain(`data-user-row="${STAFF}"`);
    expect(markup).toContain(`href="/dashboard/users/${ALICE}"`);
    expect(markup).toContain('Transactions edited (distinct)');
  });

  it('shows the orphan footnote', () => {
    expect(html()).toContain('1 event in this period from users no');
  });
});
