// @vitest-environment jsdom

/**
 * Submissions report — truncation notice and critical tile (BACKLOG-3502a R11)
 *
 * Written against the pre-kit Submissions code and kept unchanged when the
 * report moved onto the @keepr/ui report kit, so the move is checked by tests
 * that existed before it. Asserts only on text and classes both versions emit.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  minutesAgo,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
  RUNNING,
  row,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';

const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

function mount({ truncated = false, openRows = OPEN_ROWS, periodRows = PERIOD_ROWS } = {}) {
  return render(
    <SubmissionsReport
      report={buildSubmissionsReport(periodRows, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openAttempts={buildOpenAttempts(openRows, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openCap={200}
      period={THIS_WEEK}
      truncated={truncated}
      // The cap differs from the 10 rows on screen, so the notice must name the CAP.
      rowCap={500}
    />
  );
}

const tileValue = (c: HTMLElement, id: string) => c.querySelector(`[data-tile-value="${id}"]`)!;

describe('truncation notice (R11, N5)', () => {
  it('names the cap and says the numbers are a floor when the query was capped', () => {
    const { container } = mount({ truncated: true });
    const text = container.textContent ?? '';
    expect(text).toContain('This period holds more attempts than are shown.');
    expect(text).toContain('at most 500 rows');
    expect(text).toContain(`${THIS_WEEK.label.toLowerCase()} reached that cap`);
    expect(text).toContain('a floor, not a total');
  });

  it('is absent when the query was not capped', () => {
    const { container } = mount({ truncated: false });
    expect(container.textContent).not.toContain('reached that cap');
    expect(container.textContent).not.toContain('a floor, not a total');
  });
});

describe('critical tile (R11, N1b)', () => {
  it('turns "Stalled now" red when it is above zero', () => {
    const { container } = mount();
    const value = tileValue(container, 'stalled-now');
    expect(value.textContent).toBe('2');
    expect(value.className).toContain('text-red-700');
  });

  it('keeps "Stalled now" out of red at zero — no stalled attempts is good news', () => {
    const { container } = mount({ openRows: [RUNNING] });
    const value = tileValue(container, 'stalled-now');
    expect(value.textContent).toBe('0');
    expect(value.className).not.toContain('text-red-700');
  });

  it('never turns a non-critical tile red, whatever its value', () => {
    const { container } = mount();
    const value = tileValue(container, 'attempts');
    expect(value.textContent).toBe('10');
    expect(value.className).not.toContain('text-red-700');
  });
});

// 23 rows: the 10 fixture rows plus 13 older copies with distinct ids. The
// copies start before every original, so the newest row stays RUNNING.
const MANY_ROWS = [
  ...PERIOD_ROWS,
  ...Array.from({ length: 13 }, (_, i) =>
    row(100 + i, { started_at: minutesAgo(60 * 100 + i), updated_at: minutesAgo(60 * 100 + i) })
  ),
];

const rowCount = (c: HTMLElement) => c.querySelectorAll('[data-submission-row]').length;
// Matches "Show more" (pre-kit) and "Show 10 more" / "Show 3 more"; not "Show all".
const showMore = () => screen.getByRole('button', { name: /^Show( \d+)? more$/ });

describe('show more steps through the rows (R-a)', () => {
  it('(i) shows 10, then 20, then all 23 as Show more is clicked', () => {
    const { container } = mount({ periodRows: MANY_ROWS });
    expect(rowCount(container)).toBe(10);
    expect(container.textContent).toContain('Showing 10 of 23 attempts');
    fireEvent.click(showMore());
    expect(rowCount(container)).toBe(20);
    expect(container.textContent).toContain('Showing 20 of 23 attempts');
    fireEvent.click(showMore());
    expect(rowCount(container)).toBe(23);
    expect(container.textContent).toContain('Showing 23 of 23 attempts');
  });

  it('(ii) labels the button with what the click adds: Show 10 more, then Show 3 more', () => {
    mount({ periodRows: MANY_ROWS });
    expect(showMore().textContent).toBe('Show 10 more');
    fireEvent.click(showMore());
    expect(showMore().textContent).toBe('Show 3 more');
  });
});

describe('initial sort (R-b)', () => {
  it('opens newest-first: first row is the newest start and Started reads descending', () => {
    const { container } = mount();
    const first = container.querySelector('[data-submission-row]')!;
    expect(first.getAttribute('data-submission-row')).toBe(RUNNING.submission_id);
    // The open-attempts panel has its own plain "Started" header; the sortable
    // one is the header of the attempts table, the one that carries aria-sort.
    const sortable = container.querySelector('th[aria-sort]:not([aria-sort="none"])')!;
    expect(sortable.textContent).toContain('Started');
    expect(sortable.getAttribute('aria-sort')).toBe('descending');
    expect(container.querySelectorAll('th[aria-sort]:not([aria-sort="none"])').length).toBe(1);
  });
});

describe('filter bulk actions (founder decision)', () => {
  it('Select all checks every Outcome option and Clear all unchecks them', () => {
    mount();
    // The filter-bar trigger comes first; the table's sort header is also "Outcome".
    fireEvent.click(screen.getAllByRole('button', { name: /^Outcome/ })[0]);
    const group = screen.getByRole('group', { name: /outcome/i });
    const boxes = () => within(group).getAllByRole('checkbox');
    expect(boxes().length).toBeGreaterThan(1);
    expect(boxes().every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true);

    fireEvent.click(screen.getByText('Select all'));
    expect(boxes().every((b) => b.getAttribute('aria-checked') === 'true')).toBe(true);

    fireEvent.click(screen.getByText('Clear all'));
    expect(boxes().every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true);
  });
});
