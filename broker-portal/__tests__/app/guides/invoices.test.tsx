/**
 * Public help article "Where do I find my invoices?" — BACKLOG-3855.
 * Public route (outside /dashboard), served by the App Router, no breadcrumb back to /help.
 */

import { render } from '@testing-library/react';
import InvoicesGuidePage from '@/app/guides/invoices/page';
import { readSource, renderedHrefs, resolveRoute } from '../../helpers/appRoutes';

describe('/guides/invoices', () => {
  it('is served by a route file and is outside the protected /dashboard prefix', () => {
    expect(resolveRoute('/guides/invoices')).not.toBeNull();
    const prefixes = [...readSource('middleware.ts').matchAll(/pathname\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
    expect(prefixes).toContain('/dashboard');
    for (const p of prefixes) expect('/guides/invoices'.startsWith(p)).toBe(false);
  });

  it('title and the three audiences; no links (no breadcrumb)', () => {
    const { container } = render(<InvoicesGuidePage />);
    expect(container.querySelector('h1')?.textContent).toBe('Where do I find my invoices?');
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'If you pay Keepr yourself',
      'Brokerage Broker, Admin or billing contact',
      'Brokerage agents and IT admins',
    ]);
    expect(renderedHrefs(container)).toEqual([]);
  });
});
