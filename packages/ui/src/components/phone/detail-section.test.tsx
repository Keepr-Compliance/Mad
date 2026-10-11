import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailSection, DetailRow } from './detail-section';

describe('DetailSection / DetailRow', () => {
  it('section is named by its title; plain rows are not interactive', () => {
    const { container } = render(
      <DetailSection title="Ticket">
        <DetailRow label="Status" value="Open" />
      </DetailSection>
    );
    expect(screen.getByRole('region', { name: 'Ticket' })).toBeInTheDocument();
    expect(container.querySelectorAll('a, button')).toHaveLength(0);
  });

  it('a row with onClick is a 48px button', async () => {
    const onClick = jest.fn();
    render(<DetailRow label="Assignee" value="Sam" onClick={onClick} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveClass('min-h-12');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a row with href is a link', () => {
    render(<DetailRow label="Plan" value="Pro" href="/plans/pro" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/plans/pro');
  });
});
