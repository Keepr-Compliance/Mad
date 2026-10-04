'use client';

/**
 * SeeMoreList — a list that shows the first N items and hides the rest behind
 * a "See N more" control.
 *
 * Scope note (BACKLOG-3201): introduced for the analytics page's expanded
 * per-version user list, which is unbounded and grows with the user base. It is
 * written to be reusable, but a portal-wide sweep of the other expandable
 * panels is deliberately NOT part of this change.
 *
 * RESET-ON-COLLAPSE: the expanded/collapsed count lives in component state, so
 * it resets when this component unmounts. Callers that hide the list by
 * conditionally rendering it (`{isExpanded && <SeeMoreList … />}`) therefore get
 * the required "collapsing the parent resets it to 5" behaviour for free.
 * A caller that instead keeps it mounted and hides it with CSS would NOT — pass
 * a changing `key` in that case.
 */

import { useState } from 'react';

export const DEFAULT_VISIBLE_COUNT = 5;

/**
 * How many items to render, and how many are hidden.
 *
 * Exported separately from the component so it can be unit-tested: the admin
 * portal has no browser-environment test setup (vitest runs in node and its
 * `include` glob only matches `.test.ts` files), so the component itself
 * cannot be rendered in a test today.
 */
export function visibleSlice<T>(
  items: T[],
  initialCount: number,
  expanded: boolean
): { visible: T[]; hiddenCount: number } {
  const limit = Math.max(0, initialCount);
  if (expanded || items.length <= limit) {
    return { visible: items, hiddenCount: 0 };
  }
  return { visible: items.slice(0, limit), hiddenCount: items.length - limit };
}

interface Props<T> {
  items: T[];
  /** Stable key for each item. */
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** How many to show before "See N more". Defaults to 5. */
  initialCount?: number;
  /** Wrapper classes for the rendered items. */
  className?: string;
}

export function SeeMoreList<T>({
  items,
  getKey,
  renderItem,
  initialCount = DEFAULT_VISIBLE_COUNT,
  className = 'space-y-1',
}: Props<T>) {
  const [expanded, setExpanded] = useState(false);
  const { visible, hiddenCount } = visibleSlice(items, initialCount, expanded);
  const canCollapse = expanded && items.length > Math.max(0, initialCount);

  return (
    <div>
      <div className={className}>
        {visible.map((item) => (
          <div key={getKey(item)}>{renderItem(item)}</div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 px-2 py-1 text-xs font-medium text-primary-700 hover:text-primary-900 hover:underline"
        >
          See {hiddenCount} more
        </button>
      )}

      {canCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 px-2 py-1 text-xs font-medium text-primary-700 hover:text-primary-900 hover:underline"
        >
          Show less
        </button>
      )}
    </div>
  );
}
