import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Dropdown, dropdownSide } from './dropdown';
import { DropdownOptions } from './dropdown-options';
import type { DropdownOption, DropdownSingleProps } from './types';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

/**
 * BACKLOG-4032 slice 1. Test ids T1-T22 match the plan and SR review.
 *
 * Fixture rules (SR R3):
 * - the selected value ('agent') sits at index 2, so "active starts at 0" is visible (T2);
 * - a disabled row ('billing') sits directly after the selected row (T6);
 * - EDGE has disabled first AND last rows (T7).
 */
const ROLES: DropdownOption[] = [
  { value: 'owner', label: 'Owner', description: 'Full control' },
  { value: 'admin', label: 'Admin', description: 'Manages users and billing' },
  { value: 'agent', label: 'Agent', description: 'Sees own transactions' },
  { value: 'billing', label: 'Billing', disabled: true, hint: 'Already billing contact' },
  { value: 'viewer', label: 'Viewer', description: 'Read only', keywords: ['readonly'] },
];

const EDGE: DropdownOption[] = [
  { value: 'a', label: 'Alpha', disabled: true },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta', disabled: true },
];

type Overrides = Partial<Omit<DropdownSingleProps, 'label' | 'ariaLabel'>>;

function renderDropdown(overrides: Overrides = {}) {
  const onChange = jest.fn();
  const props = {
    label: 'Role',
    options: ROLES,
    value: 'agent' as string | null,
    onChange,
    placeholder: 'Pick a role',
    ...overrides,
  };
  const utils = render(<Dropdown {...props} />);
  return { ...utils, onChange, props };
}

const trigger = () => screen.getByRole('button', { name: /^Role/ });
const search = () => screen.getByRole('combobox');
const listbox = () => screen.queryByRole('listbox');

function openIt() {
  fireEvent.click(trigger());
  return search();
}

/** Label text of the row aria-activedescendant points at, or null. */
function activeLabel(host: HTMLElement = search()): string | null {
  const id = host.getAttribute('aria-activedescendant');
  if (!id) return null;
  const row = document.getElementById(id);
  if (!row) return `MISSING:${id}`;
  return document.getElementById(`${id}-label`)?.textContent ?? null;
}

function key(el: HTMLElement, k: string) {
  fireEvent.keyDown(el, { key: k });
}

