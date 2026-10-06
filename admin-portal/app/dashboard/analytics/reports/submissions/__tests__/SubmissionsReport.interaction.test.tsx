// @vitest-environment jsdom

/**
 * Submissions report — interaction tests (BACKLOG-3715)
 *
 * Filters, sort and the row detail cannot be reached by a static render.
 * Keep the environment pragma on line 1 only; do not repeat it in prose.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
  REFUSED,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';

const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

function mount() {
  return render(
    <SubmissionsReport
      report={buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openAttempts={buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openCap={200}
      period={THIS_WEEK}
      rowCap={500}
    />
  );
}

const rowIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-submission-row]')].map((el) => el.getAttribute('data-submission-row'));
const tile = (c: HTMLElement, id: string) => c.querySelector(`[data-tile-value="${id}"]`)?.textContent;
const attemptBarTotal = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-chart="attempts"] path[data-value]')].reduce(
    (sum, el) => sum + Number(el.getAttribute('data-value')),
    0
  );

describe('an Outcome filter moves tiles, charts and table together (C11)', () => {
  it('narrows all three to Failed', () => {
    const { container } = mount();
    expect(tile(container, 'attempts')).toBe('10');
    expect(attemptBarTotal(container)).toBe(10);
    expect(rowIds(container)).toHaveLength(10);

    // The filter-bar trigger comes first; the table's sort header is also "Outcome".
    fireEvent.click(screen.getAllByRole('button', { name: /^Outcome/ })[0]);
    fireEvent.click(screen.getByText('Failed', { selector: 'label span' }));

    // FAILED, REFUSED, UNKNOWN_CODES carry status "failed".
    expect(rowIds(container)).toHaveLength(3);
    expect(tile(container, 'attempts')).toBe('3');
    expect(tile(container, 'committed')).toBe('0');
    expect(attemptBarTotal(container)).toBe(3);
    // The Stalled-now tile reads the open set and does not follow filters.
    expect(tile(container, 'stalled-now')).toBe('2');
  });
});

describe('row detail (C12)', () => {
  it('opens the card on click and lists refusal counts humanised', () => {
    const { container } = mount();
    const tr = container.querySelector(`[data-submission-row="${REFUSED.submission_id}"]`)!;
    fireEvent.click(tr);
    const detail = container.querySelector(`[data-submission-detail="${REFUSED.submission_id}"]`)!;
    expect(detail).toBeTruthy();
    expect(detail.textContent).toContain('Files missing on the server');
    expect(detail.textContent).toContain('Messages missing on the server');
    expect(detail.textContent).toContain('Server refused to finalize');
    expect(detail.textContent).not.toContain('refusal_objects_missing');
  });
});

describe('sort', () => {
  it('sorts by Retries descending on first click', () => {
    const { container } = mount();
    // The last thead is the attempts table; the first is the open-attempts panel.
    const head = [...container.querySelectorAll('thead')].at(-1)!;
    const btn = [...head.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Retries'))!;
    fireEvent.click(btn);
    expect(rowIds(container)[0]).toBe(PERIOD_ROWS.find((r) => r.retry_count === 2)!.submission_id);
  });
});
