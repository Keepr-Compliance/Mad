/**
 * Report kit — pure sort rule (BACKLOG-3502a). No directive and no React, so a
 * Server Component can call it.
 */
export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/** Pure: the sort after `clicked` is clicked. */
export function nextSort<K extends string>(
  current: SortState<K>,
  clicked: K,
  defaultDirectionFor: (key: K) => SortDirection
): SortState<K> {
  if (clicked === current.key) {
    return { key: clicked, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key: clicked, direction: defaultDirectionFor(clicked) };
}
