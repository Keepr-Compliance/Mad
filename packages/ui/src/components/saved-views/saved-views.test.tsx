import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavedViews } from './saved-views';
import { SavedViews as SavedViewsFromIndex } from '../../index';
import type { SavedViewItem, SavedViewsProps } from './types';

/**
 * BACKLOG-4083. Test ids match PLAN v1 section 5 and the SR plan review
 * (change 1: D1, D2, K3).
 *
 * Fixture rules:
 * - v1 and v3 share the name "Pipeline", so any comparison by name instead of
 *   id is visible (T5, T6, D1).
 * - v1 and v3 are both pinned and v3 is the default, so marking pinned rows
 *   as default shows a second marker (D2).
 * - the active view (v2) is not the first row, so "focus the active row on
 *   open" differs from "focus the first row" (K1).
 */
interface View extends SavedViewItem {
  pinned: boolean;
}

const VIEWS: View[] = [
  { id: 'v1', name: 'Pipeline', pinned: true },
  { id: 'v2', name: 'Stalled', pinned: false },
  { id: 'v3', name: 'Pipeline', pinned: true },
  { id: 'v4', name: 'Errors', pinned: false },
];

type Props = SavedViewsProps<View>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    views: VIEWS,
    loading: false,
    activeViewId: null,
    writeError: null,
    onApply: jest.fn(),
    onDelete: jest.fn(),
    onSave: jest.fn(),
    saveHint: 'Saves the filters and the time range',
    defaultViewId: null,
    onSetDefault: jest.fn(),
    ...overrides,
  };
  const utils = render(<SavedViews<View> {...props} />);
  return { ...utils, props };
}

const trigger = () => screen.getByRole('button', { name: /^Views/ });
const panel = () => screen.queryByRole('dialog', { name: 'Saved views' });
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="saved-views-row"]'));
const markers = () => document.querySelectorAll('[data-slot="saved-views-default-marker"]');
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

function openByClick() {
  fireEvent.click(trigger());
}

