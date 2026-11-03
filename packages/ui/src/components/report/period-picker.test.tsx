import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PeriodPicker } from './period-picker';

/**
 * BACKLOG-4032 slice 3. Control ids (C1-C3, C10, C11, C14) match the plan and
 * SR review (R4, R6). Runs in both jest projects (see jest.config.js).
 *
 * Fixture rule (SR check 1): a preset period arrives with from / to UNDEFINED.
 * That is what the real page passes (period.ts: `customFrom: null` for every
 * preset). The old harness held dates locally for a preset, a state the page
 * never produces, and that hid the snap-back.
 */
type P = 'week' | 'month' | 'custom';
const OPTIONS = [
  { value: 'week' as const, label: 'This week' },
  { value: 'month' as const, label: 'This month' },
  { value: 'custom' as const, label: 'Custom range' },
];

interface State {
  value: P;
  from?: string;
  to?: string;
}

/** A parent that, like the report page, adopts what onChange reports (presets drop the dates). */
function Page({ spy, initial = { value: 'week' } }: { spy: jest.Mock; initial?: State }) {
  const [state, setState] = React.useState<State>(initial);
  return (
    <div>
      <PeriodPicker<P>
        options={OPTIONS}
        value={state.value}
        customKey="custom"
        from={state.from}
        to={state.to}
        onChange={(value, from, to) => {
          spy(value, from, to);
          setState(value === 'custom' ? { value, from, to } : { value });
        }}
      />
      <p>elsewhere</p>
    </div>
  );
}

/** A parent whose props do NOT catch up after onChange (router.push still in flight). */
function Stale({ spy, initial = { value: 'week' } }: { spy: jest.Mock; initial?: State }) {
  return (
    <PeriodPicker<P>
      options={OPTIONS}
      value={initial.value}
      customKey="custom"
      from={initial.from}
      to={initial.to}
      onChange={spy}
    />
  );
}

const periodPill = () => screen.getByRole('button', { name: /^Period/ });
const rangePill = () => screen.queryByRole('button', { name: /^Custom range/ });
const calendar = () => screen.queryByRole('dialog', { name: 'Custom range' });
const cell = (name: string) => screen.getByRole('gridcell', { name });
const active = () => document.activeElement as HTMLElement;

function choose(label: string) {
  fireEvent.click(periodPill());
  fireEvent.click(screen.getByRole('option', { name: label }));
}

