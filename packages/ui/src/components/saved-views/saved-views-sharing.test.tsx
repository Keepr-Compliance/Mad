import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SavedViews } from './saved-views';
import { ShareDialog as ShareDialogFromIndex, SavedViews as SavedViewsFromIndex } from '../../index';
import { ShareDialog } from './share-dialog';
import type { SavedViewItem, SavedViewsProps, SavedViewsSharing, SavedViewUpdate } from './types';

/**
 * BACKLOG-4087 PR 2 (kit). Control ids C1-C9 match the implementation comment.
 *
 * Fixture rules (invented names and ids only):
 * - A shared row is listed BEFORE an own row in the input, so the
 *   own-first order is visible (C9).
 * - Shared rows are pinned and one of them is the defaultViewId, so a
 *   pin count or Default marker that includes shared rows shows (C5, C1).
 * - One editor and one viewer row, so a gate on `access === 'viewer'`
 *   (instead of "not owner") shows on the editor row (C1b).
 */
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

const LONG_OWNER = 'Bartholomew Featherstonehaugh-Montgomery the Third';

const MIXED: View[] = [
  { id: 's-ed', name: 'Budget', pinned: true, access: 'editor', ownerName: 'Avery Quinn' },
  { id: 'v1', name: 'Pipeline', pinned: true },
  { id: 's-vw', name: 'Backlog', pinned: true, access: 'viewer', ownerName: LONG_OWNER },
  { id: 'v2', name: 'Stalled', pinned: false, access: 'owner' },
];

/** The 4083 fixture: no `access` anywhere. */
const LEGACY: View[] = [
  { id: 'v1', name: 'Pipeline', pinned: true },
  { id: 'v2', name: 'Stalled', pinned: false },
  { id: 'v3', name: 'Pipeline', pinned: true },
  { id: 'v4', name: 'Errors', pinned: false },
];

type Props = SavedViewsProps<View, Filters, Metric>;

function makeSharing(current?: () => SavedViewUpdate<Filters, Metric>) {
  const sharing: SavedViewsSharing<View, Filters, Metric> = {
    onShare: jest.fn(),
    onLeave: jest.fn(),
    onUpdate: jest.fn(),
    current: current ?? (() => ({ filters: { q: 'now' }, metric: { col: 'rows', fn: 'count' } })),
  };
  return sharing;
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    views: MIXED,
    loading: false,
    activeViewId: null,
    writeError: null,
    onApply: jest.fn(),
    onDelete: jest.fn(),
    onSave: jest.fn(),
    saveHint: 'Saves the filters and the time range',
    defaultViewId: 's-ed',
    onSetDefault: jest.fn(),
    ...overrides,
  };
  const utils = render(<SavedViews<View, Filters, Metric> {...props} />);
  return { ...utils, props };
}

const trigger = () => screen.getByRole('button', { name: /^Views/ });
const panel = () => screen.queryByRole('dialog', { name: 'Saved views' });
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="saved-views-row"]'));
const badge = () => document.querySelector('[data-slot="saved-views-badge"]');
const rowItem = (name: string) => {
  const row = rows().find((r) => r.querySelector('.truncate')?.textContent === name);
  if (!row) throw new Error(`no row ${name}`);
  return row.closest('li') as HTMLLIElement;
};
const buttonsIn = (li: HTMLElement) => within(li).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
const open = () => fireEvent.click(trigger());
const PIN = { max: 3, onTogglePin: jest.fn() };

