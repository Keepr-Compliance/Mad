import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state';
import { Button } from './button';

describe('EmptyState', () => {
  it('renders title, description, icon, and action', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No transactions"
        description="You have not created any transactions yet."
        action={<Button>Create one</Button>}
      />
    );

    expect(screen.getByText('No transactions')).toBeInTheDocument();
    expect(
      screen.getByText('You have not created any transactions yet.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create one' })
    ).toBeInTheDocument();
  });

  it('renders card chrome by default and drops it when card={false}', () => {
    const { rerender } = render(
      <EmptyState data-testid="empty" title="Empty" />
    );
    expect(screen.getByTestId('empty')).toHaveClass('border');

    rerender(<EmptyState data-testid="empty" title="Empty" card={false} />);
    expect(screen.getByTestId('empty')).not.toHaveClass('border');
  });
});
