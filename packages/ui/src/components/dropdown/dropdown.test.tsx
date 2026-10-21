import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Dropdown } from './dropdown';
import { DropdownOptions } from './dropdown-options';
import type { DropdownOption, DropdownProps } from './types';
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

type Overrides = Partial<Omit<DropdownProps, 'label' | 'ariaLabel'>>;

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