describe('SavedViews sharing (BACKLOG-4087)', () => {
  it('C1a a viewer row has no Default, Pin, Delete or Share; it offers Leave', () => {
    setup({ pinning: PIN, sharing: makeSharing() });
    open();
    expect(buttonsIn(rowItem('Backlog'))).toEqual([expect.stringMatching(/^Backlog/), 'Leave Backlog']);
  });

  it('C1b an EDITOR row has no Default, Pin, Delete or Share either; it offers Update and Leave', () => {
    setup({ pinning: PIN, sharing: makeSharing() });
    open();
    expect(buttonsIn(rowItem('Budget'))).toEqual([
      expect.stringMatching(/^Budget/),
      'Update Budget with the current filters',
      'Leave Budget',
    ]);
  });

  it('C1c own rows keep Default, Pin, Share and Delete', () => {
    setup({ pinning: PIN, sharing: makeSharing() });
    open();
    expect(buttonsIn(rowItem('Pipeline'))).toEqual([
      expect.stringMatching(/^Pipeline/),
      'Make Pipeline the default',
      'Unpin Pipeline',
      'Share Pipeline',
      'Delete Pipeline',
    ]);
  });

  it('C1d without `sharing`, shared rows still list read-only: no Default, Pin, Delete, Update or Leave', () => {
    setup({ pinning: PIN });
    open();
    expect(buttonsIn(rowItem('Budget'))).toEqual([expect.stringMatching(/^Budget/)]);
    expect(buttonsIn(rowItem('Backlog'))).toEqual([expect.stringMatching(/^Backlog/)]);
    expect(screen.queryByRole('button', { name: /^Share / })).toBeNull();
  });

  it('C1f (BACKLOG-4144) `sharing` without onShare: own rows have no Share; shared rows keep Update and Leave', () => {
    const { onShare: _omit, ...rest } = makeSharing();
    void _omit;
    setup({ pinning: PIN, sharing: rest });
    open();
    expect(buttonsIn(rowItem('Pipeline'))).toEqual([
      expect.stringMatching(/^Pipeline/),
      'Make Pipeline the default',
      'Unpin Pipeline',
      'Delete Pipeline',
    ]);
    expect(buttonsIn(rowItem('Budget'))).toEqual([
      expect.stringMatching(/^Budget/),
      'Update Budget with the current filters',
      'Leave Budget',
    ]);
    expect(buttonsIn(rowItem('Backlog'))).toEqual([expect.stringMatching(/^Backlog/), 'Leave Backlog']);
    expect(screen.queryByRole('button', { name: /^Share / })).toBeNull();
  });

  it('C1e a shared row that is the defaultViewId shows no Default marker', () => {
    setup({ defaultViewId: 's-ed' });
    open();
    expect(document.querySelectorAll('[data-slot="saved-views-default-marker"]')).toHaveLength(0);
  });

  it('C2 Update sends exactly { filters, metric } from current(), even when current() carries more', () => {
    const extra = {
      filters: { q: 'new' },
      metric: { col: 'runs', fn: 'sum' },
      name: 'Hijacked',
      pinned: true,
      is_default: true,
    } as unknown as SavedViewUpdate<Filters, Metric>;
    const sharing = makeSharing(() => extra);
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget with the current filters' }));
    expect(sharing.onUpdate).toHaveBeenCalledTimes(1);
    const [view, payload] = (sharing.onUpdate as jest.Mock).mock.calls[0];
    expect(view.id).toBe('s-ed');
    expect(Object.keys(payload).sort()).toEqual(['filters', 'metric']);
    expect(payload).toStrictEqual({ filters: { q: 'new' }, metric: { col: 'runs', fn: 'sum' } });
    expect(screen.queryByRole('button', { name: /^Update Backlog/ })).toBeNull();
  });

  it('C4 back-compat: with no `access` anywhere the panel is exactly the 4083 panel', () => {
    setup({ views: LEGACY, defaultViewId: 'v3', pinning: PIN });
    open();
    expect(rows().map((r) => r.textContent)).toEqual(['Pipeline', 'Stalled', 'PipelineDefault', 'Errors']);
    for (const name of ['Stalled', 'Errors']) {
      expect(buttonsIn(rowItem(name))).toEqual([
        name,
        `Make ${name} the default`,
        `Pin ${name} as a card`,
        `Delete ${name}`,
      ]);
    }
    expect(screen.queryByText('Shared with you')).toBeNull();
    expect(document.querySelector('[data-slot="saved-views-shared-group"]')).toBeNull();
    expect(panel()?.querySelectorAll('ul')).toHaveLength(1);
    expect(badge()).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: /^(Share|Leave|Update) / })).toBeNull();
  });

  it('C5 the pin badge and the pin cap count own rows only', () => {
    setup({ pinning: { max: 2, onTogglePin: PIN.onTogglePin }, sharing: makeSharing() });
    expect(badge()).toHaveTextContent('1');
    open();
    PIN.onTogglePin.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Stalled as a card' }));
    expect(PIN.onTogglePin).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/At most 2 pinned cards/)).toBeNull();
  });

  it('C5b no own pins and two shared pins: no badge', () => {
    setup({
      views: MIXED.map((v) => (v.access && v.access !== 'owner' ? v : { ...v, pinned: false })),
      pinning: PIN,
    });
    expect(badge()).toBeNull();
  });

  it('C7 a shared row is named "<name> shared by <owner>"; the owner is truncated with a title', () => {
    setup();
    open();
    const budget = rows().find((r) => r.textContent?.startsWith('Budget')) as HTMLButtonElement;
    const backlog = rows().find((r) => r.textContent?.startsWith('Backlog')) as HTMLButtonElement;
    expect(budget).toHaveAccessibleName('Budget shared by Avery Quinn');
    expect(backlog).toHaveAccessibleName(`Backlog shared by ${LONG_OWNER}`);
    const owner = backlog.querySelector('[data-slot="saved-views-owner"]') as HTMLElement;
    expect(owner).toHaveAttribute('title', LONG_OWNER);
    expect(owner).toHaveClass('truncate', 'max-w-[7rem]');
    // own rows carry no owner
    expect(rows().find((r) => r.textContent === 'Pipeline')).toHaveAccessibleName('Pipeline');
  });

  it('C7b a shared row with no ownerName says "shared by another user"', () => {
    setup({ views: [{ id: 's1', name: 'Orphan', pinned: false, access: 'viewer' }] });
    open();
    expect(rows()[0]).toHaveAccessibleName('Orphan shared by another user');
  });

  it('C9 own rows sort before shared rows under a "Shared with you" heading; arrows cross the groups', () => {
    setup();
    open();
    expect(rows().map((r) => r.querySelector('.truncate')?.textContent)).toEqual(['Pipeline', 'Stalled', 'Budget', 'Backlog']);
    const group = document.querySelector('[data-slot="saved-views-shared-group"]') as HTMLElement;
    expect(within(group).getByRole('list', { name: 'Shared with you' })).toBeInTheDocument();
    expect(within(group).getAllByRole('listitem')).toHaveLength(2);
    expect(rows()[0]).toHaveFocus();
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown' });
    fireEvent.keyDown(rows()[1], { key: 'ArrowDown' });
    expect(rows()[2]).toHaveFocus();
    fireEvent.keyDown(rows()[2], { key: 'End' });
    expect(rows()[3]).toHaveFocus();
  });

  it('C9b the applied-view chip (4121) shows a shared view by name', () => {
    setup({ activeViewId: 's-vw', onClear: jest.fn() });
    expect(trigger()).toHaveAccessibleName(/^Views: Backlog/);
    expect(screen.getByRole('button', { name: 'Clear view Backlog' })).toBeInTheDocument();
  });

  it('C6a Leave asks in the panel first; Cancel calls nothing; the confirm calls onLeave once with that view', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    const sharing = makeSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Backlog' }));
    expect(sharing.onLeave).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: 'Leave Backlog' });
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Leave Backlog' })).toBeNull();
    expect(sharing.onLeave).not.toHaveBeenCalled();
    // arm Backlog, then Budget: the confirm is keyed per view
    fireEvent.click(screen.getByRole('button', { name: 'Leave Backlog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave Budget' }));
    expect(screen.queryByRole('group', { name: 'Leave Backlog' })).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Leave Budget' })).getByRole('button', { name: 'Leave view' }));
    expect(sharing.onLeave).toHaveBeenCalledTimes(1);
    expect((sharing.onLeave as jest.Mock).mock.calls[0][0].id).toBe('s-ed');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('C6b Escape with the Leave confirm open cancels the confirm only; the next Escape closes the panel', () => {
    const sharing = makeSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Backlog' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Leave Backlog' })).toBeNull();
    expect(panel()).not.toBeNull();
    expect(sharing.onLeave).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('C6f Escape on the Leave confirm after the list changed returns focus to the armed row', () => {
    const ROWS: View[] = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
      id: `s-${name}`,
      name,
      pinned: false,
      access: 'viewer' as const,
      ownerName: 'Avery Quinn',
    }));
    const sharing = makeSharing();
    const { rerender, props } = setup({ views: ROWS, sharing, defaultViewId: null });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Alpha' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Leave Alpha' })).getByRole('button', { name: 'Leave view' }));
    rerender(<SavedViews<View, Filters, Metric> {...props} views={ROWS.slice(1)} sharing={sharing} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave Gamma' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Leave Gamma' })).toBeNull();
    expect(document.activeElement).toHaveAccessibleName(/^Gamma shared by/);
  });

  it('C8a Share on an own row closes the panel, then calls onShare with that view', () => {
    const sharing = makeSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Share Stalled' }));
    expect(panel()).toBeNull();
    expect(sharing.onShare).toHaveBeenCalledTimes(1);
    expect((sharing.onShare as jest.Mock).mock.calls[0][0].id).toBe('v2');
  });

  it('N1 no nested interactive elements anywhere in the panel', () => {
    setup({ pinning: PIN, sharing: makeSharing(), activeViewId: 'v1', onClear: jest.fn() });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Backlog' }));
    const nested = document.querySelectorAll(
      'button button, button a, button input, button [tabindex], a button, li[role="button"] button'
    );
    expect(nested).toHaveLength(0);
    expect(rows().length).toBe(4);
  });

  it('E2 ShareDialog is exported from the package index', () => {
    expect(ShareDialogFromIndex).toBe(ShareDialog);
    expect(SavedViewsFromIndex).toBe(SavedViews);
  });
});

