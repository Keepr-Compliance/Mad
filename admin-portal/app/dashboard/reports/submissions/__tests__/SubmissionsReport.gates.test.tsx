// @vitest-environment jsdom

/**
 * Submissions report — truncation notice and critical tile (BACKLOG-3502a R11)
 *
 * Written against the pre-kit Submissions code and kept unchanged when the
 * report moved onto the @keepr/ui report kit, so the move is checked by tests
 * that existed before it. Asserts only on text and classes both versions emit.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
  RUNNING,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';

const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

function mount({ truncated = false, openRows = OPEN_ROWS } = {}) {
  return render(
    <SubmissionsReport
      report={buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
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
