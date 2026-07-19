import { describe, it, expect } from 'vitest';
import {
  computeFunnel,
  FUNNEL_STEP_EVENTS,
  type FunnelEventRow,
} from './funnel-analytics';

function row(event_name: string, user_id: string | null): FunnelEventRow {
  return { event_name, user_id };
}

describe('computeFunnel', () => {
  it('returns four ordered steps, all zero, for empty input', () => {
    const result = computeFunnel([]);
    expect(result.steps.map((s) => s.event)).toEqual([...FUNNEL_STEP_EVENTS]);
    expect(result.topCount).toBe(0);
    for (const step of result.steps) {
      expect(step.userCount).toBe(0);
    }
    // First step is 100% by definition; downstream steps are 0% when the
    // previous/top step is empty.
    expect(result.steps[0].conversionFromPrev).toBe(100);
    expect(result.steps[0].conversionFromTop).toBe(100);
    expect(result.steps[1].conversionFromPrev).toBe(0);
    expect(result.steps[3].conversionFromTop).toBe(0);
  });

  it('counts DISTINCT users per step (repeat events do not inflate)', () => {
    const rows: FunnelEventRow[] = [
      row('paywall-viewed', 'u1'),
      row('paywall-viewed', 'u1'), // repeat — still one user
      row('paywall-viewed', 'u1'),
      row('paywall-viewed', 'u2'),
    ];
    const result = computeFunnel(rows);
    expect(result.steps[0].userCount).toBe(2);
    expect(result.topCount).toBe(2);
  });

  it('ignores rows with a null user_id', () => {
    const rows: FunnelEventRow[] = [
      row('paywall-viewed', 'u1'),
      row('paywall-viewed', null),
      row('unlock-clicked', null),
    ];
    const result = computeFunnel(rows);
    expect(result.steps[0].userCount).toBe(1); // only u1
    expect(result.steps[1].userCount).toBe(0);
  });

  it('ignores non-funnel event names', () => {
    const rows: FunnelEventRow[] = [
      row('paywall-viewed', 'u1'),
      row('app-opened', 'u1'), // not a funnel step
      row('some-other-event', 'u2'),
    ];
    const result = computeFunnel(rows);
    expect(result.steps[0].userCount).toBe(1);
    expect(result.steps[1].userCount).toBe(0);
    expect(result.steps[2].userCount).toBe(0);
    expect(result.steps[3].userCount).toBe(0);
  });

  it('computes a realistic multi-user funnel with correct conversions', () => {
    // 4 viewers; 3 click unlock; 2 pay; 2 export.
    const rows: FunnelEventRow[] = [
      // paywall-viewed: u1, u2, u3, u4
      row('paywall-viewed', 'u1'),
      row('paywall-viewed', 'u2'),
      row('paywall-viewed', 'u3'),
      row('paywall-viewed', 'u4'),
      // unlock-clicked: u1, u2, u3 (u4 bounced at price)
      row('unlock-clicked', 'u1'),
      row('unlock-clicked', 'u2'),
      row('unlock-clicked', 'u3'),
      // payment-succeeded: u1, u2 (u3 abandoned checkout)
      row('payment-succeeded', 'u1'),
      row('payment-succeeded', 'u2'),
      // export-completed: u1, u2
      row('export-completed', 'u1'),
      row('export-completed', 'u2'),
    ];

    const result = computeFunnel(rows);
    const [viewed, clicked, paid, exported] = result.steps;

    expect(result.topCount).toBe(4);

    expect(viewed.userCount).toBe(4);
    expect(viewed.conversionFromPrev).toBe(100);
    expect(viewed.conversionFromTop).toBe(100);

    expect(clicked.userCount).toBe(3);
    expect(clicked.conversionFromPrev).toBe(75); // 3/4
    expect(clicked.conversionFromTop).toBe(75); // 3/4
    expect(clicked.exceedsPrevious).toBe(false);

    expect(paid.userCount).toBe(2);
    expect(paid.conversionFromPrev).toBeCloseTo(66.7, 1); // 2/3
    expect(paid.conversionFromTop).toBe(50); // 2/4

    expect(exported.userCount).toBe(2);
    expect(exported.conversionFromPrev).toBe(100); // 2/2
    expect(exported.conversionFromTop).toBe(50); // 2/4
    expect(exported.barPct).toBe(100);
  });

  it('handles the >100% edge case (more exports than the previous step)', () => {
    // A legacy/free-unlock user exports without ever clicking unlock, so
    // export-completed has MORE distinct users than payment-succeeded.
    const rows: FunnelEventRow[] = [
      row('paywall-viewed', 'u1'),
      row('paywall-viewed', 'u2'),
      row('unlock-clicked', 'u1'),
      row('payment-succeeded', 'u1'),
      // Two users export: u1 (paid) and u3 (legacy unlock, never in funnel above).
      row('export-completed', 'u1'),
      row('export-completed', 'u3'),
    ];

    const result = computeFunnel(rows);
    const paid = result.steps[2];
    const exported = result.steps[3];

    expect(paid.userCount).toBe(1);
    expect(exported.userCount).toBe(2);

    // Raw conversion exceeds 100% (2/1 = 200%) and is reported honestly.
    expect(exported.conversionFromPrev).toBe(200);
    expect(exported.exceedsPrevious).toBe(true);

    // But the render bar is clamped to 100 so the chart stays sane.
    expect(exported.barPct).toBe(100);

    // conversionFromTop can also exceed 100 if a downstream step has more
    // distinct users than the top step. Here top=2, exported=2 -> exactly 100.
    expect(exported.conversionFromTop).toBe(100);
  });

  it('reports 0% downstream conversion when the top step is empty but later steps fire', () => {
    // No paywall-viewed events, but a payment slipped through (data anomaly).
    const rows: FunnelEventRow[] = [row('payment-succeeded', 'u1')];
    const result = computeFunnel(rows);

    expect(result.topCount).toBe(0);
    // conversionFromTop divides by an empty top -> 0, not NaN/Infinity.
    expect(result.steps[2].conversionFromTop).toBe(0);
    // conversionFromPrev also divides by an empty previous step -> 0.
    expect(result.steps[2].conversionFromPrev).toBe(0);
    expect(Number.isFinite(result.steps[2].conversionFromTop)).toBe(true);
  });
});
