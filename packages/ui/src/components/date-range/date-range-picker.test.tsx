import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateRangePicker, type DateRangeValue } from './date-range-picker';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

/**
 * BACKLOG-4032 slice 3. Control ids (C1, C4, C5, C6, C8) match the plan
 * (/Users/daniel/Developer/4032-s3-plan.md) and SR review R2-R7.
 *
 * This file runs in BOTH jest projects: `kit` (Pacific/Auckland, UTC+13) and
 * `kit-tz-west` (Pacific/Honolulu, UTC-10). See jest.config.js.
 */

const OCT: DateRangeValue = { from: '2026-10-01', to: '2026-10-20' };

function Harness({ initial = OCT, spy }: { initial?: DateRangeValue; spy?: (r: { from: string; to: string }) => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <div>
      <DateRangePicker
        value={value}
        onChange={(r) => {
          spy?.(r);
          setValue(r);
        }}
      />
      <p>elsewhere</p>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: /^Date range/ });
const dialog = () => screen.queryByRole('dialog', { name: 'Date range' });
const cell = (name: string) => screen.getByRole('gridcell', { name });
const apply = () => screen.getByRole('button', { name: 'Apply' });
const active = () => document.activeElement as HTMLElement;
const key = (k: string, opts: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(active(), { key: k, ...opts });

function openAt(initial: DateRangeValue = OCT, spy?: (r: { from: string; to: string }) => void) {
  render(<Harness initial={initial} spy={spy} />);
  fireEvent.click(trigger());
}

describe('DateRangePicker time zone (C5)', () => {
  it('runs under the zone its jest project names (vacuity guard: offset sign per project)', () => {
    const tz = (globalThis as { __KIT_TZ__?: string }).__KIT_TZ__;
    const offset = new Date(2026, 9, 1).getTimezoneOffset();
    expect(tz === 'Pacific/Auckland' || tz === 'Pacific/Honolulu').toBe(true);
    if (tz === 'Pacific/Auckland') expect(offset).toBeLessThan(0);
    else expect(offset).toBeGreaterThan(0);
  });

  it('C5(a) the October grid holds days 1..31, and the cell showing "1" emits 2026-10-01', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    const october = screen.getByRole('grid', { name: 'October 2026' });
    const days = Array.from(october.querySelectorAll('td'))
      .map((td) => td.textContent)
      .filter((t) => t !== '');
    expect(days).toEqual(Array.from({ length: 31 }, (_, i) => String(i + 1)));
    const one = Array.from(october.querySelectorAll('td')).find((td) => td.textContent === '1')!;
    expect(one).toHaveAccessibleName('Thursday, October 1, 2026');
    fireEvent.click(one);
    fireEvent.click(one);
    fireEvent.click(apply());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-01' });
  });

  it('C5(b) value.from 2026-10-01 marks the Oct 1 cell selected, not Sep 30, and opens on October', () => {
    openAt();
    expect(cell('Thursday, October 1, 2026')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('gridcell', { name: 'Wednesday, September 30, 2026' })).toBeNull();
    expect(screen.getAllByRole('grid')[0]).toHaveAccessibleName('October 2026');
    expect(cell('Tuesday, October 20, 2026')).toHaveAttribute('aria-selected', 'true');
    expect(cell('Wednesday, October 21, 2026')).toHaveAttribute('aria-selected', 'false');
    expect(active()).toBe(cell('Thursday, October 1, 2026'));
  });
});

