import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Dropdown } from './dropdown';
import type { DropdownOption } from './types';

/**
 * BACKLOG-4032 slice 4a: Dropdown mode="multi". Control ids M1-M14 (and R3,
 * R5) match the plan (pm_comments 599e6eed) and the SR plan review
 * (pm_comments be829f45). M13 is the type contract in
 * dropdown-multi.contract.test-d.tsx; M14 is the untouched single suites.
 *
 * Fixture: Delta is disabled; Alder sits LAST but sorts first alphabetically
 * and is found by a keyword, so "first selected in option order" differs from
 * "value[0]" (R3) and a non-first row exists for M2 (R2).
 */
const ORGS: DropdownOption[] = [
  { value: 'a', label: 'Acme' },
  { value: 'b', label: 'Beacon' },
  { value: 'c', label: 'Cedar' },
  { value: 'd', label: 'Delta', disabled: true, hint: 'Archived' },
  { value: 'e', label: 'Alder', keywords: ['tree'] },
];
const ALL_ENABLED = ['a', 'b', 'c', 'e'];

interface HarnessProps {
  initial?: string[];
  withClear?: boolean;
}

function setup({ initial = ['b'], withClear = true }: HarnessProps = {}) {
  const onChange = jest.fn();
  const onClear = jest.fn();
  function Harness({ options = ORGS }: { options?: DropdownOption[] }) {
    const [value, setValue] = React.useState<string[]>(initial);
    return (
      <>
        <Dropdown
          mode="multi"
          variant="filter"
          ariaLabel="Organization"
          options={options}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onClear={
            withClear
              ? () => {
                  onClear();
                  setValue([]);
                }
              : undefined
          }
        />
        <button type="button">after</button>
      </>
    );
  }
  const utils = render(<Harness />);
  const setOptions = (options: DropdownOption[]) => utils.rerender(<Harness options={options} />);
  return { onChange, onClear, setOptions };
}

const pill = () => screen.getAllByRole('button', { name: /^Organization/ })[0];
const search = () => screen.getByRole('combobox', { name: 'Search Organization' });
const listbox = () => screen.queryByRole('listbox', { name: 'Organization' });
const option = (name: string) => screen.getByRole('option', { name });
const selectAll = () => screen.getByRole('button', { name: 'Select all' });
const clearAll = () => screen.getByRole('button', { name: 'Clear all' });
const clearX = () => screen.queryByRole('button', { name: 'Clear Organization filter' });

function openIt() {
  fireEvent.click(pill());
  return search();
}

function key(el: HTMLElement, k: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(el, { key: k, ...init });
}

/** Label text of the row aria-activedescendant points at, or null. */
function activeLabel(): string | null {
  const id = search().getAttribute('aria-activedescendant');
  if (!id) return null;
  return document.getElementById(`${id}-label`)?.textContent ?? `MISSING:${id}`;
}

function optionNames() {
  return within(listbox()!)
    .getAllByRole('option')
    .map((o) => o.textContent);
}