/**
 * BACKLOG-4142: the editor's metric picker. The view's own metric (initial)
 * and the page's metric (current().metric) differ on purpose, so a payload
 * built from the wrong one shows (U1).
 */
describe('SavedViews editor metric picker (BACKLOG-4142)', () => {
  const VIEW_METRIC: Metric = { col: 'duration', fn: 'p90' };
  const PAGE_METRIC: Metric = { col: 'rows', fn: 'count' };

  function MetricPicker({ value, onChange }: { value: Metric; onChange: (next: Metric) => void }) {
    return (
      <select aria-label="Card metric" value={value.col} onChange={(e) => onChange({ col: e.target.value, fn: 'count' })}>
        <option value="duration">Duration</option>
        <option value="rows">Rows</option>
        <option value="errors">Errors</option>
      </select>
    );
  }

  function makePickerSharing(current?: () => SavedViewUpdate<Filters, Metric>) {
    const initial = jest.fn((_view: View) => VIEW_METRIC);
    const sharing: SavedViewsSharing<View, Filters, Metric> = {
      ...makeSharing(current ?? (() => ({ filters: { q: 'now' }, metric: PAGE_METRIC }))),
      updateMetric: {
        initial,
        render: (value, onChange) => <MetricPicker value={value} onChange={onChange} />,
      },
    };
    return { sharing, initial };
  }

  const form = () => screen.queryByRole('group', { name: 'Update filters and card metric' });

  it('U0 the editor row button is "Update <name>"; it opens the form seeded from initial(view) and calls nothing', () => {
    const { sharing, initial } = makePickerSharing();
    setup({ sharing });
    open();
    expect(buttonsIn(rowItem('Budget'))).toEqual([expect.stringMatching(/^Budget/), 'Update Budget', 'Leave Budget']);
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    expect(form()).not.toBeNull();
    expect(initial).toHaveBeenCalledWith(expect.objectContaining({ id: 's-ed' }));
    expect(screen.getByRole('combobox', { name: 'Card metric' })).toHaveValue('duration');
    expect(screen.getByRole('combobox', { name: 'Card metric' })).toHaveFocus();
    expect(sharing.onUpdate).not.toHaveBeenCalled();
  });

  it('U1 confirm with nothing changed sends the VIEW metric from initial(view), not current().metric', () => {
    const { sharing } = makePickerSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    fireEvent.click(within(form() as HTMLElement).getByRole('button', { name: 'Update view' }));
    expect(sharing.onUpdate).toHaveBeenCalledTimes(1);
    const [view, payload] = (sharing.onUpdate as jest.Mock).mock.calls[0];
    expect(view.id).toBe('s-ed');
    expect(payload).toStrictEqual({ filters: { q: 'now' }, metric: VIEW_METRIC });
    expect(payload.metric).not.toEqual(PAGE_METRIC);
    expect(form()).toBeNull();
  });

  it('U2 a picked metric goes out as exactly { filters, metric }, even when current() carries more', () => {
    const extra = {
      filters: { q: 'new' },
      metric: PAGE_METRIC,
      name: 'Hijacked',
      pinned: true,
      is_default: true,
    } as unknown as SavedViewUpdate<Filters, Metric>;
    const { sharing } = makePickerSharing(() => extra);
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Card metric' }), { target: { value: 'errors' } });
    fireEvent.click(within(form() as HTMLElement).getByRole('button', { name: 'Update view' }));
    expect(sharing.onUpdate).toHaveBeenCalledTimes(1);
    const payload = (sharing.onUpdate as jest.Mock).mock.calls[0][1];
    expect(Object.keys(payload).sort()).toEqual(['filters', 'metric']);
    expect(payload).toStrictEqual({ filters: { q: 'new' }, metric: { col: 'errors', fn: 'count' } });
  });

  it('U3 without updateMetric, Update is still one click with the current() payload and no form', () => {
    const sharing = makeSharing(() => ({ filters: { q: 'now' }, metric: PAGE_METRIC }));
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget with the current filters' }));
    expect(sharing.onUpdate).toHaveBeenCalledTimes(1);
    expect((sharing.onUpdate as jest.Mock).mock.calls[0][1]).toStrictEqual({ filters: { q: 'now' }, metric: PAGE_METRIC });
    expect(form()).toBeNull();
    expect(document.querySelector('[data-slot="saved-views-update-form"]')).toBeNull();
  });

  it('U4 Cancel calls nothing and returns focus to the row Update button', () => {
    const { sharing } = makePickerSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    fireEvent.click(within(form() as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(form()).toBeNull();
    expect(sharing.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Update Budget' })).toHaveFocus();
  });

  it('U5 Escape closes the form only, focus returns to the row Update button; the next Escape closes the panel', () => {
    const { sharing } = makePickerSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(form()).toBeNull();
    expect(panel()).not.toBeNull();
    expect(sharing.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Update Budget' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('U6 one inline form at a time: Update, Leave and the save form replace each other', () => {
    const { sharing } = makePickerSharing();
    setup({ sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave Backlog' }));
    expect(form()).toBeNull();
    expect(screen.getByRole('group', { name: 'Leave Backlog' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    expect(screen.queryByRole('group', { name: 'Leave Backlog' })).toBeNull();
    expect(form()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(form()).toBeNull();
    expect(screen.getByRole('textbox', { name: 'View name' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    expect(screen.queryByRole('textbox', { name: 'View name' })).toBeNull();
    expect(form()).not.toBeNull();
    expect(sharing.onUpdate).not.toHaveBeenCalled();
    expect(sharing.onLeave).not.toHaveBeenCalled();
  });

  it('U7 no nested interactive elements with the Update form open', () => {
    const { sharing } = makePickerSharing();
    setup({ pinning: PIN, sharing });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Budget' }));
    expect(document.querySelectorAll('button button, button select, button input')).toHaveLength(0);
  });
});