describe('DateRangePicker commit model', () => {
  it('C1 day clicks change only the draft; Apply calls onChange exactly once, then closes', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    fireEvent.click(cell('Monday, October 5, 2026'));
    fireEvent.click(cell('Thursday, October 15, 2026'));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText('Oct 5 – Oct 15, 2026', { selector: '[data-slot="date-range-draft"]' })).toBeInTheDocument();
    fireEvent.click(apply());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-10-05', to: '2026-10-15' });
    expect(dialog()).toBeNull();
    expect(trigger()).toHaveAccessibleName('Date range Oct 5 – Oct 15, 2026');
    expect(active()).toBe(trigger());
  });

  it('Apply is disabled until both ends are set', () => {
    openAt();
    fireEvent.click(cell('Monday, October 5, 2026'));
    expect(apply()).toBeDisabled();
    fireEvent.click(cell('Thursday, October 15, 2026'));
    expect(apply()).toBeEnabled();
  });

  it('C4 a second pick before the start becomes the new start (no reversed range); same day twice = one day', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    fireEvent.click(cell('Tuesday, October 20, 2026'));
    fireEvent.click(cell('Thursday, October 1, 2026'));
    expect(apply()).toBeDisabled();
    expect(cell('Thursday, October 1, 2026')).toHaveAttribute('aria-selected', 'true');
    expect(cell('Tuesday, October 20, 2026')).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(cell('Thursday, October 1, 2026'));
    fireEvent.click(apply());
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-01' });
    expect(trigger()).toHaveAccessibleName('Date range Oct 1, 2026');
  });

  it('Cancel, Escape and an outside press discard the draft and fire nothing', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    fireEvent.click(cell('Monday, October 5, 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialog()).toBeNull();
    expect(active()).toBe(trigger());

    fireEvent.click(trigger());
    expect(cell('Monday, October 5, 2026')).toHaveAttribute('aria-selected', 'true'); // inside Oct 1-20
    expect(cell('Wednesday, October 21, 2026')).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(cell('Monday, October 26, 2026'));
    key('Escape');
    expect(dialog()).toBeNull();
    expect(active()).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.click(cell('Monday, October 26, 2026'));
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(dialog()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(trigger()).toHaveAccessibleName('Date range Oct 1 – Oct 20, 2026');
  });

  it('shows "Pick dates" with no committed range, and for an incomplete or reversed one', () => {
    const { rerender } = render(<DateRangePicker value={{}} onChange={() => {}} />);
    expect(trigger()).toHaveAccessibleName('Date range Pick dates');
    rerender(<DateRangePicker value={{ from: '2026-10-01' }} onChange={() => {}} />);
    expect(trigger()).toHaveAccessibleName('Date range Pick dates');
    rerender(<DateRangePicker value={{ from: '2026-10-20', to: '2026-10-01' }} onChange={() => {}} />);
    expect(trigger()).toHaveAccessibleName('Date range Pick dates');
  });
});

