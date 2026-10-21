import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar, FilterCaption, filterCaptionText } from './filter-bar';

describe('FilterBar', () => {
  it('hides "Clear filters" while nothing is filtered', () => {
    render(
      <FilterBar hasFilters={false} onClear={() => {}}>
        <span>controls</span>
      </FilterBar>
    );
    expect(screen.getByText('controls')).toBeInTheDocument();
    expect(screen.getByText('Filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('shows it while filtered, and it calls onClear', () => {
    const onClear = jest.fn();
    render(
      <FilterBar hasFilters onClear={onClear} trailing={<span>views</span>}>
        <span>controls</span>
      </FilterBar>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByText('views')).toBeInTheDocument();
  });

  it('takes its own lead and clear labels', () => {
    render(
      <FilterBar hasFilters onClear={() => {}} label="Narrow" clearLabel="Reset">
        <span />
      </FilterBar>
    );
    expect(screen.getByText('Narrow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });
});

describe('FilterCaption', () => {
  const lead = 'Cards, charts and rows follow the filters';
  it.each([
    [[], `${lead}: Last 7 days · no other filters`],
    [['Outcome: Failed'], `${lead}: Last 7 days · Outcome: Failed`],
    [['Outcome: Failed', 'Type: First'], `${lead}: Last 7 days · Outcome: Failed · Type: First`],
    [
      ['Outcome: Failed', 'Type: First', 'Search: "ann"'],
      `${lead}: Last 7 days · Outcome: Failed · Type: First · Search: "ann"`,
    ],
  ])('%j names', (names, expected) => {
    render(<FilterCaption lead={lead} periodLabel="Last 7 days" filterNames={names} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(filterCaptionText({ lead, periodLabel: 'Last 7 days', filterNames: names })).toBe(expected);
  });

  it('takes its own empty text', () => {
    expect(filterCaptionText({ lead: 'L', periodLabel: 'P', filterNames: [], emptyText: 'nothing else' })).toBe(
      'L: P · nothing else'
    );
  });
});
