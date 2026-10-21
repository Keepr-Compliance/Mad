import { renderHook, act } from '@testing-library/react';
import { nextSort, useSortState, type SortDirection } from './use-sort-state';

type Key = 'when' | 'name';
const def = (k: Key): SortDirection => (k === 'when' ? 'desc' : 'asc');

describe('nextSort', () => {
  it('flips the active column', () => {
    expect(nextSort<Key>({ key: 'when', direction: 'desc' }, 'when', def)).toEqual({ key: 'when', direction: 'asc' });
    expect(nextSort<Key>({ key: 'when', direction: 'asc' }, 'when', def)).toEqual({ key: 'when', direction: 'desc' });
  });

  it("switches to a new column in that column's default direction", () => {
    expect(nextSort<Key>({ key: 'when', direction: 'desc' }, 'name', def)).toEqual({ key: 'name', direction: 'asc' });
    expect(nextSort<Key>({ key: 'name', direction: 'desc' }, 'when', def)).toEqual({ key: 'when', direction: 'desc' });
  });
});

describe('useSortState', () => {
  it("starts at the initial key's default direction unless one is given", () => {
    expect(renderHook(() => useSortState<Key>({ initialKey: 'name', defaultDirectionFor: def })).result.current.sortDirection).toBe('asc');
    expect(
      renderHook(() => useSortState<Key>({ initialKey: 'name', initialDirection: 'desc', defaultDirectionFor: def })).result
        .current.sortDirection
    ).toBe('desc');
  });

  it('onSort applies nextSort; setSort sets both', () => {
    const { result } = renderHook(() => useSortState<Key>({ initialKey: 'when', defaultDirectionFor: def }));
    act(() => result.current.onSort('when'));
    expect(result.current.sortDirection).toBe('asc');
    act(() => result.current.onSort('name'));
    expect([result.current.sortKey, result.current.sortDirection]).toEqual(['name', 'asc']);
    act(() => result.current.setSort({ key: 'when', direction: 'asc' }));
    expect([result.current.sortKey, result.current.sortDirection]).toEqual(['when', 'asc']);
  });
});
