import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterSelectButton } from './filter-select-button';

describe('FilterSelectButton', () => {
  it('shows the label and the value, and says both in its accessible name', () => {
    render(<FilterSelectButton label="Status" value="Pending" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Status: Pending' });
    expect(btn).toHaveTextContent('Status');
    expect(btn).toHaveTextContent('Pending');
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveClass('min-h-11');
  });

  it('reports expanded and active, and calls onClick', async () => {
    const onClick = jest.fn();
    render(<FilterSelectButton label="Agent" value="All agents" onClick={onClick} expanded active />);
    const btn = screen.getByRole('button', { name: 'Agent: All agents' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAttribute('data-active', 'true');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is not marked active by default', () => {
    render(<FilterSelectButton label="Agent" value="All agents" onClick={() => {}} />);
    expect(screen.getByRole('button')).not.toHaveAttribute('data-active');
  });
});