describe('Dropdown', () => {
  it('T1 field trigger: label above, name includes the value, placeholder when null', () => {
    const { rerender, props } = renderDropdown();
    expect(screen.getByText('Role').tagName).toBe('LABEL');
    expect(screen.getByRole('button', { name: /Role\s+Agent/ })).toBeInTheDocument();

    rerender(<Dropdown {...props} value={null} />);
    const t = screen.getByRole('button', { name: /Role\s+Pick a role/ });
    const placeholder = within(t).getByText('Pick a role');
    expect(placeholder).toHaveClass('text-muted-foreground');
  });

  it('T2 opening focuses the search, sets aria-expanded and starts on the selected row', () => {
    renderDropdown();
    const input = openIt();
    expect(document.activeElement).toBe(input);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(activeLabel()).toBe('Agent');
  });

  it('T2b a disabled selected value does not become the active row; the first enabled row does', () => {
    renderDropdown({ value: 'billing' });
    openIt();
    expect(activeLabel()).toBe('Owner');
  });

  it('T3 typing filters by label and description, case-insensitive; active moves to the first result', () => {
    renderDropdown();
    const input = openIt();
    fireEvent.change(input, { target: { value: 'TRANS' } });
    const names = within(listbox()!)
      .getAllByRole('option')
      .map((o) => document.getElementById(`${o.id}-label`)?.textContent);
    expect(names).toEqual(['Agent']);

    fireEvent.change(input, { target: { value: 'a' } });
    // 'a' matches Admin first (Owner's label and description have no 'a').
    expect(activeLabel()).toBe('Admin');

    // A query that excludes the selected option hides it (no pinning).
    fireEvent.change(input, { target: { value: 'view' } });
    expect(within(listbox()!).queryByRole('option', { name: /Agent/ })).toBeNull();
  });

  it('T4 a query that excludes the selected option leaves the trigger label intact', () => {
    renderDropdown();
    const input = openIt();
    fireEvent.change(input, { target: { value: 'view' } });
    expect(screen.getByRole('button', { name: /Role\s+Agent/ })).toBeInTheDocument();
  });

  it('T5 no matches: empty text, and Enter (reached from an active row) does not pick', () => {
    const { onChange, unmount } = renderDropdown();
    const input = openIt();
    expect(activeLabel()).toBe('Agent');
    key(input, 'ArrowDown');
    expect(activeLabel()).toBe('Viewer');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    key(input, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
    unmount();

    renderDropdown({ emptyText: 'Nobody found' });
    const input2 = openIt();
    fireEvent.change(input2, { target: { value: 'zzz' } });
    expect(screen.getByText('Nobody found')).toBeInTheDocument();
  });

  it('T6 ArrowDown/ArrowUp skip the disabled row and do not wrap', () => {
    renderDropdown();
    const input = openIt();
    expect(activeLabel()).toBe('Agent');
    key(input, 'ArrowDown'); // Billing (disabled) is skipped
    expect(activeLabel()).toBe('Viewer');
    key(input, 'ArrowDown'); // no wrap at the end
    expect(activeLabel()).toBe('Viewer');
    key(input, 'ArrowUp'); // skips Billing again
    expect(activeLabel()).toBe('Agent');
    key(input, 'ArrowUp');
    key(input, 'ArrowUp');
    expect(activeLabel()).toBe('Owner');
    key(input, 'ArrowUp'); // no wrap at the start
    expect(activeLabel()).toBe('Owner');
  });

  it('T7 Home/End land on the first/last ENABLED row when the edge rows are disabled', () => {
    renderDropdown({ options: EDGE, value: null });
    const input = openIt();
    expect(activeLabel()).toBe('Bravo');
    key(input, 'End');
    expect(activeLabel()).toBe('Charlie');
    key(input, 'Home');
    expect(activeLabel()).toBe('Bravo');
  });

  it('T8 disabled row: aria-disabled, visible hint as description only, click does nothing', () => {
    const { onChange } = renderDropdown();
    openIt();
    const row = screen.getByRole('option', { name: 'Billing' });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Already billing contact')).toBeVisible();
    expect(row).toHaveAccessibleDescription('Already billing contact');
    fireEvent.click(row);
    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).not.toBeNull();
  });

  it('T9 Enter picks the active row, closes and returns focus to the trigger', () => {
    const { onChange } = renderDropdown();
    const input = openIt();
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('viewer');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('T10 Escape with text clears the search first; the second Escape closes; value untouched', () => {
    const { onChange } = renderDropdown();
    const input = openIt();
    fireEvent.change(input, { target: { value: 'ad' } });
    key(input, 'Escape');
    expect(listbox()).not.toBeNull();
    expect(search()).toHaveValue('');
    key(search(), 'Escape');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Role\s+Agent/ })).toBeInTheDocument();
  });

  it('T11 pointerdown outside closes; pointerdown inside (search, a row) does not', () => {
    render(
      <div>
        <Dropdown label="Role" options={ROLES} value="agent" onChange={() => {}} />
        <p>elsewhere</p>
      </div>
    );
    const input = openIt();
    fireEvent.pointerDown(input);
    expect(listbox()).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole('option', { name: /Viewer/ }));
    expect(listbox()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(listbox()).toBeNull();
  });

  it('T11b outside pointerdown does not pull focus back to the trigger', () => {
    render(
      <div>
        <Dropdown label="Role" options={ROLES} value="agent" onChange={() => {}} />
        <button type="button">Other</button>
      </div>
    );
    openIt();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Other' }));
    expect(listbox()).toBeNull();
    expect(document.activeElement).not.toBe(trigger());
  });

  it('T12 invalid: aria-invalid, danger border, role=alert error linked by aria-describedby', () => {
    renderDropdown({ value: null, invalid: true, error: 'Choose a role.' });
    const t = trigger();
    expect(t).toHaveAttribute('aria-invalid', 'true');
    expect(t).toHaveClass('border-danger-600');
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a role.');
    expect(t).toHaveAccessibleDescription('Choose a role.');
  });

  it('T13 disabled field: trigger disabled and does not open by click or key', () => {
    renderDropdown({ disabled: true });
    const t = trigger();
    expect(t).toBeDisabled();
    fireEvent.click(t);
    key(t, 'ArrowDown');
    key(t, 'Enter');
    expect(listbox()).toBeNull();
  });

  it('T15 controlled: a parent value change updates the trigger; no internal copy', () => {
    const { rerender, props } = renderDropdown();
    rerender(<Dropdown {...props} value="admin" />);
    expect(screen.getByRole('button', { name: /Role\s+Admin/ })).toBeInTheDocument();

    // Parent ignores onChange: the trigger keeps showing the parent's value.
    rerender(<Dropdown {...props} value="admin" onChange={() => {}} />);
    const input = openIt();
    fireEvent.change(input, { target: { value: 'owner' } });
    key(search(), 'Enter');
    expect(screen.getByRole('button', { name: /Role\s+Admin/ })).toBeInTheDocument();
  });

  it('T16 Escape inside a kit Dialog closes the dropdown, not the dialog', () => {
    function Harness() {
      const [dlg, setDlg] = React.useState(true);
      return (
        <>
          <span data-testid="dlg">{dlg ? 'dlg-open' : 'dlg-closed'}</span>
          <Dialog open={dlg} onOpenChange={setDlg}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Edit</DialogTitle>
              <Dropdown label="Role" options={ROLES} value="agent" onChange={() => {}} />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const input = openIt();
    key(input, 'Escape');
    expect(listbox()).toBeNull();
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-open');
  });

  function TwoInDialog() {
    const [dlg, setDlg] = React.useState(true);
    return (
      <>
        <span data-testid="dlg">{dlg ? 'dlg-open' : 'dlg-closed'}</span>
        <Dialog open={dlg} onOpenChange={setDlg}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Edit</DialogTitle>
            <Dropdown label="First" options={ROLES} value="agent" onChange={() => {}} />
            <Dropdown label="Second" options={ROLES} value="agent" onChange={() => {}} />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  it('T16b closed dropdowns do not swallow Escape: the dialog closes', () => {
    render(<TwoInDialog />);
    key(screen.getByRole('button', { name: /^First/ }), 'Escape');
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-closed');
  });

  it('T16c after open and Escape-close of both dropdowns, Escape closes the dialog (no leaked listener)', () => {
    render(<TwoInDialog />);
    for (const name of [/^First/, /^Second/]) {
      fireEvent.click(screen.getByRole('button', { name }));
      key(screen.getByRole('combobox'), 'Escape');
      expect(listbox()).toBeNull();
      expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-open');
    }
    key(screen.getByRole('button', { name: /^Second/ }), 'Escape');
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-closed');
  });

  it('T17 clicking an enabled row picks it, closes and returns focus to the trigger', () => {
    const { onChange } = renderDropdown();
    openIt();
    const row = screen.getByRole('option', { name: /Owner/ });
    fireEvent.pointerDown(row);
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    expect(onChange).toHaveBeenCalledWith('owner');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('T18 two Dropdowns on one page get distinct listbox and option ids', () => {
    render(
      <div>
        <Dropdown label="First" options={ROLES} value="agent" onChange={() => {}} />
        <Dropdown label="Second" options={ROLES} value="agent" onChange={() => {}} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: /^First/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Second/ }));
    const boxes = screen.getAllByRole('listbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].id).not.toBe(boxes[1].id);
    const ids = screen.getAllByRole('option').map((o) => o.id);
    expect(ids).toHaveLength(ROLES.length * 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('T19 options shrink while open: activedescendant never points at a missing id; Enter picks a present row', () => {
    const { rerender, props, onChange } = renderDropdown();
    openIt();
    expect(activeLabel()).toBe('Agent');
    const shrunk = ROLES.filter((o) => o.value !== 'agent');
    rerender(<Dropdown {...props} options={shrunk} />);
    const id = search().getAttribute('aria-activedescendant');
    expect(id).not.toBeNull();
    expect(document.getElementById(id!)).not.toBeNull();
    expect(activeLabel()).toBe('Owner');
    key(search(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('owner');
  });

  it.each(['ArrowDown', 'ArrowUp', 'Enter', ' '])('T20 key %p on the closed trigger opens it', (k) => {
    renderDropdown();
    key(trigger(), k);
    expect(listbox()).not.toBeNull();
    expect(document.activeElement).toBe(search());
  });

  it('T20 Tab from the search field closes the panel', () => {
    const { onChange } = renderDropdown();
    const input = openIt();
    key(input, 'Tab');
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('T21 searchable={false}: the listbox takes focus and carries the keyboard model', () => {
    const { onChange } = renderDropdown({ searchable: false });
    fireEvent.click(trigger());
    expect(screen.queryByRole('combobox')).toBeNull();
    const box = listbox()!;
    expect(document.activeElement).toBe(box);
    expect(box).toHaveAttribute('tabindex', '0');
    expect(activeLabel(box)).toBe('Agent');
    key(box, 'ArrowDown');
    expect(activeLabel(box)).toBe('Viewer');
    key(box, 'Enter');
    expect(onChange).toHaveBeenCalledWith('viewer');
  });

  it('names: search field has its own label; ariaLabel works without a visible label', () => {
    render(<Dropdown ariaLabel="Assignee" options={ROLES} value="agent" onChange={() => {}} />);
    const t = screen.getByRole('button', { name: /Assignee\s+Agent/ });
    fireEvent.click(t);
    expect(screen.getByRole('combobox', { name: 'Search Assignee' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Assignee' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Agent Sees own transactions' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

describe('DropdownOptions (standalone, phone recipe base)', () => {
  it('T22 renders without a trigger, filters uncontrolled, picks on click, comfortable rows', () => {
    const onSelect = jest.fn();
    render(
      <DropdownOptions ariaLabel="Role" options={ROLES} value={null} onSelect={onSelect} size="comfortable" />
    );
    const input = screen.getByRole('combobox', { name: 'Search Role' });
    act(() => {
      fireEvent.change(input, { target: { value: 'adm' } });
    });
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveClass('min-h-12');
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith('admin');
  });
});

/**
 * BACKLOG-4007 People popups: the panel is not portalled. A kit Dialog sets no overflow, so it
 * does not clip the panel, but the Dialog is fixed and centered: near the bottom of the screen a
 * downward panel would run off the viewport (and the page cannot scroll while the Dialog is
 * open). The Dropdown measures the trigger on open and opens upward when the room below is
 * short. jsdom has no layout, so the trigger's rectangle is stubbed.
 */
describe('Dropdown placement inside a kit Dialog', () => {
  const realHeight = window.innerHeight;
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
    jest.restoreAllMocks();
  });

  function openAt(top: number, viewport: number) {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport });
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Edit</DialogTitle>
          <Dropdown label="User" options={ROLES} value={null} onChange={() => undefined} />
        </DialogContent>
      </Dialog>
    );
    const trigger = screen.getByRole('button', { name: /^User/ });
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 36, left: 0, right: 300, width: 300, height: 36, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
    act(() => {
      fireEvent.click(trigger);
    });
    return document.querySelector('[data-slot="dropdown-panel"]') as HTMLElement;
  }

  it('near the bottom of the viewport the panel opens upward', () => {
    const panel = openAt(700, 768);
    expect(panel).toHaveAttribute('data-side', 'top');
    expect(panel.className).toContain('bottom-full');
    expect(panel.className).not.toContain('mt-1');
  });

  it('with room below it opens downward', () => {
    const panel = openAt(200, 768);
    expect(panel).toHaveAttribute('data-side', 'bottom');
    expect(panel.className).toContain('mt-1');
  });

  it('reopening re-measures: up near the bottom, then down once the trigger has moved up', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Edit</DialogTitle>
          <Dropdown label="User" options={ROLES} value={null} onChange={() => undefined} />
        </DialogContent>
      </Dialog>
    );
    const trig = screen.getByRole('button', { name: /^User/ });
    const stub = (top: number) =>
      jest.spyOn(trig, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 36, left: 0, right: 300, width: 300, height: 36, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
    const panel = () => document.querySelector('[data-slot="dropdown-panel"]');

    stub(700);
    fireEvent.click(trig);
    expect(panel()).toHaveAttribute('data-side', 'top');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();

    stub(200);
    fireEvent.click(trig);
    expect(panel()).toHaveAttribute('data-side', 'bottom');
  });

  it('the panel is positioned against a wrapper holding the trigger, not the label', () => {
    const panel = openAt(200, 768);
    const trig = screen.getByRole('button', { name: /^User/ });
    const label = screen.getByText('User', { selector: 'label' });
    const offsetParent = panel.parentElement as HTMLElement;
    expect(offsetParent.className).toContain('relative');
    expect(offsetParent.contains(trig)).toBe(true);
    expect(offsetParent.contains(label)).toBe(false);
    expect(offsetParent).not.toBe(panel.closest('[data-slot="dropdown"]'));
  });

  it('the Dialog content sets no overflow that would clip the panel', () => {
    const panel = openAt(200, 768);
    const content = screen.getByRole('dialog');
    expect(content.className).not.toMatch(/overflow-(hidden|auto|y-auto|scroll)/);
    expect(content.contains(panel)).toBe(true);
  });
});

/**
 * dropdownSide(rect, viewportHeight): 'top' only when less than 300px is free below the trigger
 * AND more room is free above it. Rows sweep both sides of each boundary (SR review of #3156).
 */
describe('dropdownSide', () => {
  const rect = (top: number) => ({ top, bottom: top + 36 });
  const rows: Array<[string, number, number, 'top' | 'bottom']> = [
    ['short below, more above', 500, 768, 'top'],
    ['short below, LESS above than below', 200, 480, 'bottom'],
    ['room below (>= 300)', 100, 768, 'bottom'],
    ['exactly 300 below, more above', 432, 768, 'bottom'],
    ['299 below, more above', 433, 768, 'top'],
    ['100 below, more above', 632, 768, 'top'],
    ['equal room above and below', 136, 308, 'bottom'],
  ];
  it.each(rows)('%s (top %i, viewport %i) -> %s', (_n, top, vh, want) => {
    expect(dropdownSide(rect(top), vh)).toBe(want);
  });
});

/**
 * BACKLOG-4032 slice 3 (C13): the filter variant is the compact report pill.
 * The field variant stays the default; every test above runs without `variant`.
 */
describe('Dropdown variant="filter"', () => {
  const PERIODS: DropdownOption[] = [
    { value: 'week', label: 'This week' },
    { value: 'month', label: 'This month' },
  ];

  it('C13 is a compact pill named by ariaLabel + value, with a min-w-56 panel and no blue without onClear', () => {
    render(<Dropdown variant="filter" ariaLabel="Period" options={PERIODS} value="week" onChange={() => {}} searchable={false} />);
    const pill = screen.getByRole('button', { name: 'Period This week' });
    expect(pill.className).toContain('inline-flex');
    expect(pill.className).toContain('rounded-md');
    expect(pill.className).not.toContain('w-full');
    expect(pill.className).toContain('border-gray-300');
    expect(pill.className).not.toContain('bg-primary-50');
    expect(document.querySelector('label')).toBeNull();
    fireEvent.click(pill);
    const panel = document.querySelector('[data-slot="dropdown-panel"]') as HTMLElement;
    expect(panel.className).toContain('min-w-56');
    expect(panel.className).not.toContain('w-full');
  });

  it('C13 reads blue only with a value AND onClear; with a visible label prop the label is sr-only', () => {
    const { rerender } = render(
      <Dropdown variant="filter" label="Status" options={PERIODS} value="week" onChange={() => {}} onClear={() => {}} />
    );
    const pill = () => screen.getByRole('button', { name: 'Status This week' });
    expect(pill().className).toContain('bg-primary-50');
    expect(document.querySelector('label')).toBeNull();
    rerender(<Dropdown variant="filter" label="Status" options={PERIODS} value={null} onChange={() => {}} onClear={() => {}} />);
    expect(screen.getByRole('button', { name: 'Status Status' }).className).not.toContain('bg-primary-50');
  });

  it('C13 field is still the default: full-width trigger, visible label', () => {
    render(<Dropdown label="Role" options={ROLES} value="agent" onChange={() => {}} />);
    expect(trigger().className).toContain('w-full');
    expect(screen.getByText('Role', { selector: 'label' })).toBeInTheDocument();
  });

  it('renders triggerIcon and forwards triggerRef to the trigger button', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Dropdown
        variant="filter"
        ariaLabel="Period"
        options={PERIODS}
        value="week"
        onChange={() => {}}
        triggerIcon={<svg data-testid="icon" />}
        triggerRef={ref}
      />
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Period This week' }));
  });

  it('dropdownSide takes an optional panel height; the default is unchanged', () => {
    const rect = { top: 600, bottom: 640 };
    expect(dropdownSide(rect, 1000)).toBe('bottom'); // 360 below >= 300
    expect(dropdownSide(rect, 1000, 420)).toBe('top'); // 360 below < 420, 600 above
  });
});
