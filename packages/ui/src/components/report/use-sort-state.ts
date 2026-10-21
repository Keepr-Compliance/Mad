'use client';

import * as React from 'react';
import { nextSort } from './sort';
import type { SortDirection, SortState } from './sort';

export type { SortDirection, SortState };

/**
 * Report kit — column sort state (BACKLOG-3502a).
 *
 * One rule, copied from the admin reports: clicking the active column flips
 * its direction; clicking another column switches to it in THAT column's
 * default direction (numbers open descending, text ascending). The wrong
 * implementation that looks right flips on every click, so a new column
 * inherits whatever direction the last one had.
 */
export interface UseSortStateOptions<K extends string> {
  initialKey: K;
  /** Defaults to `defaultDirectionFor(initialKey)`. */
  initialDirection?: SortDirection;
  defaultDirectionFor: (key: K) => SortDirection;
}

export interface UseSortStateResult<K extends string> {
  sortKey: K;
  sortDirection: SortDirection;
  /** Pass to SortableTh `onSort`. */
  onSort: (key: K) => void;
  /** Set both at once (restoring a saved view or a URL). */
  setSort: (next: SortState<K>) => void;
}

export function useSortState<K extends string>({
  initialKey,
  initialDirection,
  defaultDirectionFor,
}: UseSortStateOptions<K>): UseSortStateResult<K> {
  const [sort, setSort] = React.useState<SortState<K>>(() => ({
    key: initialKey,
    direction: initialDirection ?? defaultDirectionFor(initialKey),
  }));

  const onSort = React.useCallback(
    (key: K) => setSort((current) => nextSort(current, key, defaultDirectionFor)),
    [defaultDirectionFor]
  );

  return { sortKey: sort.key, sortDirection: sort.direction, onSort, setSort };
}
