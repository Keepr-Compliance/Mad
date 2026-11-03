// @vitest-environment jsdom
/**
 * User Activity report — cards follow the filters (BACKLOG-3720, F2)
 *
 * The static-markup suite cannot apply a filter. This one types into the search box and
 * reads the cards back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildUserActivityReport } from '@/lib/reports/user-activity';
import {
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  ORGS,
  STAFF_IDS,
  USERS,
} from '@/lib/reports/__tests__/user-activity.fixture';
import { UserActivityReport } from '../UserActivityReport';

const REPORT = buildUserActivityReport({
  users: USERS,
  devices: DEVICES,
  events: EVENTS,
  memberships: MEMBERSHIPS,
  orgs: ORGS,
  staffIds: STAFF_IDS,
});

afterEach(cleanup);

const tile = (id: string) => document.querySelector(`[data-tile-value="${id}"]`)?.textContent;
const cards = () => [tile('active-users'), tile('created'), tile('submissions'), tile('active-devices')];

describe('cards are built from the FILTERED rows (F2)', () => {
  it('searching for one user changes every card to that user\'s values', () => {
    render(<UserActivityReport report={REPORT} period={LAST_WEEK} rowCap={20000} />);
    // Unfiltered: active users, created, submissions, active devices.
    expect(cards()).toEqual(['2', '2', '1', '3']);

    // Bob: 1 active user, 0 created, 0 submissions, 1 active device.
    fireEvent.change(screen.getByLabelText('Search by name or email'), { target: { value: 'bob' } });
    expect(cards()).toEqual(['1', '0', '0', '1']);
  });
});
