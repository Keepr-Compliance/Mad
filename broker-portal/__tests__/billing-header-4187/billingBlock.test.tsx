/**
 * BillingBlock's optional header action — BACKLOG-4187.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { BillingBlock } from '@/components/billing/BillingBlock';

describe('BillingBlock header action', () => {
  it('without an action the markup is exactly what it was before 4187', () => {
    // Transcribed from renderToStaticMarkup on develop 59f8575a5 (before this change).
    expect(renderToStaticMarkup(<BillingBlock id="plan" title="Plan"><p>x</p></BillingBlock>)).toBe(
      '<section aria-labelledby="billing-plan-heading" data-billing-block="plan" class="rounded-lg border border-gray-200 bg-white p-6">' +
        '<h2 id="billing-plan-heading" class="text-lg font-semibold text-gray-900">Plan</h2><p>x</p></section>',
    );
  });

  it('with an action: title and action share a header; under the title below sm, on its right from sm up', () => {
    const html = renderToStaticMarkup(
      <BillingBlock id="seats" title="Seats & licenses" action={<button type="button">Add seats</button>}>
        <p>body</p>
      </BillingBlock>,
    );
    const div = document.createElement('div');
    div.innerHTML = html;
    const section = div.querySelector('section')!;
    const header = section.firstElementChild as HTMLElement;
    expect(header.getAttribute('data-billing-header')).toBe('');
    expect([...header.children].map((c) => c.tagName)).toEqual(['H2', 'DIV']);
    expect(header.children[0].getAttribute('id')).toBe('billing-seats-heading');
    expect(section.getAttribute('aria-labelledby')).toBe('billing-seats-heading');
    expect(header.children[1].querySelector('button')?.textContent).toBe('Add seats');
    const cls = header.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:flex-row', 'sm:items-center', 'sm:justify-between']));
    expect(cls).not.toContain('flex-row');
    expect(header.children[1].className.split(/\s+/)).toContain('shrink-0');
    expect(header.nextElementSibling?.textContent).toBe('body');
  });
});