describe('DateRangePicker grid a11y (R3)', () => {
  it('Monday-first header M T W T F S S with full names in abbr', () => {
    openAt();
    const grid = screen.getAllByRole('grid')[0];
    const headers = Array.from(grid.querySelectorAll('th'));
    expect(headers.map((h) => h.textContent)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(headers.map((h) => h.getAttribute('abbr'))).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    // October 2026 starts on a Thursday: three blank cells first.
    const firstRow = grid.querySelectorAll('tbody tr')[0];
    expect(Array.from(firstRow.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['', '', '', '1', '2', '3', '4']);
  });

  it('the focusable day is the gridcell; no role=button carries aria-selected; one roving tab stop', () => {
    openAt();
    expect(document.querySelectorAll('[role="button"][aria-selected], button[aria-selected]')).toHaveLength(0);
    const stops = Array.from(document.querySelectorAll('[role="gridcell"][tabindex="0"]'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName('Thursday, October 1, 2026');
    expect(screen.getAllByRole('grid')).toHaveLength(2);
    for (const g of screen.getAllByRole('grid')) {
      const heading = document.getElementById(g.getAttribute('aria-labelledby')!)!;
      expect(heading).toHaveAttribute('aria-live', 'polite');
    }
    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeInTheDocument();
  });

  it('marks today with aria-current="date"', () => {
    render(<DateRangePicker value={{}} onChange={() => {}} />);
    fireEvent.click(trigger());
    const now = new Date();
    const today = document.querySelector(
      `[data-date="${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}"]`
    );
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(active()).toBe(today);
  });
});

describe('DateRangePicker keyboard (C8, R5)', () => {
  it('arrows move a day / a week; Enter and Space pick', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    key('ArrowRight');
    expect(active()).toHaveAccessibleName('Friday, October 2, 2026');
    key('ArrowDown');
    expect(active()).toHaveAccessibleName('Friday, October 9, 2026');
    key('ArrowLeft');
    key('ArrowUp');
    expect(active()).toHaveAccessibleName('Thursday, October 1, 2026');
    key('Enter');
    key('ArrowDown');
    key(' ');
    fireEvent.click(apply());
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-08' });
  });

  it('Home / End go to Monday / Sunday of the week (shifting the months back when needed)', () => {
    openAt();
    key('Home');
    expect(active()).toHaveAccessibleName('Monday, September 28, 2026');
    expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
    key('End');
    expect(active()).toHaveAccessibleName('Sunday, October 4, 2026');
  });

  it('ArrowRight off the last visible day shifts the months, keeps the dialog open and focus on the new day', () => {
    openAt({ from: '2026-11-30', to: '2026-11-30' });
    // View is Nov / Dec; walk to Dec 31.
    key('PageDown');
    expect(active()).toHaveAccessibleName('Wednesday, December 30, 2026');
    key('ArrowRight');
    key('ArrowRight');
    expect(active()).toHaveAccessibleName('Friday, January 1, 2027');
    expect(dialog()).not.toBeNull();
    expect(screen.getByRole('grid', { name: 'January 2027' })).toBeInTheDocument();
  });

  it('PageDown twice from the first month keeps the dialog open and focus on the expected day', () => {
    openAt();
    key('PageDown');
    expect(active()).toHaveAccessibleName('Sunday, November 1, 2026');
    key('PageDown');
    expect(dialog()).not.toBeNull();
    expect(active()).toHaveAccessibleName('Tuesday, December 1, 2026');
  });

  it('ArrowDown across a month end: Feb 25 2028 -> Mar 3 2028', () => {
    openAt({ from: '2028-02-25', to: '2028-02-25' });
    key('ArrowDown');
    expect(active()).toHaveAccessibleName('Friday, March 3, 2028');
  });

  it('PageDown clamps Jan 31 to the end of February (leap and non-leap)', () => {
    openAt({ from: '2028-01-31', to: '2028-01-31' });
    key('PageDown');
    expect(active()).toHaveAccessibleName('Tuesday, February 29, 2028');
  });

  it('PageDown clamps Jan 31 2027 to Feb 28 2027; PageUp goes back a month', () => {
    openAt({ from: '2027-01-31', to: '2027-01-31' });
    key('PageDown');
    expect(active()).toHaveAccessibleName('Sunday, February 28, 2027');
    key('PageUp');
    expect(active()).toHaveAccessibleName('Thursday, January 28, 2027');
  });

  it('Shift+PageDown / Shift+PageUp move a year, clamping Feb 29', () => {
    openAt({ from: '2028-02-29', to: '2028-02-29' });
    key('PageDown', { shiftKey: true });
    expect(active()).toHaveAccessibleName('Wednesday, February 28, 2029');
    expect(dialog()).not.toBeNull();
    key('PageUp', { shiftKey: true });
    expect(active()).toHaveAccessibleName('Monday, February 28, 2028');
  });

  it('Tab from Apply (or Cancel while Apply is disabled) closes; Shift+Tab from Previous month closes; Tab from a day does not', () => {
    const spy = jest.fn();
    openAt(OCT, spy);
    key('Tab');
    expect(dialog()).not.toBeNull();
    apply().focus();
    key('Tab');
    expect(dialog()).toBeNull();
    expect(active()).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.click(cell('Monday, October 5, 2026')); // Apply now disabled
    screen.getByRole('button', { name: 'Cancel' }).focus();
    key('Tab');
    expect(dialog()).toBeNull();

    fireEvent.click(trigger());
    screen.getByRole('button', { name: 'Previous month' }).focus();
    key('Tab', { shiftKey: true });
    expect(dialog()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a blur with no related target (a month shift) does not close the panel', () => {
    openAt();
    fireEvent.blur(active(), { relatedTarget: null });
    fireEvent.focusOut(active(), { relatedTarget: null });
    expect(dialog()).not.toBeNull();
  });
});

describe('DateRangePicker controlled open + returnFocusRef', () => {
  it('opens from the open prop, reports close through onOpenChange, returns focus to returnFocusRef', () => {
    function Controlled() {
      const [open, setOpen] = React.useState(false);
      const other = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={other} type="button" onClick={() => setOpen(true)}>
            other
          </button>
          <DateRangePicker value={OCT} onChange={() => {}} open={open} onOpenChange={setOpen} returnFocusRef={other} />
        </>
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'other' }));
    expect(dialog()).not.toBeNull();
    expect(active()).toHaveAccessibleName('Thursday, October 1, 2026');
    key('Escape');
    expect(dialog()).toBeNull();
    expect(active()).toBe(screen.getByRole('button', { name: 'other' }));
  });
});

describe('DateRangePicker mounted open', () => {
  it('a picker mounted with open={true} starts from the committed range and focuses its start day', () => {
    render(<DateRangePicker value={OCT} onChange={() => {}} open onOpenChange={() => {}} />);
    expect(dialog()).not.toBeNull();
    expect(active()).toHaveAccessibleName('Thursday, October 1, 2026');
    expect(cell('Tuesday, October 20, 2026')).toHaveAttribute('aria-selected', 'true');
    expect(apply()).toBeEnabled();
  });
});

describe('DateRangePicker inside a kit Dialog (C6)', () => {
  it('one Escape closes the picker, not the dialog; the next Escape closes the dialog', () => {
    function InDialog() {
      const [dlg, setDlg] = React.useState(true);
      return (
        <>
          <span data-testid="dlg">{dlg ? 'dlg-open' : 'dlg-closed'}</span>
          <Dialog open={dlg} onOpenChange={setDlg}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Edit</DialogTitle>
              <DateRangePicker value={OCT} onChange={() => {}} />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<InDialog />);
    fireEvent.click(trigger());
    expect(dialog()).not.toBeNull();
    key('Escape');
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-open');
    key('Escape');
    expect(screen.getByTestId('dlg')).toHaveTextContent('dlg-closed');
  });
});