describe('SavedViews', () => {
  it('T1 trigger is a dialog disclosure: aria-haspopup=dialog, aria-expanded false -> true, aria-controls names the panel', () => {
    setup();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
    openByClick();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const id = trigger().getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)).toBe(panel());
  });

  it('T1b panel is capped to the viewport width for 375px screens', () => {
    setup();
    openByClick();
    expect(panel()).toHaveClass('w-80', 'max-w-[calc(100vw-2rem)]');
  });

  it('T2 views=null fails closed: "not available yet", no save button, no rows', () => {
    setup({ views: null });
    openByClick();
    expect(screen.getByText('Saved views are not available yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save current view/ })).toBeNull();
    expect(screen.queryByText('No saved views yet')).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('T3 loading shows Loading (even with an empty list); empty shows "No saved views yet"', () => {
    const { rerender, props } = setup({ views: [], loading: true });
    openByClick();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('No saved views yet')).toBeNull();
    rerender(<SavedViews<View> {...props} loading={false} />);
    expect(screen.getByText('No saved views yet')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('T4 clicking a row applies it once, closes the panel and returns focus to the trigger', () => {
    const { props } = setup();
    openByClick();
    fireEvent.click(rows()[1]);
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith(VIEWS[1]);
    expect(panel()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('T5 the active row is compared by id: only v3 is pressed, not v1 with the same name', () => {
    setup({ activeViewId: 'v3' });
    openByClick();
    expect(rows().map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('T6 Delete calls onDelete with that exact view only; onApply is not called and the panel stays open', () => {
    const { props } = setup();
    openByClick();
    const deletes = screen.getAllByRole('button', { name: 'Delete Pipeline' });
    fireEvent.click(deletes[1]);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect((props.onDelete as jest.Mock).mock.calls[0][0]).toBe(VIEWS[2]);
    expect(props.onApply).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it('T7 save: Enter in the name saves the trimmed name; an empty name shows a message and calls nothing', () => {
    const { props } = setup();
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    const input = screen.getByRole('textbox', { name: 'View name' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '   ' } });
    key(input, 'Enter');
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Give the view a name.');
    fireEvent.change(input, { target: { value: '  My view  ' } });
    key(input, 'Enter');
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith('My view');
    expect(screen.queryByRole('textbox', { name: 'View name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save current view' })).toHaveFocus();
  });

  it('T7b the save button saves too, and the hint is shown in the form', () => {
    const { props } = setup();
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(screen.getByText('Saves the filters and the time range')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(props.onSave).toHaveBeenCalledWith('Mine');
  });

  it('T8 writeError is shown as status; a local validation message wins over it', () => {
    setup({ writeError: 'The database refused the save.' });
    openByClick();
    expect(screen.getByRole('status')).toHaveTextContent('The database refused the save.');
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    const input = screen.getByRole('textbox', { name: 'View name' });
    key(input, 'Enter');
    expect(screen.getByRole('status')).toHaveTextContent('Give the view a name.');
    expect(screen.getByRole('status')).not.toHaveTextContent('The database refused');
  });

  it('T9 without pinning: no pin buttons, no badge, plain save labels', () => {
    setup();
    expect(document.querySelector('[data-slot="saved-views-badge"]')).toBeNull();
    openByClick();
    expect(screen.queryAllByRole('button', { name: /^(Pin|Unpin) / })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(screen.getByRole('button', { name: 'Save view' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save and pin' })).toBeNull();
  });

  it('T10 with pinning at the cap: badge counts pinned; pinning is refused, unpinning is allowed', () => {
    const onTogglePin = jest.fn();
    setup({ pinning: { max: 2, onTogglePin } });
    expect(document.querySelector('[data-slot="saved-views-badge"]')).toHaveTextContent('2');
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Stalled as a card' }));
    expect(onTogglePin).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('At most 2 pinned cards. Unpin one first.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Unpin Pipeline' })[0]);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onTogglePin.mock.calls[0][0]).toBe(VIEWS[0]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('T10b with pinning at the cap, saving (which pins) is refused; under the cap it saves', () => {
    const onTogglePin = jest.fn();
    const { props, rerender } = setup({ pinning: { max: 2, onTogglePin } });
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view as a card' }));
    const input = screen.getByRole('textbox', { name: 'View name' });
    fireEvent.change(input, { target: { value: 'Third' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and pin' }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('At most 2 pinned cards. Unpin one first.');
    rerender(<SavedViews<View> {...props} pinning={{ max: 3, onTogglePin }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save and pin' }));
    expect(props.onSave).toHaveBeenCalledWith('Third');
  });

  it('T11 saveFields render inside the save form only while it is open', () => {
    setup({ saveFields: <label>Column<select aria-label="Column" /></label> });
    openByClick();
    expect(screen.queryByRole('combobox', { name: 'Column' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(screen.getByRole('combobox', { name: 'Column' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('combobox', { name: 'Column' })).toBeNull();
  });

  it('D1 default toggle is per row by id: v1 (same name as the default v3) -> onSetDefault(v1); v3 -> onSetDefault(null)', () => {
    const { props } = setup({ defaultViewId: 'v3' });
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Make Pipeline the default' }));
    expect(props.onSetDefault).toHaveBeenCalledTimes(1);
    expect((props.onSetDefault as jest.Mock).mock.calls[0][0]).toBe(VIEWS[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Stop opening Pipeline by default' }));
    expect(props.onSetDefault).toHaveBeenCalledTimes(2);
    expect((props.onSetDefault as jest.Mock).mock.calls[1][0]).toBeNull();
  });

  it('D1b toggles carry aria-pressed: true only on the default row', () => {
    setup({ defaultViewId: 'v3' });
    openByClick();
    const toggles = screen.getAllByRole('button', { name: /(the default|by default)$/ });
    expect(toggles.map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('D2 exactly one row carries the visible Default marker, and it is the default row', () => {
    setup({ defaultViewId: 'v3', pinning: { max: 5, onTogglePin: jest.fn() } });
    openByClick();
    expect(markers()).toHaveLength(1);
    expect(rows()[2]).toContainElement(markers()[0] as HTMLElement);
  });

  it('D2b no default -> no marker', () => {
    setup({ defaultViewId: null });
    openByClick();
    expect(markers()).toHaveLength(0);
  });

  it('K1 ArrowDown opens on the active row; ArrowDown/ArrowUp stop at the ends; Home/End; Enter applies', async () => {
    const user = userEvent.setup();
    const { props } = setup({ activeViewId: 'v2' });
    trigger().focus();
    await act(async () => { await user.keyboard('{ArrowDown}'); });
    expect(rows()[1]).toHaveFocus();
    await act(async () => { await user.keyboard('{ArrowDown}{ArrowDown}'); });
    expect(rows()[3]).toHaveFocus();
    await act(async () => { await user.keyboard('{ArrowDown}'); });
    expect(rows()[3]).toHaveFocus();
    await act(async () => { await user.keyboard('{Home}'); });
    expect(rows()[0]).toHaveFocus();
    await act(async () => { await user.keyboard('{ArrowUp}'); });
    expect(rows()[0]).toHaveFocus();
    await act(async () => { await user.keyboard('{End}'); });
    expect(rows()[3]).toHaveFocus();
    await act(async () => { await user.keyboard('{Enter}'); });
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith(VIEWS[3]);
    expect(panel()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('K1b ArrowUp opens on the last row; Space applies; with no rows, Enter focuses "Save current view"', async () => {
    const user = userEvent.setup();
    const { props, unmount } = setup();
    trigger().focus();
    await act(async () => { await user.keyboard('{ArrowUp}'); });
    expect(rows()[3]).toHaveFocus();
    await act(async () => { await user.keyboard(' '); });
    expect(props.onApply).toHaveBeenCalledWith(VIEWS[3]);
    unmount();
    setup({ views: [] });
    trigger().focus();
    await act(async () => { await user.keyboard('{Enter}'); });
    expect(screen.getByRole('button', { name: 'Save current view' })).toHaveFocus();
  });

  it('K2 Escape cancels the save form first, then closes and returns focus to the trigger', () => {
    setup();
    openByClick();
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    const input = screen.getByRole('textbox', { name: 'View name' });
    key(input, 'Escape');
    expect(screen.queryByRole('textbox', { name: 'View name' })).toBeNull();
    expect(panel()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save current view' })).toHaveFocus();
    key(screen.getByRole('button', { name: 'Save current view' }), 'Escape');
    expect(panel()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('K3 a CLOSED SavedViews does not swallow Escape: a parent keydown handler receives it', () => {
    const parentKeyDown = jest.fn();
    render(
      <div onKeyDown={(e) => parentKeyDown(e.key)}>
        <SavedViews<View>
          views={VIEWS}
          loading={false}
          activeViewId={null}
          writeError={null}
          onApply={jest.fn()}
          onDelete={jest.fn()}
          onSave={jest.fn()}
          saveHint="hint"
          defaultViewId={null}
          onSetDefault={jest.fn()}
        />
      </div>
    );
    key(trigger(), 'Escape');
    expect(parentKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('K3b after open and Escape-close, the next Escape reaches the parent again (no leaked listener)', () => {
    const parentKeyDown = jest.fn();
    render(
      <div onKeyDown={(e) => parentKeyDown(e.key)}>
        <SavedViews<View>
          views={VIEWS}
          loading={false}
          activeViewId={null}
          writeError={null}
          onApply={jest.fn()}
          onDelete={jest.fn()}
          onSave={jest.fn()}
          saveHint="hint"
          defaultViewId={null}
          onSetDefault={jest.fn()}
        />
      </div>
    );
    openByClick();
    key(rows()[0], 'Escape');
    expect(panel()).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    key(trigger(), 'Escape');
    expect(parentKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('K4 a pointerdown outside closes WITHOUT moving focus to the trigger', () => {
    render(<button type="button">Elsewhere</button>);
    setup();
    openByClick();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    expect(panel()).toBeNull();
    expect(trigger()).not.toHaveFocus();
    expect(elsewhere).toHaveFocus();
  });

  it('K4b a pointerdown inside the panel does not close it', () => {
    setup();
    openByClick();
    fireEvent.pointerDown(rows()[0]);
    expect(panel()).not.toBeNull();
  });

  it('K5 two instances get distinct panel ids', () => {
    render(
      <>
        <SavedViews<View> views={VIEWS} loading={false} activeViewId={null} writeError={null} onApply={jest.fn()} onDelete={jest.fn()} onSave={jest.fn()} saveHint="a" defaultViewId={null} onSetDefault={jest.fn()} />
        <SavedViews<View> views={VIEWS} loading={false} activeViewId={null} writeError={null} onApply={jest.fn()} onDelete={jest.fn()} onSave={jest.fn()} saveHint="b" defaultViewId={null} onSetDefault={jest.fn()} />
      </>
    );
    const [first, second] = screen.getAllByRole('button', { name: /^Views/ });
    fireEvent.click(first);
    const firstId = first.getAttribute('aria-controls');
    fireEvent.pointerDown(document.body);
    fireEvent.click(second);
    const secondId = second.getAttribute('aria-controls');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(document.getElementById(secondId as string)).toBe(screen.getByRole('dialog'));
  });

  it('K6 roving tabindex: exactly one row is a Tab stop, and it follows arrow focus', () => {
    setup({ activeViewId: 'v2' });
    openByClick();
    const tabStops = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabStops()).toEqual([rows()[1]]);
    key(rows()[1], 'ArrowDown');
    expect(tabStops()).toEqual([rows()[2]]);
  });

  it('K7 Tab from the last control out of the panel closes it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SavedViews<View> views={[VIEWS[1]]} loading={false} activeViewId={null} writeError={null} onApply={jest.fn()} onDelete={jest.fn()} onSave={jest.fn()} saveHint="a" defaultViewId={null} onSetDefault={jest.fn()} />
        <button type="button">After</button>
      </>
    );
    openByClick();
    screen.getByRole('button', { name: 'Save current view' }).focus();
    await act(async () => { await user.tab(); });
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(panel()).toBeNull();
  });

  it('S1 storage-agnostic: the component source has no network or browser-storage access', () => {
    const source = fs.readFileSync(path.join(__dirname, 'saved-views.tsx'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|supabase|localStorage|sessionStorage|XMLHttpRequest|indexedDB/i);
  });

  it('E1 exported from the package index', () => {
    expect(SavedViewsFromIndex).toBe(SavedViews);
  });

  it('opening and closing with the trigger click toggles', () => {
    setup();
    openByClick();
    expect(panel()).not.toBeNull();
    act(() => {
      fireEvent.click(trigger());
    });
    expect(panel()).toBeNull();
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  });
});
