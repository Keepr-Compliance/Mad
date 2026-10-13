import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhoneFilterBar, PhoneResultsRow, PhoneClearFilters, PhoneSortButton } from './filter-bar';

const filters = [
  { label: 'Role', value: 'All Roles', onClick: () => {} },
  { label: 'Status', value: 'Active', active: true, onClick: () => {} },
] as const;

describe('PhoneFilterBar', () => {
  it('renders the search, then both filters side by side in a 2-column grid', () => {
    render(<PhoneFilterBar search={{ label: 'Search', value: '', onChange: () => {} }} filters={filters} />);
    const a = screen.getByRole('button', { name: 'Role: All Roles' });
    const b = screen.getByRole('button', { name: 'Status: Active' });
    expect(a.parentElement).toBe(b.parentElement);
    expect(a.parentElement!.className).toContain('grid-cols-2');
    expect(screen.getByRole('search')).toContainElement(screen.getByLabelText('Search'));
  });

  it('shows the X only with onClear and text, and calls onClear', () => {
    const onClear = jest.fn();
    const { rerender } = render(<PhoneFilterBar search={{ label: 'Search', value: 'a', onChange: () => {} }} filters={filters} />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    rerender(<PhoneFilterBar search={{ label: 'Search', value: 'a', onChange: () => {}, onClear }} filters={filters} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('submits via onSubmit, renders results under the grid and children after', () => {
    const onSubmit = jest.fn();
    render(
      <PhoneFilterBar
        search={{ label: 'Search', value: 'a', onChange: () => {}, onSubmit }}
        filters={filters}
        results={<PhoneResultsRow shown={1} total={2} noun="user" />}
      >
        <i data-testid="sheet" />
      </PhoneFilterBar>
    );
    fireEvent.submit(screen.getByRole('search'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const grid = screen.getByRole('button', { name: 'Role: All Roles' }).parentElement!;
    const row = document.querySelector('[data-slot=phone-results-row]')!;
    expect(grid.nextElementSibling).toBe(row);
    expect(row.nextElementSibling).toBe(screen.getByTestId('sheet'));
  });
});

describe('PhoneResultsRow', () => {
  it('says "Showing X of Y <noun>s", pluralised by Y, in a 44px row', () => {
    const { container, rerender } = render(<PhoneResultsRow shown={2} total={5} noun="user" />);
    expect(container.firstElementChild).toHaveTextContent('Showing 2 of 5 users');
    expect(container.firstElementChild!.className).toContain('h-11');
    rerender(<PhoneResultsRow shown={1} total={5} noun="user" />);
    expect(container.firstElementChild).toHaveTextContent('Showing 1 of 5 users');
    rerender(<PhoneResultsRow shown={1} total={1} noun="submission" />);
    expect(container.firstElementChild).toHaveTextContent('Showing 1 of 1 submission');
    expect(container.firstElementChild).not.toHaveTextContent('submissions');
  });

  it('renders the right-hand slot only when given', () => {
    const { container, rerender } = render(<PhoneResultsRow shown={0} total={0} noun="user" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    rerender(<PhoneResultsRow shown={0} total={0} noun="user" action={<button>Go</button>} />);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('PhoneClearFilters', () => {
  it('is a 44px tap target that calls onClick', () => {
    const onClick = jest.fn();
    render(<PhoneClearFilters onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Clear filters' });
    expect(btn.className).toContain('min-h-11');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('PhoneFilterBar trailing slot', () => {
  it('without trailing, the grid is exactly two columns', () => {
    render(<PhoneFilterBar search={{ label: 'Search', value: '', onChange: () => {} }} filters={filters} />);
    const grid = screen.getByRole('button', { name: 'Role: All Roles' }).parentElement!;
    expect(grid.className).toBe('mt-2 grid grid-cols-2 gap-2');
    expect(grid.children).toHaveLength(2);
  });

  it('with trailing, the square sits third on the same grid row', () => {
    render(
      <PhoneFilterBar
        search={{ label: 'Search', value: '', onChange: () => {} }}
        filters={filters}
        trailing={<PhoneSortButton label="Sort: Newest first" onClick={() => {}} />}
      />
    );
    const grid = screen.getByRole('button', { name: 'Role: All Roles' }).parentElement!;
    expect(grid.className).toContain('2.75rem');
    expect(grid.children).toHaveLength(3);
    expect(grid.children[2]).toBe(screen.getByRole('button', { name: 'Sort: Newest first' }));
  });
});

describe('PhoneSortButton', () => {
  it('is a 44px square, highlighted only when active, and clicks', () => {
    const onClick = jest.fn();
    const { rerender } = render(<PhoneSortButton label="Sort: Newest first" onClick={onClick} />);
    const b = screen.getByRole('button', { name: 'Sort: Newest first' });
    expect(b.className).toContain('h-11');
    expect(b.className).toContain('w-11');
    expect(b).not.toHaveAttribute('data-active');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<PhoneSortButton label="Sort: Oldest first" onClick={onClick} active />);
    expect(screen.getByRole('button', { name: 'Sort: Oldest first' })).toHaveAttribute('data-active', 'true');
  });
});
