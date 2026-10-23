import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SortableTh } from './sortable-th';
import { useSortState, type SortDirection } from './use-sort-state';

type Key = 'when' | 'name' | 'retries';
const NUMERIC: Key[] = ['when', 'retries'];
const defaultDirectionFor = (key: Key): SortDirection => (NUMERIC.includes(key) ? 'desc' : 'asc');
const LABELS: Record<Key, string> = { when: 'When', name: 'Name', retries: 'Retries' };

function Table({ onSortSpy }: { onSortSpy?: (k: Key) => void }) {
  const { sortKey, sortDirection, onSort } = useSortState<Key>({ initialKey: 'when', defaultDirectionFor });
  return (
    <table>
      <thead>
        <tr>
          {(Object.keys(LABELS) as Key[]).map((key) => (
            <SortableTh<Key>
              key={key}
              sortKey={key}
              activeKey={sortKey}
              direction={sortDirection}
              onSort={(k) => {
                onSortSpy?.(k);
                onSort(k);
              }}
              align={key === 'name' ? 'left' : 'right'}
            >
              {LABELS[key]}
            </SortableTh>
          ))}
        </tr>
      </thead>
    </table>
  );
}

const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) });
const sortOf = (name: string) => header(name).getAttribute('aria-sort');
const click = (name: string) => fireEvent.click(within(header(name)).getByRole('button'));

describe('SortableTh', () => {
  it('puts aria-sort on th[scope=col], never on the button; inactive columns read none', () => {
    render(<Table />);
    const th = header('When');
    expect(th.tagName).toBe('TH');
    expect(th).toHaveAttribute('scope', 'col');
    expect(sortOf('When')).toBe('descending');
    expect(sortOf('Name')).toBe('none');
    expect(sortOf('Retries')).toBe('none');
    expect(within(th).getByRole('button')).not.toHaveAttribute('aria-sort');
  });

  it('reports its own key on click', () => {
    const spy = jest.fn();
    render(<Table onSortSpy={spy} />);
    click('Retries');
    expect(spy).toHaveBeenCalledWith('retries');
  });

  it('opens a NUMERIC column descending and flips it on the second click', () => {
    render(<Table />);
    click('Retries');
    expect(sortOf('Retries')).toBe('descending');
    expect(sortOf('When')).toBe('none');
    click('Retries');
    expect(sortOf('Retries')).toBe('ascending');
  });

  it('opens a TEXT column ascending even when the previous column was descending', () => {
    render(<Table />);
    click('Retries'); // desc
    click('Name');
    expect(sortOf('Name')).toBe('ascending');
    click('Name');
    expect(sortOf('Name')).toBe('descending');
  });

  it('a column re-entered after another opens at ITS default, not its old direction', () => {
    render(<Table />);
    click('Retries');
    click('Retries'); // asc
    click('Name');
    click('Retries');
    expect(sortOf('Retries')).toBe('descending');
  });

  it('aligns right when asked', () => {
    render(<Table />);
    expect(header('Retries').className).toContain('text-right');
    expect(header('Name').className).toContain('text-left');
  });
});
