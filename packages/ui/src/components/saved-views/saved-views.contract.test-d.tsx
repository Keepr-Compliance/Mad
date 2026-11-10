/**
 * BACKLOG-4087 PR 2, control C3: the editor update payload is a narrowed
 * type. Type-checked by `npm run type-check -w @keepr/ui` (tsconfig includes
 * src/**); jest does not run it (`*.test-d.tsx` is outside its testMatch).
 * Each `@ts-expect-error` must still be an error: if SavedViewUpdate is
 * widened so the line compiles, tsc reports TS2578 ("Unused
 * '@ts-expect-error' directive") and the type-check fails.
 */
import { SavedViews } from './saved-views';
import type { SavedViewItem, SavedViewsSharing, SavedViewUpdate } from './types';

interface Filters {
  q: string;
}
interface Metric {
  col: string;
  fn: string;
}
interface View extends SavedViewItem {
  pinned: boolean;
}

const view: View = { id: 'v1', name: 'Pipeline', pinned: false, access: 'editor', ownerName: 'Avery Quinn' };
const noop = () => {};
declare const sharing: SavedViewsSharing<View, Filters, Metric>;

export const updateOk = sharing.onUpdate(view, { filters: { q: 'a' }, metric: { col: 'rows', fn: 'count' } });

// @ts-expect-error an editor update cannot rename the view
export const updateWithName = sharing.onUpdate(view, { filters: { q: 'a' }, metric: { col: 'rows', fn: 'count' }, name: 'x' });

// @ts-expect-error an editor update cannot pin the view
export const updateWithPinned = sharing.onUpdate(view, { filters: { q: 'a' }, metric: { col: 'rows', fn: 'count' }, pinned: true });

// @ts-expect-error an editor update cannot set the default
export const updateWithDefault: SavedViewUpdate<Filters, Metric> = { filters: { q: 'a' }, metric: { col: 'rows', fn: 'count' }, is_default: true };

// A `current()` that returns MORE than filters and metric is not a type error
// (no excess-property check on a function's return), so the runtime half of
// the guard is the component itself: it picks the two fields by name (C2).

// BACKLOG-4142: the editor metric picker is typed by the view and the metric.
export const pickerOk: SavedViewsSharing<View, Filters, Metric> = {
  ...sharing,
  updateMetric: {
    initial: (v) => ({ col: v.name, fn: 'count' }),
    render: (value, onChange) => <button onClick={() => onChange({ col: value.col, fn: 'sum' })}>{value.fn}</button>,
  },
};

export const pickerInitialString: SavedViewsSharing<View, Filters, Metric> = {
  ...sharing,
  updateMetric: {
    // @ts-expect-error initial must return the metric M, not a string
    initial: () => 'rows',
    render: () => null,
  },
};

export const pickerOnChangeString: SavedViewsSharing<View, Filters, Metric> = {
  ...sharing,
  updateMetric: {
    initial: () => ({ col: 'rows', fn: 'count' }),
    // @ts-expect-error the picker hands back an M, not a string
    render: (_value, onChange) => <button onClick={() => onChange('rows')}>x</button>,
  },
};

// @ts-expect-error access is owner | editor | viewer
export const badAccess: View = { id: 'v2', name: 'X', pinned: false, access: 'admin' };

export const panel = (
  <SavedViews<View, Filters, Metric>
    views={[view]}
    loading={false}
    activeViewId={null}
    writeError={null}
    onApply={noop}
    onDelete={noop}
    onSave={noop}
    saveHint="Saves the filters"
    defaultViewId={null}
    onSetDefault={noop}
    sharing={sharing}
  />
);