function pickOct1To20() {
  fireEvent.click(cell('Thursday, October 1, 2026'));
  fireEvent.click(cell('Tuesday, October 20, 2026'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
}

const DATE_ONLY = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'nextTick',
  'hrtime',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
] as const;

beforeEach(() => {
  // Only Date is faked: "today" is local Oct 15 2026 in either project's zone.
  jest.useFakeTimers({ doNotFake: [...DATE_ONLY], now: new Date(2026, 9, 15, 12) });
});
afterEach(() => jest.useRealTimers());

describe('PeriodPicker', () => {
  it('is a Period pill listing the options; no range pill on a preset', () => {
    render(<Page spy={jest.fn()} />);
    expect(periodPill()).toHaveAccessibleName('Period This week');
    expect(rangePill()).toBeNull();
    fireEvent.click(periodPill());
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['This week', 'This month', 'Custom range']);
  });

  it('C11 a preset pick reports once, passing from / to through', () => {
    const spy = jest.fn();
    render(<Stale spy={spy} initial={{ value: 'custom', from: '2026-09-01', to: '2026-09-30' }} />);
    choose('This month');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('month', '2026-09-01', '2026-09-30');
  });

  it('C2 picking "Custom range" from a preset fires NOTHING and opens the calendar with focus on a day (R6)', () => {
    const spy = jest.fn();
    render(<Page spy={spy} />);
    choose('Custom range');
    expect(spy).not.toHaveBeenCalled();
    expect(calendar()).not.toBeNull();
    expect(periodPill()).toHaveAccessibleName('Period Custom range');
    expect(active()).toHaveAttribute('role', 'gridcell');
    expect(active()).toHaveAccessibleName('Thursday, October 15, 2026');
  });

  it('C1 day clicks fire nothing; Apply fires exactly once with the range', () => {
    const spy = jest.fn();
    render(<Page spy={spy} />);
    choose('Custom range');
    fireEvent.click(cell('Thursday, October 1, 2026'));
    fireEvent.click(cell('Tuesday, October 20, 2026'));
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('custom', '2026-10-01', '2026-10-20');
    expect(calendar()).toBeNull();
    expect(rangePill()).toHaveAccessibleName('Custom range Oct 1 – Oct 20, 2026');
  });

  it('C3 Cancel on a pending Custom: nothing fires, the pill is back on the old preset, focus on the Period pill', () => {
    const spy = jest.fn();
    render(<Page spy={spy} initial={{ value: 'month' }} />);
    choose('Custom range');
    fireEvent.click(cell('Thursday, October 1, 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(spy).not.toHaveBeenCalled();
    expect(periodPill()).toHaveAccessibleName('Period This month');
    expect(rangePill()).toBeNull();
    expect(active()).toBe(periodPill());
  });

  it('C3 Escape and an outside press on a pending Custom do the same', () => {
    const spy = jest.fn();
    render(<Page spy={spy} />);
    choose('Custom range');
    fireEvent.keyDown(active(), { key: 'Escape' });
    expect(periodPill()).toHaveAccessibleName('Period This week');
    expect(rangePill()).toBeNull();
    expect(active()).toBe(periodPill());

    choose('Custom range');
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(periodPill()).toHaveAccessibleName('Period This week');
    expect(rangePill()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('C14 after Apply, the pills hold the applied range until the props catch up (R4)', () => {
    const spy = jest.fn();
    const { rerender } = render(<Stale spy={spy} />);
    choose('Custom range');
    pickOct1To20();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(periodPill()).toHaveAccessibleName('Period Custom range');
    expect(rangePill()).toHaveAccessibleName('Custom range Oct 1 – Oct 20, 2026');
    // The page lands with the range: still shown, now from props.
    rerender(<Stale spy={spy} initial={{ value: 'custom', from: '2026-10-01', to: '2026-10-20' }} />);
    expect(rangePill()).toHaveAccessibleName('Custom range Oct 1 – Oct 20, 2026');
    // The parent moves to a preset: the held range is gone.
    rerender(<Stale spy={spy} initial={{ value: 'week' }} />);
    expect(periodPill()).toHaveAccessibleName('Period This week');
    expect(rangePill()).toBeNull();
  });

  it('picking Custom while already custom opens the calendar on the current range and fires nothing', () => {
    const spy = jest.fn();
    render(<Page spy={spy} initial={{ value: 'custom', from: '2026-10-01', to: '2026-10-20' }} />);
    expect(rangePill()).toHaveAccessibleName('Custom range Oct 1 – Oct 20, 2026');
    choose('Custom range');
    expect(spy).not.toHaveBeenCalled();
    expect(calendar()).not.toBeNull();
    expect(active()).toHaveAccessibleName('Thursday, October 1, 2026');
    fireEvent.keyDown(active(), { key: 'Escape' });
    expect(periodPill()).toHaveAccessibleName('Period Custom range');
    expect(active()).toBe(rangePill());
  });

  it('the range pill reopens the calendar; a new Apply while custom reports once', () => {
    const spy = jest.fn();
    render(<Page spy={spy} initial={{ value: 'custom', from: '2026-10-01', to: '2026-10-20' }} />);
    fireEvent.click(rangePill()!);
    fireEvent.click(cell('Monday, October 5, 2026'));
    fireEvent.click(cell('Monday, October 12, 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('custom', '2026-10-05', '2026-10-12');
    expect(rangePill()).toHaveAccessibleName('Custom range Oct 5 – Oct 12, 2026');
  });

  it('C10 shows a new from / to when the parent changes them while custom stays selected; cleared -> Pick dates', () => {
    const props = { options: OPTIONS, value: 'custom' as const, customKey: 'custom' as const, onChange: () => {} };
    const { rerender } = render(<PeriodPicker<P> {...props} from="2026-09-01" to="2026-09-30" />);
    expect(rangePill()).toHaveAccessibleName('Custom range Sep 1 – Sep 30, 2026');
    rerender(<PeriodPicker<P> {...props} from="2026-07-04" to="2026-08-20" />);
    expect(rangePill()).toHaveAccessibleName('Custom range Jul 4 – Aug 20, 2026');
    rerender(<PeriodPicker<P> {...props} />);
    expect(rangePill()).toHaveAccessibleName('Custom range Pick dates');
  });

  it('never shows a range pill without a customKey, even with value "custom"', () => {
    render(<PeriodPicker options={OPTIONS} value="custom" onChange={() => {}} />);
    expect(rangePill()).toBeNull();
    expect(screen.queryByRole('button', { name: /Pick dates/ })).toBeNull();
  });

  it('uses ariaLabel for the Period pill', () => {
    render(<PeriodPicker options={OPTIONS} value="week" onChange={() => {}} ariaLabel="Report period" />);
    expect(screen.getByRole('button', { name: 'Report period This week' })).toBeInTheDocument();
  });
});
