import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchField, FilterButton } from './search-field';

describe('SearchField', () => {
  it('is a labelled 16px search input at every width (no text-sm)', async () => {
    const onChange = jest.fn();
    render(<SearchField label="Search tickets" value="" onChange={onChange} />);
    const input = screen.getByRole('searchbox', { name: 'Search tickets' });
    expect(input).toHaveClass('text-base', 'h-11');
    expect(input.className).not.toMatch(/\btext-sm\b|md:text-sm/);
    await userEvent.type(input, 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });
});

describe('FilterButton', () => {
  it('hides the badge at 0', () => {
    const { container } = render(<FilterButton count={0} onClick={() => {}} />);
    expect(container.querySelector('[data-slot="filter-count"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('shows the count and says it in the accessible name', () => {
    render(<FilterButton count={2} onClick={() => {}} expanded />);
    const btn = screen.getByRole('button', { name: 'Filters, 2 active' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveTextContent('2');
  });
});