describe('Dropdown mode="multi"', () => {
  it('M1 a toggle commits at once and keeps the panel open (click, then Enter)', () => {
    const { onChange } = setup();
    const input = openIt();
    fireEvent.click(option('Cedar'));
    expect(listbox()).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    key(input, 'Home');
    expect(activeLabel()).toBe('Acme');
    key(input, 'Enter');
    expect(listbox()).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, ['b', 'c']);
    expect(onChange).toHaveBeenLastCalledWith(['b', 'c', 'a']);
    expect(search()).toHaveValue('');
  });

  it('M2 Enter toggles the active row ON then OFF and the active row stays on it (non-first row)', () => {
    const { onChange } = setup();
    const input = openIt();
    expect(activeLabel()).toBe('Beacon');
    key(input, 'ArrowDown');
    expect(activeLabel()).toBe('Cedar');
    key(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(['b', 'c']);
    expect(activeLabel()).toBe('Cedar');
    key(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(['b']);
    expect(activeLabel()).toBe('Cedar');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('R3 opens on the first ENABLED selected option in option order, else the first enabled row', () => {
    setup({ initial: ['e', 'c'] });
    openIt();
    expect(activeLabel()).toBe('Cedar');
  });

  it.each([
    [['d'], 'Acme'],
    [[], 'Acme'],
  ])('R3 value %p opens on %p', (initial, expected) => {
    setup({ initial });
    openIt();
    expect(activeLabel()).toBe(expected);
  });

  it('M3 the pill counts value.length, not the filtered rows; selection survives a search', () => {
    setup({ initial: ['a', 'c'] });
    const input = openIt();
    fireEvent.change(input, { target: { value: 'bea' } });
    expect(pill()).toHaveAccessibleName('Organization (2)');
    expect(optionNames()).toEqual(['Beacon']);
    expect(option('Beacon')).toHaveAttribute('aria-selected', 'false');
    fireEvent.change(input, { target: { value: '' } });
    expect(option('Acme')).toHaveAttribute('aria-selected', 'true');
    expect(option('Cedar')).toHaveAttribute('aria-selected', 'true');
  });

  it('M3/S2 a value absent from options still counts (it is the applied filter)', () => {
    setup({ initial: ['a', 'zz'] });
    expect(pill()).toHaveAccessibleName('Organization (2)');
  });

  it('M4 Select all covers every ENABLED option of the whole set (not the search view), keeps picks first', () => {
    const { onChange } = setup({ initial: ['a'] });
    const input = openIt();
    fireEvent.change(input, { target: { value: 'ced' } });
    fireEvent.click(selectAll());
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b', 'c', 'e']);
    expect(selectAll()).toBeDisabled();
    expect(search()).toHaveValue('ced');
    fireEvent.click(clearAll());
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('M5 Escape clears the query, then closes; neither Escape calls onChange or onClear', () => {
    const { onChange, onClear } = setup({ initial: ['a', 'c'] });
    const input = openIt();
    fireEvent.change(input, { target: { value: 'x' } });
    key(input, 'Escape');
    expect(search()).toHaveValue('');
    expect(listbox()).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(onClear).toHaveBeenCalledTimes(0);
    key(search(), 'Escape');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(pill());
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(onClear).toHaveBeenCalledTimes(0);
    expect(pill()).toHaveAccessibleName('Organization (2)');
  });

  it('M6 typing filters and never calls onChange', () => {
    const { onChange } = setup();
    const input = openIt();
    for (const q of ['a', 'ac', 'acm']) fireEvent.change(input, { target: { value: q } });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(search()).toHaveValue('acm');
    expect(optionNames()).toEqual(['Acme']);
  });

  it('M7 Enter on "No results" toggles nothing', () => {
    const { onChange } = setup();
    const input = openIt();
    key(input, 'ArrowDown');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledTimes(0);
  });

  it('M7b options shrink while open: Enter toggles a PRESENT row, never the removed active one', () => {
    const { onChange, setOptions } = setup();
    const input = openIt();
    key(input, 'ArrowDown');
    expect(activeLabel()).toBe('Cedar');
    setOptions(ORGS.filter((o) => o.value !== 'c'));
    expect(activeLabel()).toBe('Acme');
    key(search(), 'Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(['b', 'a']);
  });

  it('M8 listbox is aria-multiselectable; every option has aria-selected true or false; single has neither flag', () => {
    setup({ initial: ['b', 'c'] });
    openIt();
    expect(listbox()).toHaveAttribute('aria-multiselectable', 'true');
    const states = within(listbox()!)
      .getAllByRole('option')
      .map((o) => [o.textContent?.replace('Archived', ''), o.getAttribute('aria-selected')]);
    expect(states).toEqual([
      ['Acme', 'false'],
      ['Beacon', 'true'],
      ['Cedar', 'true'],
      ['Delta', 'false'],
      ['Alder', 'false'],
    ]);
  });

  it('M8 single mode listbox has no aria-multiselectable', () => {
    render(<Dropdown ariaLabel="Role" options={ORGS} value="b" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).not.toHaveAttribute('aria-multiselectable');
  });

  it('M9 one click is one toggle; the row is role=option with no nested checkbox', () => {
    const { onChange } = setup();
    openIt();
    const row = option('Cedar');
    fireEvent.click(within(row).getByText('Cedar'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(within(row).queryByRole('checkbox')).toBeNull();
    expect(row).toHaveAttribute('role', 'option');
    // The check square is decorative.
    expect(row.querySelector('[data-slot="dropdown-check"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('M10 pill name, blue state and the sibling clear X', () => {
    const { onChange, onClear } = setup();
    expect(pill()).toHaveAccessibleName('Organization (1)');
    expect(pill()).toHaveClass('bg-primary-50');
    const x = clearX()!;
    expect(x).toBeInTheDocument();
    expect(pill().contains(x)).toBe(false);
    fireEvent.click(x);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(listbox()).toBeNull();
    expect(pill()).toHaveAccessibleName('Organization');
    expect(pill()).not.toHaveClass('bg-primary-50');
    expect(clearX()).toBeNull();
  });

  it('M10 all five selected reads (5)', () => {
    setup({ initial: ['a', 'b', 'c', 'd', 'e'] });
    expect(pill()).toHaveAccessibleName('Organization (5)');
  });

  it('M10 without onClear: no X, not blue', () => {
    setup({ withClear: false });
    expect(pill()).toHaveAccessibleName('Organization (1)');
    expect(pill()).not.toHaveClass('bg-primary-50');
    expect(clearX()).toBeNull();
  });

  describe('M11 Tab routing by which bulk buttons are enabled (R4)', () => {
    it('value []: Tab -> Select all (Clear all disabled); Tab again closes', () => {
      setup({ initial: [] });
      const input = openIt();
      key(input, 'Tab');
      expect(document.activeElement).toBe(selectAll());
      expect(listbox()).toBeInTheDocument();
      key(selectAll(), 'Tab');
      expect(listbox()).toBeNull();
    });

    it("value ['b']: Tab -> Select all; Tab on Select all stays open (native); Tab on Clear all closes", () => {
      setup();
      const input = openIt();
      key(input, 'Tab');
      expect(document.activeElement).toBe(selectAll());
      key(selectAll(), 'Tab');
      expect(listbox()).toBeInTheDocument();
      clearAll().focus();
      key(clearAll(), 'Tab');
      expect(listbox()).toBeNull();
    });

    it('all enabled selected: Tab -> Clear all (Select all disabled); Tab again closes', () => {
      setup({ initial: ALL_ENABLED });
      const input = openIt();
      key(input, 'Tab');
      expect(document.activeElement).toBe(clearAll());
      key(clearAll(), 'Tab');
      expect(listbox()).toBeNull();
    });

    it('Shift+Tab from the search closes; a mouse press on a bulk button keeps focus in the search', () => {
      setup();
      const input = openIt();
      expect(fireEvent.mouseDown(selectAll())).toBe(false);
      expect(fireEvent.mouseDown(clearAll())).toBe(false);
      key(input, 'Tab', { shiftKey: true });
      expect(listbox()).toBeNull();
    });
  });

  it.each<[string[], boolean, boolean]>([
    [[], false, true],
    [['a'], false, false],
    [['d'], false, false],
    [['a', 'b', 'c'], false, false],
    [ALL_ENABLED, true, false],
    [['a', 'b', 'c', 'd', 'e'], true, false],
  ])('M12 value %p: Select all disabled=%p, Clear all disabled=%p', (initial, saDisabled, caDisabled) => {
    setup({ initial });
    openIt();
    expect(selectAll().hasAttribute('disabled')).toBe(saDisabled);
    expect(clearAll().hasAttribute('disabled')).toBe(caDisabled);
  });

  it('M12 the disabled option cannot be toggled and is skipped by the arrows', () => {
    const { onChange } = setup();
    const input = openIt();
    fireEvent.click(option('Delta'));
    expect(onChange).toHaveBeenCalledTimes(0);
    key(input, 'ArrowDown');
    expect(activeLabel()).toBe('Cedar');
    key(input, 'ArrowDown');
    expect(activeLabel()).toBe('Alder');
  });

  it('R5 a keyboard bulk action returns focus to the search', () => {
    const { onChange } = setup();
    const input = openIt();
    key(input, 'Tab');
    expect(document.activeElement).toBe(selectAll());
    // Enter / Space on a native button dispatch a click.
    fireEvent.click(selectAll());
    expect(onChange).toHaveBeenLastCalledWith(['b', 'a', 'c', 'e']);
    expect(document.activeElement).toBe(search());
    key(search(), 'Tab');
    expect(document.activeElement).toBe(clearAll());
    fireEvent.click(clearAll());
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(search());
  });
});
