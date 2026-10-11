import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { ListCard } from './list-card';
import { StatusPill } from './status-pill';

describe('ListCard', () => {
  it('a linked card is exactly one interactive element, named by its title', () => {
    const { container } = render(
      <ListCard href="/t/1" meta={<StatusPill hue="yellow">Testing</StatusPill>} title="Printer is on fire" secondary="2h ago" />
    );
    expect(container.querySelectorAll('a, button')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Printer is on fire' })).toHaveAttribute('href', '/t/1');
  });

  it('a clickable card is one button', () => {
    const { container } = render(<ListCard onClick={() => {}} title="Plan A" meta="Draft" />);
    expect(container.querySelectorAll('a, button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Plan A' })).toBeInTheDocument();
  });

  it('title clamps to two lines', () => {
    render(<ListCard href="/t/1" title="Long title" />);
    expect(screen.getByText('Long title')).toHaveClass('line-clamp-2');
  });
});
