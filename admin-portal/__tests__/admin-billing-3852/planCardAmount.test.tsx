/** BACKLOG-3852: the Plan card renders the price line only when one is passed. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '@/app/dashboard/users/[id]/components/PlanCard';

const LINE = { kind: 'brokerage' as const, text: 'Team plan', test: false, warning: null };

describe('PlanCard amount', () => {
  it('shows the price line under the plan line', () => {
    const html = renderToStaticMarkup(<PlanCard line={LINE} amount="$24.99 per seat / month · next invoice Nov 19, 2026" />);
    expect(html).toContain('$24.99 per seat / month · next invoice Nov 19, 2026');
  });
  it('without an amount: no price, no currency sign', () => {
    const html = renderToStaticMarkup(<PlanCard line={LINE} />);
    expect(html).not.toContain('plan-amount');
    expect(html).not.toMatch(/[$€£]/);
  });
});
