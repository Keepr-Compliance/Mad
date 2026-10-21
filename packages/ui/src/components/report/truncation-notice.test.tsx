import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { TruncationNotice } from './truncation-notice';

describe('TruncationNotice', () => {
  it('names the cap, the period and the scope, and says floor-not-total', () => {
    const { container } = render(
      <TruncationNotice
        noun="attempts"
        capPhrase="at most 487 rows"
        periodLabel="Last 30 days"
        scope="every count and chart"
      />
    );
    const notice = container.querySelector('[data-notice="truncated"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(screen.getByText('This period holds more attempts than are shown.')).toBeInTheDocument();
    expect(notice.textContent).toContain('The query returns at most 487 rows and last 30 days reached that cap');
    expect(notice.textContent).toContain('every count and chart on this page is therefore a floor, not a total.');
    expect(notice.textContent).toContain('Narrow the period to see all of it.');
  });
});
