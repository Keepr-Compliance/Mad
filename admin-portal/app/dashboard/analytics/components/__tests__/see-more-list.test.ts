/**
 * SeeMoreList slice logic (BACKLOG-3201).
 *
 * The component itself is not rendered here: the admin portal has no
 * browser-environment test setup (vitest runs in node with no jsdom
 * environment, `@vitejs/plugin-react` is not an admin-portal dependency, and
 * the vitest `include` glob only matches `.test.ts`). The slice rule — first 5,
 * then N more, expanded shows all — is exported as a pure function precisely so
 * it can be pinned without that setup.
 *
 * Reset-on-collapse is NOT covered here. It is a property of unmounting: the
 * analytics version row renders the list inside `{isExpanded && …}`, so React
 * discards the state. See the note in SeeMoreList.tsx.
 */

import { describe, it, expect } from 'vitest';
import { visibleSlice, DEFAULT_VISIBLE_COUNT } from '../SeeMoreList';

const items = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`);

describe('visibleSlice', () => {
  it('defaults to five visible', () => {
    expect(DEFAULT_VISIBLE_COUNT).toBe(5);
  });

  it('shows the first N and reports the remainder when collapsed', () => {
    const { visible, hiddenCount } = visibleSlice(items, 5, false);
    expect(visible).toEqual(['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
    expect(hiddenCount).toBe(7);
  });

  it('shows everything and hides nothing when expanded', () => {
    const { visible, hiddenCount } = visibleSlice(items, 5, true);
    expect(visible).toEqual(items);
    expect(hiddenCount).toBe(0);
  });

  it('offers no "see more" when the list already fits', () => {
    const short = items.slice(0, 5);
    expect(visibleSlice(short, 5, false)).toEqual({ visible: short, hiddenCount: 0 });
  });

  it('offers "see 1 more" at exactly one over the limit', () => {
    const six = items.slice(0, 6);
    const { visible, hiddenCount } = visibleSlice(six, 5, false);
    expect(visible).toHaveLength(5);
    expect(hiddenCount).toBe(1);
  });

  it('handles an empty list', () => {
    expect(visibleSlice([], 5, false)).toEqual({ visible: [], hiddenCount: 0 });
  });

  it('never reports a negative hidden count', () => {
    expect(visibleSlice(items, -3, false).hiddenCount).toBe(items.length);
    expect(visibleSlice(items, -3, false).visible).toEqual([]);
  });
});
