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

describe('SearchField onClear (BACKLOG-3904)', () => {
  it('shows no X when onClear is not passed, and the native cancel button stays', () => {
    render(<SearchField label="Search" value="abc" onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    expect(screen.getByRole('searchbox').className).not.toMatch(/webkit-search-cancel-button/);
  });

  it('shows the X only while the field has text', () => {
    const { rerender } = render(<SearchField label="Search" value="" onChange={() => {}} onClear={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    rerender(<SearchField label="Search" value="a" onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('is a 44px tap target, hides the native cancel button and keeps the input at 16px', () => {
    render(<SearchField label="Search" value="a" onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole('button', { name: 'Clear search' })).toHaveClass('h-11', 'w-11');
    const input = screen.getByRole('searchbox');
    expect(input).toHaveClass('text-base', 'pr-11');
    expect(input.className).toMatch(/\[&::-webkit-search-cancel-button\]:hidden/);
  });

  it('calls onClear and returns focus to the input', async () => {
    const onClear = jest.fn();
    render(<SearchField label="Search" value="a" onChange={() => {}} onClear={onClear} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('searchbox')).toHaveFocus();
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
